package pipeline

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/objects"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/retention"
)

// Retention against the real schema. The rows it should delete are backdated
// to the year 2000 and the job's clock is set so that its cutoff is 2001:
// nothing of anybody else in a shared database is that old.
func TestIntegrationRetention(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	m := h.monitor("")

	base := h.step(m, page...)
	changed := h.step(m, withPrice("$51")...) // a Change, then two quiet Runs
	quiet := h.step(m, withPrice("$51")...)
	latest := h.step(m, withPrice("$51")...)
	require.Equal(t, "change", changed.Verdict)

	// Two steps of the quiet Run left screenshots, and one of a recording.
	stepKey := func(seq int) string { return "steps/" + m + "/" + quiet.RunID + "/" + string(rune('0'+seq)) + ".webp" }
	for seq := range 2 {
		require.NoError(t, h.objects.Put(ctx, stepKey(seq), []byte("webp"), objects.TypeWebP))
		h.exec(`INSERT INTO run_steps (run_id, monitor_id, user_id, seq, phase, kind, title, status, screenshot_key, created_at)
			VALUES ($1, $2, $3, $4, 'macro', 'click', 'Click Annual', 'ok', $5, '2000-01-01')`, quiet.RunID, m, h.userID, seq, stepKey(seq))
	}
	macro := h.macro(m, 1, "draft")
	recKey := "steps/" + m + "/" + macro + "/0.webp"
	require.NoError(t, h.objects.Put(ctx, recKey, []byte("webp"), objects.TypeWebP))
	h.exec(`INSERT INTO run_steps (macro_id, monitor_id, user_id, seq, phase, kind, title, status, screenshot_key, created_at)
		VALUES ($1, $2, $3, 0, 'record', 'click', 'Click Sign in', 'ok', $4, '2000-01-01')`, macro, m, h.userID, recKey)

	// Everything of this Monitor is old.
	h.exec(`UPDATE captures SET created_at = '2000-01-01' WHERE monitor_id = $1`, m)
	h.exec(`UPDATE changes SET created_at = '2000-01-01' WHERE monitor_id = $1`, m)

	job := &retention.Job{
		Store: h.store, Objects: h.objects, Days: 90,
		Now: func() time.Time { return time.Date(2001, 4, 1, 0, 0, 0, 0, time.UTC) },
	}
	res, err := job.Run(ctx)
	require.NoError(t, err)
	got := res.(retention.Result)

	require.Equal(t, 1, got.Changes)
	require.Equal(t, 2, got.Captures, "every Capture but the two baselines: the latest, and the one at the last Change")
	require.Equal(t, 2, got.StepScreenshots)
	require.ElementsMatch(t, []string{
		objects.RecordKey(m, changed.ChangeID),
		objects.BlocksKey(m, base.RunID),
		objects.BlocksKey(m, quiet.RunID),
		stepKey(0), stepKey(1),
	}, got.DeletedObjects)

	// The Change is gone; the Captures and steps stay, without their keys.
	require.Zero(t, h.changeCount(m))
	row, err := h.store.GetCapture(ctx, quiet.RunID)
	require.NoError(t, err)
	require.Nil(t, row.BlocksKey)
	require.NotEmpty(t, row.TextHash, "the fingerprint outlives the object")
	var kept, cleared int
	require.NoError(t, h.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE screenshot_key IS NOT NULL), count(*) FILTER (WHERE screenshot_key IS NULL)
		FROM run_steps WHERE monitor_id = $1`, m).Scan(&kept, &cleared))
	require.Equal(t, 2, cleared)
	require.Equal(t, 1, kept, "a recording's steps belong to the Macro, not to a Run")
	require.Contains(t, h.objects.Keys("steps/"), recKey)

	// The baselines are untouched, so the Monitor keeps working.
	for _, runID := range []string{latest.RunID, changed.RunID} {
		row, err = h.store.GetCapture(ctx, runID)
		require.NoError(t, err)
		require.NotNil(t, row.BlocksKey)
	}

	// A second run finds nothing left to do.
	res, err = job.Run(ctx)
	require.NoError(t, err)
	require.Empty(t, res.(retention.Result).DeletedObjects)

	require.Equal(t, "none", h.step(m, withPrice("$51")...).Verdict)
}
