// Package artifact_worker consumes the browser worker's Captures from the
// monitor_runs.scraped queue and hands each one to the pipeline.
package artifact_worker

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/broker"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/pipeline"
)

const (
	ResultQueue      = "monitor_runs.scraped"
	ResultExchange   = "monitor_runs"
	ResultRoutingKey = "monitor_scrape_result"
)

// Processor evaluates one Capture. Satisfied by *pipeline.Pipeline.
type Processor interface {
	Process(ctx context.Context, c capture.Capture) (pipeline.Outcome, error)
}

// ArtifactConsumer settles each delivery according to the pipeline's result:
// accept on success, discard a Capture that can never be processed, and
// requeue anything transient (the queue's delivery limit and DLQ bound the
// retries).
type ArtifactConsumer struct {
	processor Processor
	workers   int
	logger    *slog.Logger
}

// ArtifactConsumerOptions configures a consumer.
type ArtifactConsumerOptions struct {
	Processor Processor
	Workers   int
	Logger    *slog.Logger
}

func NewArtifactConsumer(opts ArtifactConsumerOptions) *ArtifactConsumer {
	workers := max(opts.Workers, 1)
	return &ArtifactConsumer{processor: opts.Processor, workers: workers, logger: opts.Logger}
}

// Run consumes the result queue until ctx is cancelled.
func (c *ArtifactConsumer) Run(ctx context.Context, rabbitURL string) error {
	return broker.Consume(ctx, rabbitURL, ResultQueue, c.workers, c.logger, c.handle)
}

func (c *ArtifactConsumer) handle(ctx context.Context, d broker.Delivery) {
	result, err := capture.Decode(d.Body())
	if err != nil {
		c.logger.Error("invalid capture, discarding", "err", err)
		_ = d.Discard(ctx, "invalid payload: "+err.Error())
		return
	}

	log := c.logger.With("run_id", result.RunID, "monitor_id", result.MonitorID, "capture_status", result.Status)

	start := time.Now()
	out, err := c.processor.Process(ctx, result)
	switch {
	case errors.Is(err, pipeline.ErrPermanent):
		log.Error("capture cannot be processed, discarding", "err", err)
		_ = d.Discard(ctx, err.Error())
		return
	case err != nil:
		log.Error("failed to process capture, requeueing", "err", err)
		_ = d.Requeue(ctx)
		return
	}

	_ = d.Accept(ctx)
	log.Info("run processed",
		"verdict", out.Verdict,
		"change_id", out.ChangeID,
		"failed", out.Failed,
		"invalid_reason", out.InvalidReason,
		"duplicate", out.Duplicate,
		"notified", out.Notified,
		"digest", out.Digest,
		"planned", out.Planned,
		"duration_ms", time.Since(start).Milliseconds())
}
