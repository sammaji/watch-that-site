// Package broker wraps the RabbitMQ AMQP 1.0 client behind small interfaces:
// Publisher for outbound messages and a Consume helper for inbound ones. It owns
// connection lifecycle, publish retry, and reconnect so the rest of the service
// depends only on these interfaces.
package broker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/Azure/go-amqp"
	rmq "github.com/rabbitmq/rabbitmq-amqp-go-client/pkg/rabbitmqamqp"
)

const (
	maxPublishRetries  = 3
	publishBaseBackoff = 100 * time.Millisecond

	consumeBaseBackoff     = time.Second
	consumeMaxBackoff      = 30 * time.Second
	consumeHealthyDuration = time.Minute
)

// Address identifies the exchange + routing key a publisher targets.
type Address struct {
	Exchange   string
	RoutingKey string
}

// Publisher marshals a payload to JSON and publishes it by routing key.
type Publisher interface {
	Publish(ctx context.Context, routingKey string, payload any) error
}

// Delivery is one received message. The handler must Accept, Requeue, or Discard
// exactly once.
type Delivery interface {
	Body() []byte
	Accept(ctx context.Context) error
	Requeue(ctx context.Context) error
	Discard(ctx context.Context, reason string) error
}

// Client owns a RabbitMQ connection and one publisher per configured address.
// It publishes with bounded retry and, on exhaustion, reconnects - recreating
// every publisher - before a final attempt. A generation counter prevents
// concurrent failures from triggering redundant reconnects.
type Client struct {
	env       *rmq.Environment
	addresses []Address
	logger    *slog.Logger

	mu         sync.RWMutex
	conn       *rmq.AmqpConnection
	publishers map[string]*rmq.Publisher
	generation uint64
}

var _ Publisher = (*Client)(nil)

// NewClient connects and builds a publisher for every address.
func NewClient(ctx context.Context, url string, addresses []Address, logger *slog.Logger) (*Client, error) {
	env := rmq.NewEnvironment(url, nil)

	conn, err := env.NewConnection(ctx)
	if err != nil {
		return nil, fmt.Errorf("new connection: %w", err)
	}

	publishers, err := buildPublishers(ctx, conn, addresses)
	if err != nil {
		_ = conn.Close(ctx)
		return nil, err
	}

	logger.Info("connected to RabbitMQ, publishers ready")
	return &Client{
		env:        env,
		addresses:  addresses,
		logger:     logger,
		conn:       conn,
		publishers: publishers,
	}, nil
}

func buildPublishers(ctx context.Context, conn *rmq.AmqpConnection, addresses []Address) (map[string]*rmq.Publisher, error) {
	publishers := make(map[string]*rmq.Publisher, len(addresses))
	for _, a := range addresses {
		pub, err := conn.NewPublisher(ctx, &rmq.ExchangeAddress{Exchange: a.Exchange, Key: a.RoutingKey}, nil)
		if err != nil {
			for _, p := range publishers {
				_ = p.Close(ctx)
			}
			return nil, fmt.Errorf("new publisher %s: %w", a.RoutingKey, err)
		}
		publishers[a.RoutingKey] = pub
	}
	return publishers, nil
}

func (c *Client) Publish(ctx context.Context, routingKey string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	c.mu.RLock()
	gen := c.generation
	c.mu.RUnlock()

	log := c.logger.With("routing_key", routingKey)

	var lastErr error
	for attempt := range maxPublishRetries {
		if attempt > 0 {
			backoff := publishBaseBackoff * time.Duration(1<<(attempt-1))
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
		}

		if err := c.tryPublish(ctx, routingKey, body); err == nil {
			return nil
		} else {
			lastErr = err
			log.Warn("publish attempt failed", "attempt", attempt+1, "err", err)
		}
	}

	log.Error("publish retries exhausted, attempting reconnect", "err", lastErr)
	if err := c.reconnect(ctx, gen); err != nil {
		log.Error("reconnect failed", "err", err)
		return fmt.Errorf("publish failed after reconnect attempt: %w", lastErr)
	}

	if err := c.tryPublish(ctx, routingKey, body); err != nil {
		log.Error("publish failed after reconnect", "err", err)
		return err
	}
	return nil
}

func (c *Client) tryPublish(ctx context.Context, routingKey string, body []byte) error {
	c.mu.RLock()
	pub := c.publishers[routingKey]
	c.mu.RUnlock()

	if pub == nil {
		return fmt.Errorf("no publisher for routing key %q", routingKey)
	}

	result, err := pub.Publish(ctx, rmq.NewMessage(body))
	if err != nil {
		return fmt.Errorf("publish %s: %w", routingKey, err)
	}
	if _, ok := result.Outcome.(*rmq.StateAccepted); !ok {
		return fmt.Errorf("message %s not accepted: %v", routingKey, result.Outcome)
	}
	return nil
}

func (c *Client) reconnect(ctx context.Context, failedGen uint64) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Another goroutine already reconnected past the failed generation.
	if c.generation != failedGen {
		return nil
	}

	if c.conn != nil {
		_ = c.conn.Close(ctx)
	}

	conn, err := c.env.NewConnection(ctx)
	if err != nil {
		return fmt.Errorf("reconnect: new connection: %w", err)
	}

	publishers, err := buildPublishers(ctx, conn, c.addresses)
	if err != nil {
		_ = conn.Close(ctx)
		return fmt.Errorf("reconnect: %w", err)
	}

	c.conn = conn
	c.publishers = publishers
	c.generation++
	c.logger.Info("reconnected to RabbitMQ", "generation", c.generation)
	return nil
}

// Close tears down the connection and all publishers.
func (c *Client) Close(ctx context.Context) error {
	return c.env.CloseConnections(ctx)
}

// rmqDelivery adapts an AMQP delivery context to the Delivery interface.
type rmqDelivery struct {
	dc rmq.IDeliveryContext
}

func (d rmqDelivery) Body() []byte                      { return d.dc.Message().GetData() }
func (d rmqDelivery) Accept(ctx context.Context) error  { return d.dc.Accept(ctx) }
func (d rmqDelivery) Requeue(ctx context.Context) error { return d.dc.Requeue(ctx) }
func (d rmqDelivery) Discard(ctx context.Context, reason string) error {
	return d.dc.Discard(ctx, &amqp.Error{Condition: "rejected", Description: reason})
}

// Consume opens a dedicated connection, consumes queue, and dispatches each
// delivery to handler on a bounded worker pool. It reconnects with exponential
// backoff until ctx is cancelled. The dedicated connection means a publisher-side
// reconnect can never tear down consumption.
func Consume(ctx context.Context, url, queue string, workers int, logger *slog.Logger, handler func(context.Context, Delivery)) error {
	backoff := consumeBaseBackoff
	for {
		start := time.Now()
		err := consumeOnce(ctx, url, queue, workers, logger, handler)
		if ctx.Err() != nil {
			return nil
		}

		if time.Since(start) > consumeHealthyDuration {
			backoff = consumeBaseBackoff
		}

		logger.Warn("consumer failed, retrying", "queue", queue, "err", err, "backoff", backoff)

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}

		if next := backoff * 2; next < consumeMaxBackoff {
			backoff = next
		} else {
			backoff = consumeMaxBackoff
		}
	}
}

func consumeOnce(ctx context.Context, url, queue string, workers int, logger *slog.Logger, handler func(context.Context, Delivery)) error {
	env := rmq.NewEnvironment(url, nil)
	defer func() { _ = env.CloseConnections(context.Background()) }()

	conn, err := env.NewConnection(ctx)
	if err != nil {
		return fmt.Errorf("open connection: %w", err)
	}
	defer func() { _ = conn.Close(context.Background()) }()

	consumer, err := conn.NewConsumer(ctx, queue, &rmq.ConsumerOptions{InitialCredits: int32(workers)})
	if err != nil {
		return fmt.Errorf("open consumer for %s: %w", queue, err)
	}
	defer func() { _ = consumer.Close(context.Background()) }()

	logger.Info("consumer started", "queue", queue, "workers", workers)

	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup

	for {
		dc, err := consumer.Receive(ctx)
		if err != nil {
			wg.Wait()
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("receive: %w", err)
		}

		wg.Add(1)
		sem <- struct{}{}
		go func(dc rmq.IDeliveryContext) {
			defer wg.Done()
			defer func() { <-sem }()
			handler(ctx, rmqDelivery{dc: dc})
		}(dc)
	}
}
