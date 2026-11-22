// Package retention deletes old evidence. Change Records and their images
// expire after RETENTION_DAYS; Capture objects expire at the same age unless
// a Change or a baseline still references them, and so do the screenshots
// taken after each step of a Run. The captures and run_steps rows themselves
// are kept, with their keys nulled: the fingerprints and the trace are cheap,
// the objects are not.
package retention

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/objects"
)

const (
	// DefaultDays is used when RETENTION_DAYS is unset.
	DefaultDays = 90
	batchSize   = 500
)

// Store is the part of db.Store retention needs.
type Store interface {
	RetentionCandidates(ctx context.Context, before time.Time, limit int) ([]db.RetentionCandidate, error)
	ClearCaptureKeys(ctx context.Context, runIDs []string) error
	ExpiredChanges(ctx context.Context, before time.Time, limit int) ([]db.ChangeRow, error)
	DeleteChanges(ctx context.Context, ids []string) error
	ExpiredStepScreenshots(ctx context.Context, before time.Time, limit int) ([]db.StepScreenshot, error)
	ClearStepScreenshots(ctx context.Context, stepIDs []string) error
}

// Job runs retention.
type Job struct {
	Store   Store
	Objects objects.Store
	Days    int
	Now     func() time.Time
	Logger  *slog.Logger
}

// Result reports what one run deleted.
type Result struct {
	Changes  int `json:"changes"`
	Captures int `json:"captures"`
	// StepScreenshots counts the Run step screenshots deleted
	// (steps/{monitor}/{run}/{seq}.webp).
	StepScreenshots int      `json:"step_screenshots"`
	DeletedObjects  []string `json:"deleted_objects"`
}

// Run deletes everything past retention. It is idempotent.
func (j *Job) Run(ctx context.Context) (any, error) {
	return j.run(ctx)
}

func (j *Job) run(ctx context.Context) (Result, error) {
	now := time.Now
	if j.Now != nil {
		now = j.Now
	}
	days := j.Days
	if days <= 0 {
		days = DefaultDays
	}
	before := now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
	res := Result{DeletedObjects: []string{}}

	// Changes first: once they are gone, the Captures they referenced become
	// candidates in the same run.
	for {
		changes, err := j.Store.ExpiredChanges(ctx, before, batchSize)
		if err != nil {
			return res, err
		}
		if len(changes) == 0 {
			break
		}
		ids := make([]string, 0, len(changes))
		for _, c := range changes {
			for _, k := range []*string{c.RecordKey, c.DiffImageKey, c.CropKey} {
				if k != nil && *k != "" {
					if err := j.delete(ctx, *k); err != nil {
						return res, err
					}
					res.DeletedObjects = append(res.DeletedObjects, *k)
				}
			}
			ids = append(ids, c.ID)
		}
		if err := j.Store.DeleteChanges(ctx, ids); err != nil {
			return res, err
		}
		res.Changes += len(ids)
		if len(changes) < batchSize {
			break
		}
	}

	for {
		cands, err := j.Store.RetentionCandidates(ctx, before, batchSize)
		if err != nil {
			return res, err
		}
		if len(cands) == 0 {
			break
		}
		runIDs := make([]string, 0, len(cands))
		for _, c := range cands {
			for _, k := range c.Keys {
				if err := j.delete(ctx, k); err != nil {
					return res, err
				}
				res.DeletedObjects = append(res.DeletedObjects, k)
			}
			runIDs = append(runIDs, c.RunID)
		}
		if err := j.Store.ClearCaptureKeys(ctx, runIDs); err != nil {
			return res, err
		}
		res.Captures += len(runIDs)
		if len(cands) < batchSize {
			break
		}
	}

	// Step screenshots are found through their run_steps rows: the object
	// store offers no listing, and the rows say exactly what was written.
	for {
		steps, err := j.Store.ExpiredStepScreenshots(ctx, before, batchSize)
		if err != nil {
			return res, err
		}
		if len(steps) == 0 {
			break
		}
		ids := make([]string, 0, len(steps))
		for _, s := range steps {
			if err := j.delete(ctx, s.Key); err != nil {
				return res, err
			}
			res.DeletedObjects = append(res.DeletedObjects, s.Key)
			ids = append(ids, s.StepID)
		}
		if err := j.Store.ClearStepScreenshots(ctx, ids); err != nil {
			return res, err
		}
		res.StepScreenshots += len(ids)
		if len(steps) < batchSize {
			break
		}
	}

	if j.Logger != nil {
		j.Logger.Info("retention completed", "changes", res.Changes, "captures", res.Captures,
			"step_screenshots", res.StepScreenshots, "objects", len(res.DeletedObjects))
	}
	return res, nil
}

func (j *Job) delete(ctx context.Context, key string) error {
	if err := j.Objects.Delete(ctx, key); err != nil && !errors.Is(err, objects.ErrNotFound) {
		return err
	}
	return nil
}
