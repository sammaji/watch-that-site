package consumer

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"

	"github.com/Azure/go-amqp"
	rmq "github.com/rabbitmq/rabbitmq-amqp-go-client/pkg/rabbitmqamqp"

	"github.com/sammaji/watchthatsite/services/notifications/internal/handler"
)

// QueueConfig describes one queue and its worker pool size.
type QueueConfig struct {
	Name        handler.NoticationChannel
	WorkerCount int
}

// Consumer listens to a single RabbitMQ queue and dispatches deliveries to a
// Handler using a fixed-size goroutine pool.
type Consumer struct {
	consumer *rmq.Consumer
	queue    QueueConfig
	handler  handler.Handler
	log      *slog.Logger
}

// New creates a new Consumer.
func New(ctx context.Context, conn *rmq.AmqpConnection, q QueueConfig, h handler.Handler, log *slog.Logger) (*Consumer, error) {
	// One consumer per queue; initial link credits = WorkerCount so we don't
	// buffer more than we can process concurrently (back-pressure into RabbitMQ).
	c, err := conn.NewConsumer(ctx, string(q.Name), &rmq.ConsumerOptions{
		InitialCredits: int32(q.WorkerCount),
	})
	if err != nil {
		return nil, fmt.Errorf("open consumer for %s: %w", q.Name, err)
	}
	return &Consumer{consumer: c, queue: q, handler: h, log: log}, nil
}

// Run starts consuming and blocks until ctx is cancelled.
func (c *Consumer) Run(ctx context.Context) error {
	sem := make(chan struct{}, c.queue.WorkerCount)
	var wg sync.WaitGroup

	c.log.Info("consumer started", "queue", c.queue.Name, "workers", c.queue.WorkerCount)

	for {
		dc, err := c.consumer.Receive(ctx)
		if err != nil {
			// Wait for in-flight workers before returning.
			wg.Wait()

			// ctx cancelled — clean exit.
			if ctx.Err() != nil {
				return nil
			}

			// Receiver link died (RabbitMQ disconnect).
			return fmt.Errorf("receive on queue %s: %w", c.queue.Name, err)
		}

		wg.Add(1)
		sem <- struct{}{} // acquire slot

		go func(dc rmq.IDeliveryContext) {
			defer wg.Done()
			defer func() { <-sem }() // release slot

			c.process(ctx, dc)
		}(dc)
	}
}

// Close tears down the receiver link.
func (c *Consumer) Close(ctx context.Context) error {
	return c.consumer.Close(ctx)
}

func (c *Consumer) process(ctx context.Context, dc rmq.IDeliveryContext) {
	log := c.log.With("queue", c.queue.Name)

	msg := dc.Message()

	var n handler.Notification
	if err := json.Unmarshal(msg.GetData(), &n); err != nil {
		// malformed json, no retry
		log.Error("unmarshal failed, sending to dlq", "err", err)
		// rejected will send to dlq
		_ = dc.Discard(ctx, &amqp.Error{Condition: "rejected", Description: "invalid payload: " + err.Error()})
		return
	}

	log = log.With("message_id", messageID(msg), "channel", n.Channel)
	log.Debug("processing notification")

	err := c.handler.Validate(&n)
	if err != nil {
		c.reject(ctx, dc, log, "validation failed", err)
		return
	}

	err = c.handler.Send(ctx, &n)
	if err == nil {
		log.Info("notification delivered, acking")
		_ = dc.Accept(ctx)
		return
	}

	c.reject(ctx, dc, log, "delivery failed", err)
}

func (c *Consumer) reject(ctx context.Context, dc rmq.IDeliveryContext, log *slog.Logger, message string, err *handler.HandlerError) {
	if err.IsPermanent {
		log.Error(message+", dead-lettering", "err", err)
		// rejected — routed to the queue's dead-letter exchange
		_ = dc.Discard(ctx, &amqp.Error{Condition: "rejected", Description: message + ": " + err.Error()})
		return
	}

	log.Warn(message+", requeueing", "err", err)
	_ = dc.Requeue(ctx) // released — message returns to the queue
}

// messageID returns the AMQP message id for logging, or nil when unset.
func messageID(msg *amqp.Message) any {
	if msg == nil || msg.Properties == nil {
		return nil
	}
	return msg.Properties.MessageID
}
