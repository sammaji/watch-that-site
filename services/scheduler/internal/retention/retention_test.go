package retention

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/objects"
)

// fakeStore models the retention queries over an in-memory set of captures
// and changes, applying the same reference rules as the SQL.
type fakeStore struct {
	captures  []fakeCapture
	changes   []db.ChangeRow
	baselines map[string]bool
	steps     []fakeStep
}

type fakeStep struct {
	id  string
	at  time.Time
	key string
}

type fakeCapture struct {
	runID string
	at    time.Time
	keys  []string
}

func (f *fakeStore) referenced(runID string) bool {
	if f.baselines[runID] {
		return true
	}
	for _, c := range f.changes {
		if c.RunID == runID || c.FromRunID == runID {
			return true
		}
	}
	return false
}

func (f *fakeStore) RetentionCandidates(_ context.Context, before time.Time, _ int) ([]db.RetentionCandidate, error) {
	var out []db.RetentionCandidate
	for _, c := range f.captures {
		if c.at.Before(before) && len(c.keys) > 0 && !f.referenced(c.runID) {
			out = append(out, db.RetentionCandidate{RunID: c.runID, Keys: c.keys})
		}
	}
	return out, nil
}

func (f *fakeStore) ClearCaptureKeys(_ context.Context, runIDs []string) error {
	for i := range f.captures {
		for _, id := range runIDs {
			if f.captures[i].runID == id {
				f.captures[i].keys = nil
			}
		}
	}
	return nil
}

func (f *fakeStore) ExpiredChanges(_ context.Context, before time.Time, _ int) ([]db.ChangeRow, error) {
	var out []db.ChangeRow
	for _, c := range f.changes {
		if c.CreatedAt.Before(before) {
			out = append(out, c)
		}
	}
	return out, nil
}

func (f *fakeStore) DeleteChanges(_ context.Context, ids []string) error {
	keep := f.changes[:0]
	for _, c := range f.changes {
		drop := false
		for _, id := range ids {
			drop = drop || c.ID == id
		}
		if !drop {
			keep = append(keep, c)
		}
	}
	f.changes = keep
	return nil
}

func (f *fakeStore) ExpiredStepScreenshots(_ context.Context, before time.Time, _ int) ([]db.StepScreenshot, error) {
	var out []db.StepScreenshot
	for _, s := range f.steps {
		if s.at.Before(before) && s.key != "" {
			out = append(out, db.StepScreenshot{StepID: s.id, Key: s.key})
		}
	}
	return out, nil
}

func (f *fakeStore) ClearStepScreenshots(_ context.Context, ids []string) error {
	for i := range f.steps {
		for _, id := range ids {
			if f.steps[i].id == id {
				f.steps[i].key = ""
			}
		}
	}
	return nil
}

func ptr(s string) *string { return &s }

func TestRetentionDeletesExactlyTheExpiredObjects(t *testing.T) {
	now := time.Date(2026, 11, 21, 3, 0, 0, 0, time.UTC)
	old := now.Add(-100 * 24 * time.Hour)
	recent := now.Add(-10 * 24 * time.Hour)

	store := &fakeStore{
		captures: []fakeCapture{
			// Unreferenced and old: its objects go.
			{runID: "r1", at: old, keys: []string{"captures/m/r1/blocks.json.gz", "captures/m/r1/shot.webp"}},
			// Old but the current baseline: kept.
			{runID: "r2", at: old, keys: []string{"captures/m/r2/blocks.json.gz"}},
			// Old, referenced only by an expired change: goes once the change does.
			{runID: "r3", at: old, keys: []string{"captures/m/r3/blocks.json.gz"}},
			{runID: "r4", at: old, keys: []string{"captures/m/r4/blocks.json.gz"}},
			// Recent: kept.
			{runID: "r5", at: recent, keys: []string{"captures/m/r5/blocks.json.gz"}},
			// Recent change's from side, old capture: kept while the change lives.
			{runID: "r6", at: old, keys: []string{"captures/m/r6/blocks.json.gz"}},
		},
		changes: []db.ChangeRow{
			{ID: "c-old", RunID: "r4", FromRunID: "r3", CreatedAt: old,
				RecordKey: ptr("changes/m/c-old.json.gz"), DiffImageKey: ptr("changes/m/c-old-diff.png")},
			{ID: "c-new", RunID: "r5", FromRunID: "r6", CreatedAt: recent,
				RecordKey: ptr("changes/m/c-new.json.gz")},
		},
		baselines: map[string]bool{"r2": true},
		steps: []fakeStep{
			// Steps of an old Run: their screenshots go, the rows stay.
			{id: "s1", at: old, key: "steps/m/r1/0.webp"},
			{id: "s2", at: old, key: "steps/m/r1/1.webp"},
			// An old step that never had a screenshot.
			{id: "s3", at: old},
			// A recent Run's step: kept.
			{id: "s4", at: recent, key: "steps/m/r5/0.webp"},
		},
	}
	objs := objects.NewMemory()

	job := &Job{Store: store, Objects: objs, Days: 90, Now: func() time.Time { return now }}
	res, err := job.run(context.Background())
	require.NoError(t, err)

	require.Equal(t, []string{
		"changes/m/c-old.json.gz",
		"changes/m/c-old-diff.png",
		"captures/m/r1/blocks.json.gz",
		"captures/m/r1/shot.webp",
		"captures/m/r3/blocks.json.gz",
		"captures/m/r4/blocks.json.gz",
		"steps/m/r1/0.webp",
		"steps/m/r1/1.webp",
	}, objs.Deleted())
	require.Equal(t, 1, res.Changes)
	require.Equal(t, 3, res.Captures)
	require.Equal(t, 2, res.StepScreenshots)
	require.Equal(t, "steps/m/r5/0.webp", store.steps[3].key, "a recent step keeps its screenshot")

	// A second run is a no-op.
	res, err = job.run(context.Background())
	require.NoError(t, err)
	require.Zero(t, res.Changes)
	require.Zero(t, res.Captures)
	require.Zero(t, res.StepScreenshots)
}
