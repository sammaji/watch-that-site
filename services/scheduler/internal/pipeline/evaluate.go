package pipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/decide"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff/text"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff/visual"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/objects"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/render"
)

// Run summaries: a few words for the timeline.
const (
	summaryBaseline     = "Baseline captured"
	summaryNone         = "No difference"
	summaryPending      = "Seen once, waiting for the next check to confirm"
	summaryNotPersisted = "The change was gone by the next check"
)

// evaluation is the state of one Process call inside the Monitor's lock.
type evaluation struct {
	p     *Pipeline
	tx    db.Tx
	cfg   monitor.Config
	state db.State
	run   db.Run
	cap   capture.Capture
	now   time.Time
	out   *Outcome
	post  *postCommit

	// inputTokens and outputTokens add up the model usage of the Run: a
	// Macro repair, a Watch Plan, the comparison.
	inputTokens, outputTokens int
	// newPlan is a Watch Plan made during this Run, saved when it ends.
	newPlan *monitor.WatchPlan
}

func (e *evaluation) spend(input, output int) {
	e.inputTokens += input
	e.outputTokens += output
}

// outcome is what the Run records when it ends with the given summary.
func (e *evaluation) outcome(summary string) db.RunOutcome {
	o := db.RunOutcome{Summary: summary, InputTokens: e.inputTokens, OutputTokens: e.outputTokens}
	if m := e.cap.Macro; m != nil {
		o.MacroID, o.MacroStatus = &m.MacroID, &m.Status
	}
	return o
}

// fail records an invalid or failed Capture. The baseline is never touched.
// When the Monitor has now failed failureAlertAfter times in a row, the owner
// is told once; the streak starts over at the next success.
func (e *evaluation) fail(ctx context.Context, reason, message string) error {
	code := reason
	if code == "" {
		code = "capture_error"
	}
	var reasonPtr *string
	if reason != "" {
		reasonPtr = &reason
	}
	runErr := db.RunError{Code: code, Message: message, OccurredAt: e.now}
	if err := e.tx.MarkRunFailed(ctx, e.run.ID, runErr, reasonPtr, e.outcome(message)); err != nil {
		return err
	}

	e.state.ConsecutiveFailures++
	if e.state.ConsecutiveFailures == failureAlertAfter && !e.cfg.Snoozed(e.now) {
		payload, err := render.FailureNotification(
			render.MonitorInfo{ID: e.cfg.ID, Name: e.cfg.Name, URL: e.cfg.URL},
			code, message, e.state.ConsecutiveFailures, e.now, e.p.links("", ""))
		if err != nil {
			return err
		}
		e.post.notify = &payload
		e.post.userID = e.cfg.UserID
	}
	if err := e.tx.SaveState(ctx, e.cfg, e.state); err != nil {
		return err
	}

	e.out.Failed = true
	e.out.InvalidReason = reason
	return nil
}

// side is one Capture ready for comparison.
type side struct {
	row    db.CaptureRow
	stored capture.StoredBlocks
	blocks []diff.NBlock
	// textHash and simHash fingerprint the text the Monitor watches.
	textHash []byte
	simHash  uint64
	img      image.Image
	imgErr   error
	loaded   bool
}

func (e *evaluation) evaluate(ctx context.Context) error {
	c := e.cap

	var prev *side
	if e.state.PreviousRunID != nil {
		s, err := e.loadSide(ctx, *e.state.PreviousRunID)
		if err != nil && !errors.Is(err, db.ErrNotFound) && !errors.Is(err, objects.ErrNotFound) {
			return err
		}
		prev = s
	}

	// A partial load can only be told from the baseline: a page that
	// suddenly has a tenth of its text most likely did not finish loading.
	if prev != nil {
		prevLen, curLen := storedTextLength(prev.stored), c.TextLength()
		if prevLen > partialMinBaseline && float64(curLen) < partialRatio*float64(prevLen) {
			return e.fail(ctx, capture.ReasonPartial, partialMessage)
		}
	}

	cur, err := e.storeBlocks(ctx)
	if err != nil {
		return err
	}

	// The plan is settled before anything is normalized, so both sides of
	// this Run's comparison are read under the same one.
	rebaseline := prev == nil || e.needsRebaseline()
	if e.replan(ctx, cur, rebaseline) && prev != nil {
		e.p.normalizeSide(e.cfg, prev)
	}

	if err := e.storeCapture(ctx, cur); err != nil {
		return err
	}
	if rebaseline {
		return e.rebaseline(ctx)
	}

	// With a pending Change, this Run is compared against the Capture the
	// pending Change started from: the question is whether that difference
	// is still there.
	base := prev
	var pending *pendingChange
	if e.state.PendingChangeID != nil {
		ch, err := e.tx.GetChange(ctx, *e.state.PendingChangeID)
		switch {
		case err == nil:
			from, err := e.loadSide(ctx, ch.FromRunID)
			switch {
			case err == nil:
				pending, base = &pendingChange{row: ch}, from
			case errors.Is(err, db.ErrNotFound), errors.Is(err, objects.ErrNotFound):
				// The Capture the pending Change started from has expired,
				// so there is nothing left to confirm it against. The Run is
				// compared with the previous Capture like any other.
				e.state.PendingChangeID = nil
			default:
				return err
			}
		case errors.Is(err, db.ErrNotFound):
			e.state.PendingChangeID = nil
		default:
			return err
		}
	}

	step := e.p.compare(ctx, e.cfg, base, cur)

	in := decide.Input{Evidence: step, Pending: pending != nil, ConfirmChanges: e.cfg.ConfirmChanges}
	var ans *answer
	if decide.NeedsAgent(step) {
		a, reused := e.reuse(ctx, pending, cur)
		if !reused {
			a = e.ask(ctx, step, base, cur)
		}
		ans = &a
		in.Agent = &decide.Answer{Relevant: a.verdict.Relevant, Unavailable: a.verdict.Unavailable}
	}
	return e.record(ctx, base, cur, step, decide.Decide(in), ans)
}

// pendingChange is a Change waiting for this Run to confirm it.
type pendingChange struct {
	row db.ChangeRow
}

// needsRebaseline reports whether the baseline was taken under a different
// capture environment or different capture settings than this Capture, in
// which case comparing the two would report the settings, not the page.
func (e *evaluation) needsRebaseline() bool {
	s := e.state
	if s.EnvVersion == nil || *s.EnvVersion != e.cap.Meta.EnvVersion {
		return true
	}
	// The Macro that counts is the one this Capture was taken with, which
	// the job named. A repair made during the Run does the same thing by
	// other means, so the page is still comparable; the repaired version is
	// what setVersions records for the Runs that follow.
	var replayed *string
	if m := e.cap.Macro; m != nil {
		replayed = &m.MacroID
	}
	return s.CaptureVersion == nil || *s.CaptureVersion != e.cfg.CaptureVersionFor(replayed)
}

// rebaseline makes this Capture the new baseline without recording a Change.
func (e *evaluation) rebaseline(ctx context.Context) error {
	runID := e.run.ID
	e.state.PreviousRunID = &runID
	e.state.LastNotifiedRunID = &runID
	e.state.PendingChangeID = nil
	return e.finish(ctx, db.VerdictBaseline, summaryBaseline)
}

// finish ends a Run that produced a valid Capture: it records the versions
// the Capture was taken under, saves the state and a Watch Plan made on the
// way, and marks the Run succeeded.
func (e *evaluation) finish(ctx context.Context, verdict, summary string) error {
	env := e.cap.Meta.EnvVersion
	cv := e.cfg.CaptureVersionFor(e.cap.Macro.Effective())
	e.state.EnvVersion = &env
	e.state.CaptureVersion = &cv
	// Every Run starts with a fresh browser: no cookies or storage carry
	// over, so a page is seen as a new visitor sees it and a Macro signs in
	// again each time.
	e.state.StorageStateKey = nil
	e.state.ConsecutiveFailures = 0

	if err := e.tx.SaveState(ctx, e.cfg, e.state); err != nil {
		return err
	}
	// The plan is written last: updating the monitors row locks it until
	// commit, and the agent calls of this Run are all behind us here, so the
	// tick and the owner's edits are never kept waiting on a model.
	if e.newPlan != nil {
		if err := e.tx.SaveWatchPlan(ctx, e.cfg.ID, *e.newPlan); err != nil {
			return err
		}
		e.out.Planned = true
	}
	if err := e.tx.MarkRunSucceeded(ctx, e.run.ID, verdict, e.outcome(summary)); err != nil {
		return err
	}
	e.out.Verdict = verdict
	return nil
}

// captureMeta is what captures.meta holds: what the worker observed, plus
// the screenshot's size, which a Watch Plan made later needs.
type captureMeta struct {
	capture.Meta
	Screenshot *shotSize `json:"screenshot,omitempty"`
}

type shotSize struct {
	W int `json:"w"`
	H int `json:"h"`
}

// storeBlocks writes the Capture's blocks to object storage, where the agent
// can read them too, and returns the Capture as a side that is not yet
// normalized.
func (e *evaluation) storeBlocks(ctx context.Context) (*side, error) {
	c := e.cap
	stored := capture.StoredBlocks{Version: capture.Version, Blocks: c.Blocks, Truncated: c.Truncated, Masks: c.Masks}
	blocksKey := objects.BlocksKey(c.MonitorID, c.RunID)
	if err := objects.PutJSONGzip(ctx, e.p.objects, blocksKey, stored); err != nil {
		return nil, fmt.Errorf("store blocks: %w", err)
	}
	e.p.blocks.Add(blocksKey, stored)

	meta := captureMeta{Meta: c.Meta}
	row := db.CaptureRow{
		RunID:     c.RunID,
		MonitorID: c.MonitorID,
		UserID:    e.cfg.UserID,
		BlocksKey: &blocksKey,
		CreatedAt: e.run.CreatedAt,
	}
	if c.Screenshot != nil && c.Screenshot.Key != "" {
		key := c.Screenshot.Key
		row.ScreenshotKey = &key
		meta.Screenshot = &shotSize{W: c.Screenshot.W, H: c.Screenshot.H}
	}
	row.Meta, _ = json.Marshal(meta)
	return &side{row: row, stored: stored}, nil
}

// storeCapture normalizes the Capture under the Monitor's plan and inserts
// its captures row with the fingerprints.
func (e *evaluation) storeCapture(ctx context.Context, cur *side) error {
	e.p.normalizeSide(e.cfg, cur)
	cur.row.TextHash, cur.row.SimHash = cur.textHash, cur.simHash
	if img, err := e.p.image(ctx, cur); err == nil {
		d := capture.DHash(img)
		cur.row.DHash = &d
	}
	return e.tx.InsertCapture(ctx, cur.row)
}

// loadSide loads a stored Capture and normalizes it under the Monitor's
// current plan, so a plan change applies to both sides of every comparison.
func (e *evaluation) loadSide(ctx context.Context, runID string) (*side, error) {
	return e.p.loadSide(ctx, e.tx, e.cfg, runID)
}

func (p *Pipeline) loadSide(ctx context.Context, tx captureGetter, cfg monitor.Config, runID string) (*side, error) {
	row, err := tx.GetCapture(ctx, runID)
	if err != nil {
		return nil, err
	}
	stored, err := p.storedBlocks(ctx, row)
	if err != nil {
		return nil, err
	}
	s := &side{row: row, stored: stored}
	p.normalizeSide(cfg, s)
	return s, nil
}

// storedBlocks loads a Capture's blocks.json.gz, through the cache.
func (p *Pipeline) storedBlocks(ctx context.Context, row db.CaptureRow) (capture.StoredBlocks, error) {
	if row.BlocksKey == nil {
		return capture.StoredBlocks{}, fmt.Errorf("capture %s blocks expired: %w", row.RunID, objects.ErrNotFound)
	}
	stored, ok := p.blocks.Get(*row.BlocksKey)
	if !ok {
		if err := objects.GetJSONGzip(ctx, p.objects, *row.BlocksKey, &stored); err != nil {
			return capture.StoredBlocks{}, err
		}
		p.blocks.Add(*row.BlocksKey, stored)
	}
	return stored, nil
}

type captureGetter interface {
	GetCapture(ctx context.Context, runID string) (db.CaptureRow, error)
}

// image returns the side's decoded screenshot, loading it on first use.
func (p *Pipeline) image(ctx context.Context, s *side) (image.Image, error) {
	if !s.loaded {
		s.loaded = true
		if s.row.ScreenshotKey == nil {
			s.imgErr = objects.ErrNotFound
		} else {
			s.img, s.imgErr = p.loadImage(ctx, *s.row.ScreenshotKey)
		}
	}
	return s.img, s.imgErr
}

func (p *Pipeline) loadImage(ctx context.Context, key string) (image.Image, error) {
	raw, err := p.objects.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	return visual.Decode(raw)
}

// answer is what the agent said about a difference, in the Change Record's
// terms. Items cite the step evidence's text ops and regions by index.
type answer struct {
	summary string
	items   []changerecord.Item
	ignored []changerecord.Ignored
	verdict changerecord.AgentVerdict
}

// record persists the verdict: a changes row and Change Record for every
// difference, the new baselines, and the Reactions to dispatch.
func (e *evaluation) record(ctx context.Context, base, cur *side, step diff.Evidence, verdict decide.Verdict, ans *answer) error {
	runID := e.run.ID
	status := verdict.Status

	if status == decide.StatusNone {
		e.state.PreviousRunID = &runID
		return e.finish(ctx, string(status), summaryNone)
	}

	changeID := uuid.NewString()
	diffKey, cropKey := e.p.renderImages(ctx, e.cfg.ID, changeID, base, cur, step.Visual)

	in := changerecord.BuildInput{
		ChangeID:     changeID,
		Monitor:      e.cfg,
		From:         e.p.runRef(base),
		To:           e.p.runRef(cur),
		Verdict:      verdict,
		Step:         step,
		DiffImageKey: diffKey,
		CropKey:      cropKey,
		Now:          e.now,
	}
	if ans != nil {
		in.Summary, in.Items, in.Ignored, in.Agent = ans.summary, ans.items, ans.ignored, &ans.verdict
	}
	// A notified Change also carries everything since the owner last heard
	// from us, when Runs in between were recorded as Noise.
	if status == decide.StatusChange {
		if from, ev := e.cumulative(ctx, base, cur); ev != nil {
			in.Cumulative, in.CumulativeFrom = ev, e.p.runRef(from)
		}
	}
	rec := changerecord.Build(in)
	if ans != nil && ans.verdict.Relevant && !ans.verdict.Unavailable && len(rec.Items) == 0 {
		// The agent called it a Change but nothing it reported survived the
		// evidence guard. The owner is still told, in the diff's own words.
		rec.Why = append(rec.Why, decide.Why{
			Kind:   decide.WhyNote,
			Detail: "The agent's answer did not point at anything in the diff, so the summary was built from the diff itself.",
		})
	}
	rec.Summary = e.summarize(rec, ans)

	recordKey := objects.RecordKey(e.cfg.ID, changeID)
	if err := objects.PutJSONGzip(ctx, e.p.objects, recordKey, rec); err != nil {
		return fmt.Errorf("store change record: %w", err)
	}

	magnitude, _ := json.Marshal(rec.Magnitude)
	var agentRaw json.RawMessage
	if rec.Agent != nil {
		agentRaw, _ = json.Marshal(rec.Agent)
	}
	row := db.ChangeRow{
		ID:           changeID,
		MonitorID:    e.cfg.ID,
		UserID:       e.cfg.UserID,
		RunID:        runID,
		FromRunID:    base.row.RunID,
		Status:       status,
		Dimensions:   rec.Dimensions(),
		SuppressedBy: rec.SuppressedBy,
		Magnitude:    magnitude,
		Summary:      rec.Summary,
		ItemCount:    len(rec.Items),
		Agent:        agentRaw,
		RecordKey:    &recordKey,
		DiffImageKey: nonEmpty(diffKey),
		CropKey:      nonEmpty(cropKey),
	}
	if err := e.tx.InsertChange(ctx, row); err != nil {
		return err
	}

	e.state.PreviousRunID = &runID
	switch {
	case status == decide.StatusPending:
		e.state.PendingChangeID = &changeID
	case verdict.ConfirmsPending || verdict.DropsPending:
		e.state.PendingChangeID = nil
	}
	if status == decide.StatusChange {
		e.state.LastNotifiedRunID = &runID
	}

	runSummary := rec.Summary
	if status == decide.StatusPending {
		runSummary = summaryPending
	}
	if err := e.finish(ctx, string(status), runSummary); err != nil {
		return err
	}

	if status == decide.StatusPending {
		if err := e.scheduleConfirm(ctx); err != nil {
			return err
		}
	}
	if status == decide.StatusChange {
		if err := e.react(ctx, rec); err != nil {
			return err
		}
	}

	e.out.ChangeID = changeID
	return nil
}

// summarize picks the record's one-sentence summary: the agent's answer when
// it gave one, else a sentence about why nothing was sent, else one built
// from the evidence.
func (e *evaluation) summarize(rec changerecord.Record, ans *answer) string {
	if ans != nil && !ans.verdict.Unavailable && ans.summary != "" && len(rec.Items) > 0 {
		return ans.summary
	}
	// A "not relevant" answer has no items to back its sentence, and needs
	// none: it is what the owner reads on the Noise row.
	if ans != nil && !ans.verdict.Unavailable && !ans.verdict.Relevant && ans.summary != "" {
		return ans.summary
	}
	for _, reason := range rec.SuppressedBy {
		switch reason {
		case decide.ReasonDidNotPersist:
			return summaryNotPersisted
		case decide.ReasonIgnoredSection:
			return ignoredSummary(rec)
		}
	}
	return render.TemplateSummary(rec)
}

// ignoredSummary names the Sections whose differences were left out.
func ignoredSummary(rec changerecord.Record) string {
	var names []string
	if rec.Text != nil {
		for _, op := range rec.Text.Ops {
			if op.Op != diff.OpIgnored {
				continue
			}
			if name := rec.SectionName(op.Section); name != "" && !containsString(names, name) {
				names = append(names, name)
			}
		}
	}
	if len(names) == 0 || len(names) > 3 {
		return "Only parts of the page this Monitor does not watch changed"
	}
	return "Only " + strings.Join(names, ", ") + " changed, which this Monitor does not watch for text"
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// cumulative compares the last notified Capture with this one, when it is not
// the Capture this Run was compared with already. It returns nil when there
// is nothing to add (or that Capture has expired).
func (e *evaluation) cumulative(ctx context.Context, base, cur *side) (*side, *diff.Evidence) {
	id := e.state.LastNotifiedRunID
	if id == nil || *id == base.row.RunID {
		return nil, nil
	}
	from, err := e.loadSide(ctx, *id)
	if err != nil {
		if !errors.Is(err, db.ErrNotFound) && !errors.Is(err, objects.ErrNotFound) {
			e.p.log.Warn("failed to load the last notified Capture", "monitor_id", e.cfg.ID, "run_id", *id, "err", err)
		}
		return nil, nil
	}
	ev := diff.Evidence{Text: tagSections(e.cfg.WatchPlan, text.Compare(from.blocks, cur.blocks))}
	return from, &ev
}

// react queues the Reaction for a Change: an instant notification after
// commit, or a digest item. A snoozed Monitor records the Change silently.
func (e *evaluation) react(ctx context.Context, rec changerecord.Record) error {
	if e.cfg.Snoozed(e.now) {
		return nil
	}
	switch e.cfg.Urgency {
	case monitor.UrgencyHourly, monitor.UrgencyDaily:
		e.out.Digest = true
		return e.tx.InsertDigestItem(ctx, e.cfg, rec.ID, e.cfg.Urgency)
	}
	var cropKey, diffKey string
	if rec.Visual != nil {
		cropKey, diffKey = rec.Visual.Crop, rec.Visual.DiffImage
	}
	payload, err := render.Notification(rec, e.p.links(cropKey, diffKey))
	if err != nil {
		return err
	}
	e.post.notify = &payload
	e.post.changeID = rec.ID
	e.post.userID = e.cfg.UserID
	return nil
}

// scheduleConfirm inserts the confirm Run of a pending Change. It is
// published right after commit for Monitors checked at least every 5
// minutes, and picked up by the minute tick otherwise, after
// min(interval, 5 min).
func (e *evaluation) scheduleConfirm(ctx context.Context) error {
	delay := confirmDelayCap
	if e.cfg.IntervalMin > 0 && time.Duration(e.cfg.IntervalMin)*time.Minute < delay {
		delay = time.Duration(e.cfg.IntervalMin) * time.Minute
	}
	if e.cfg.IntervalMin > 0 && e.cfg.IntervalMin <= 5 {
		run, err := e.tx.InsertRun(ctx, e.cfg, db.TriggerConfirm, db.RunProcessing, nil)
		if err != nil {
			return err
		}
		job := db.BuildScrapeJob(e.jobConfig(), run.ID, e.p.envVersion)
		e.post.publish = &job
		return nil
	}
	at := e.now.Add(delay)
	_, err := e.tx.InsertRun(ctx, e.cfg, db.TriggerConfirm, db.RunPending, &at)
	return err
}

// jobConfig is the Monitor as the next job should see it: after a repair in
// this Run, the Macro to replay is the repaired version.
func (e *evaluation) jobConfig() monitor.Config {
	cfg := e.cfg
	if m := e.cap.Macro; m != nil && m.Status == capture.MacroRepaired {
		cfg.ActiveMacroID = m.Effective()
	}
	return cfg
}

// renderImages uploads the diff image and the first region's crop.
func (p *Pipeline) renderImages(ctx context.Context, monitorID, changeID string, base, cur *side, ev *diff.VisualEvidence) (diffKey, cropKey string) {
	if ev == nil || len(ev.Regions) == 0 {
		return "", ""
	}
	after, err := p.image(ctx, cur)
	if err != nil {
		return "", ""
	}
	if raw, err := encodePNG(visual.RenderDiff(after, ev)); err == nil {
		key := objects.DiffImageKey(monitorID, changeID)
		if err := p.objects.Put(ctx, key, raw, objects.TypePNG); err == nil {
			diffKey = key
		} else {
			p.log.Warn("failed to store diff image", "change_id", changeID, "err", err)
		}
	}
	before, err := p.image(ctx, base)
	if err != nil {
		return diffKey, ""
	}
	if raw, err := encodePNG(visual.Crop(before, after, ev.Regions[0], 24, 1200)); err == nil {
		key := objects.CropKey(monitorID, changeID)
		if err := p.objects.Put(ctx, key, raw, objects.TypePNG); err == nil {
			cropKey = key
		} else {
			p.log.Warn("failed to store crop", "change_id", changeID, "err", err)
		}
	}
	return diffKey, cropKey
}

func encodePNG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (p *Pipeline) runRef(s *side) changerecord.RunRef {
	ref := changerecord.RunRef{RunID: s.row.RunID, At: s.row.CreatedAt.UTC()}
	if s.row.ScreenshotKey != nil {
		ref.Screenshot = *s.row.ScreenshotKey
	}
	if s.row.BlocksKey != nil {
		ref.Blocks = *s.row.BlocksKey
	}
	return ref
}

// links builds the URLs every renderer needs, signing image links for a
// week because chat clients fetch them asynchronously.
func (p *Pipeline) links(cropKey, diffKey string) render.Links {
	l := render.Links{WebURL: p.webURL}
	if cropKey != "" {
		if u, err := p.objects.SignedURL(cropKey, signedImageTTL); err == nil {
			l.CropURL = u
		}
	}
	if diffKey != "" {
		if u, err := p.objects.SignedURL(diffKey, signedImageTTL); err == nil {
			l.DiffImageURL = u
		}
	}
	return l
}

func storedTextLength(s capture.StoredBlocks) int {
	n := 0
	for _, b := range s.Blocks {
		n += len(b.Text)
	}
	return n
}

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
