package monitor_due_jobs

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/stretchr/testify/require"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

type fakeStore struct {
	jobs        []db.ScrapeJob
	scheduleErr error

	mu        sync.Mutex
	failedRun string
}

func (f *fakeStore) ScheduleDueRuns(context.Context, int, time.Time, string) ([]db.ScrapeJob, error) {
	return f.jobs, f.scheduleErr
}

func (f *fakeStore) MarkRunFailed(_ context.Context, runID string, _ db.RunError) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failedRun = runID
	return nil
}

type fakePublisher struct {
	mu    sync.Mutex
	calls []any
	err   error
}

func (p *fakePublisher) Publish(_ context.Context, _ string, payload any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, payload)
	return p.err
}

func TestRunTick_PublishesEachJob(t *testing.T) {
	store := &fakeStore{jobs: []db.ScrapeJob{
		{RunID: "run-1", MonitorID: "m1"},
		{RunID: "run-2", MonitorID: "m2"},
	}}
	pub := &fakePublisher{}
	d := New(store, pub, testLogger(), 2, "test-env")

	d.handler(context.Background(), 100, time.Now())

	require.Len(t, pub.calls, 2)
	require.Empty(t, store.failedRun)
	// Each published payload is a ScrapeJob.
	_, ok := pub.calls[0].(db.ScrapeJob)
	require.True(t, ok)
}

func TestRunTick_MarksRunFailedOnPublishError(t *testing.T) {
	store := &fakeStore{jobs: []db.ScrapeJob{{RunID: "run-1", MonitorID: "m1"}}}
	pub := &fakePublisher{err: errors.New("publish failed")}
	d := New(store, pub, testLogger(), 1, "test-env")

	d.handler(context.Background(), 100, time.Now())

	require.Equal(t, "run-1", store.failedRun)
}

func TestRunTick_NoJobsNoPublish(t *testing.T) {
	store := &fakeStore{}
	pub := &fakePublisher{}
	d := New(store, pub, testLogger(), 1, "test-env")

	d.handler(context.Background(), 100, time.Now())
	require.Empty(t, pub.calls)
}
