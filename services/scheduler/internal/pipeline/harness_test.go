package pipeline

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/agentclient"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/decide"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/notify"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/objects"
)

// The integration tests run the whole pipeline against the local Postgres
// (make docker-up && make migrate) with an in-memory object store, fake
// Captures, a fake agent and a recording notifier. They are skipped when
// POSTGRES_* is not set. Run them with
//
//	cd services/scheduler && export $(grep -v '^#' ../../.env | xargs) && go test -run Integration ./internal/...
//
// Every test works on a user of its own and deletes it afterwards, so the
// database can be shared with a running stack.

type recordingNotifier struct {
	mu    sync.Mutex
	sends []notify.NotificationPayload
}

func (n *recordingNotifier) Send(_ context.Context, _ string, p notify.NotificationPayload) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sends = append(n.sends, p)
	return nil
}

func (n *recordingNotifier) count() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.sends)
}

func (n *recordingNotifier) last() notify.NotificationPayload {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.sends[len(n.sends)-1]
}

// fakeAgent stands in for the agent API. Unless a test sets compare or plan,
// it finds every difference relevant and cannot plan.
type fakeAgent struct {
	mu       sync.Mutex
	compares []agentclient.CompareRequest
	plans    []agentclient.PlanRequest
	compare  func(agentclient.CompareRequest) (agentclient.CompareResponse, error)
	plan     func(agentclient.PlanRequest) (agentclient.PlanResponse, error)
}

var errNoPlan = errors.New("the fake agent does not plan")

func (a *fakeAgent) Compare(_ context.Context, req agentclient.CompareRequest) (agentclient.CompareResponse, error) {
	a.mu.Lock()
	a.compares = append(a.compares, req)
	fn := a.compare
	a.mu.Unlock()
	if fn != nil {
		return fn(req)
	}
	return relevantAnswer(req), nil
}

func (a *fakeAgent) Plan(_ context.Context, req agentclient.PlanRequest) (agentclient.PlanResponse, error) {
	a.mu.Lock()
	a.plans = append(a.plans, req)
	fn := a.plan
	a.mu.Unlock()
	if fn != nil {
		return fn(req)
	}
	return agentclient.PlanResponse{}, errNoPlan
}

func (a *fakeAgent) compareCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.compares)
}

func (a *fakeAgent) planCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.plans)
}

func (a *fakeAgent) lastCompare() agentclient.CompareRequest {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.compares[len(a.compares)-1]
}

func (a *fakeAgent) lastPlan() agentclient.PlanRequest {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.plans[len(a.plans)-1]
}

// relevantAnswer reports the first text op (or, without text, the first
// region) as a Change.
func relevantAnswer(req agentclient.CompareRequest) agentclient.CompareResponse {
	item := agentclient.CompareItem{Title: "Something changed", Before: "old", After: "new", Kind: "text", Matches: "any change", Ops: []int{}, Regions: []int{}}
	if req.Text != nil && len(req.Text.Ops) > 0 {
		item.Ops = []int{0}
	} else if len(req.Regions) > 0 {
		item.Kind, item.Regions = "visual", []int{0}
	}
	return agentclient.CompareResponse{
		Relevant: true, Importance: "high", Summary: "The agent says this matters.",
		Items:   []agentclient.CompareItem{item},
		Ignored: []changerecord.Ignored{{Note: "the footer", Reason: "not asked about"}},
		Model:   "test-model", InputTokens: 1000, OutputTokens: 50, Steps: 2,
	}
}

func notRelevant(agentclient.CompareRequest) (agentclient.CompareResponse, error) {
	return agentclient.CompareResponse{
		Relevant: false, Importance: "low", Summary: "Only the banner changed, which you did not ask about.",
		Model: "test-model", InputTokens: 800, OutputTokens: 30, Steps: 1,
	}, nil
}

func agentDown(agentclient.CompareRequest) (agentclient.CompareResponse, error) {
	return agentclient.CompareResponse{}, errors.New("agent API unreachable: connection refused")
}

type harness struct {
	t        *testing.T
	pool     *pgxpool.Pool
	store    *db.PgxStore
	objects  *objects.Memory
	notifier *recordingNotifier
	agent    *fakeAgent
	p        *Pipeline
	userID   string
	connID   string
	env      string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	if os.Getenv("POSTGRES_HOST") == "" {
		t.Skip("POSTGRES_* not set; skipping integration test")
	}
	url := fmt.Sprintf("postgres://%s:%s@%s:%s/%s",
		os.Getenv("POSTGRES_USER"), os.Getenv("POSTGRES_PASSWORD"),
		os.Getenv("POSTGRES_HOST"), os.Getenv("POSTGRES_PORT"), os.Getenv("POSTGRES_DATABASE"))
	ctx := context.Background()
	pool, err := db.NewPool(ctx, url, 4)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	userID := "it-" + uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'Integration', $2, true)`,
		userID, userID+"@example.test")
	require.NoError(t, err)
	// Monitors go first (and with them everything a test wrote), then the
	// connection, then the secret it holds on to, then the user.
	t.Cleanup(func() {
		ctx := context.Background()
		for _, stmt := range []string{
			`DELETE FROM monitors WHERE user_id = $1`,
			`DELETE FROM provider_connections WHERE user_id = $1`,
			`DELETE FROM secrets WHERE user_id = $1`,
			`DELETE FROM users WHERE id = $1`,
		} {
			if _, err := pool.Exec(ctx, stmt, userID); err != nil {
				t.Logf("cleanup failed: %v", err)
			}
		}
	})

	// A model connection, so Monitors can have one. Keys live in the
	// gateway, which the scheduler never talks to.
	var connID string
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO provider_connections (user_id, kind, name, gateway_provider, gateway_key_id)
		VALUES ($1, 'openai', 'Test', 'openai', $2) RETURNING id`,
		userID, "test-key-"+userID).Scan(&connID))

	h := &harness{
		t: t, pool: pool, store: db.NewStore(pool), objects: objects.NewMemory(),
		notifier: &recordingNotifier{}, agent: &fakeAgent{}, userID: userID, connID: connID, env: "it-env-1",
	}
	h.p = h.newPipeline(h.env)
	return h
}

func (h *harness) newPipeline(env string) *Pipeline {
	return New(Options{
		Store:      h.store,
		Objects:    h.objects,
		Agent:      h.agent,
		Notifier:   h.notifier,
		EnvVersion: env,
		WebURL:     "http://web.test",
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
}

// monitor inserts a Monitor with a model connection and the given
// instructions.
func (h *harness) monitor(instructions string) string {
	h.t.Helper()
	var id string
	err := h.pool.QueryRow(context.Background(), `
		INSERT INTO monitors (user_id, name, url, instructions, connection_id, model)
		VALUES ($1, 'Pricing', 'http://localhost:3003/test/diff/pricing', $2, $3, 'test-model')
		RETURNING id`, h.userID, instructions, h.connID).Scan(&id)
	require.NoError(h.t, err)
	return id
}

func (h *harness) exec(sql string, args ...any) {
	h.t.Helper()
	_, err := h.pool.Exec(context.Background(), sql, args...)
	require.NoError(h.t, err)
}

// macro inserts a Macro version of the given status and returns its id.
func (h *harness) macro(monitorID string, version int, status string) string {
	h.t.Helper()
	var id string
	err := h.pool.QueryRow(context.Background(), `
		INSERT INTO macros (monitor_id, user_id, version, status, source, goal)
		VALUES ($1, $2, $3, $4, 'agent', 'Sign in') RETURNING id`, monitorID, h.userID, version, status).Scan(&id)
	require.NoError(h.t, err)
	return id
}

func (h *harness) run(monitorID string) string {
	h.t.Helper()
	job, err := h.store.CreateRun(context.Background(), monitorID, db.TriggerManual, h.env)
	require.NoError(h.t, err)
	return job.RunID
}

func (h *harness) confirmRun(monitorID string) string {
	h.t.Helper()
	job, err := h.store.CreateRun(context.Background(), monitorID, db.TriggerConfirm, h.env)
	require.NoError(h.t, err)
	return job.RunID
}

// block builds one Capture block.
func block(id, path, text string, rect geom.Rect) capture.Block {
	tag := "p"
	return capture.Block{ID: id, Path: path, Tag: tag, Text: text, Rect: rect}
}

// capture builds a valid Capture with one paragraph block per text.
func (h *harness) capture(monitorID, runID string, texts ...string) capture.Capture {
	blocks := make([]capture.Block, len(texts))
	for i, t := range texts {
		blocks[i] = block(fmt.Sprintf("b%d", i), fmt.Sprintf("/html/body/main/p[%d]", i+1), t, geom.Rect{0, i * 30, 600, 24})
	}
	return h.captureOf(monitorID, runID, blocks)
}

func (h *harness) captureOf(monitorID, runID string, blocks []capture.Block) capture.Capture {
	return capture.Capture{
		Version: capture.Version, RunID: runID, MonitorID: monitorID, Status: capture.StatusOK,
		Blocks: blocks,
		Meta:   capture.Meta{HTTPStatus: 200, Title: "Pricing", Stable: true, EnvVersion: h.env},
	}
}

// withShot attaches a screenshot to a Capture and stores its PNG.
func (h *harness) withShot(c capture.Capture, img image.Image) capture.Capture {
	h.t.Helper()
	var buf bytes.Buffer
	require.NoError(h.t, png.Encode(&buf, img))
	key := objects.ShotKey(c.MonitorID, c.RunID, "png")
	require.NoError(h.t, h.objects.Put(context.Background(), key, buf.Bytes(), objects.TypePNG))
	c.Screenshot = &capture.Screenshot{Key: key, W: img.Bounds().Dx(), H: img.Bounds().Dy(), Format: "png"}
	return c
}

func (h *harness) process(c capture.Capture) Outcome {
	h.t.Helper()
	out, err := h.p.Process(context.Background(), c)
	require.NoError(h.t, err)
	return out
}

// step creates a Run, processes a Capture of texts, and returns the outcome.
func (h *harness) step(monitorID string, texts ...string) Outcome {
	h.t.Helper()
	return h.process(h.capture(monitorID, h.run(monitorID), texts...))
}

// failRun creates a Run and processes an invalid Capture for it.
func (h *harness) failRun(monitorID, reason string) Outcome {
	h.t.Helper()
	c := h.capture(monitorID, h.run(monitorID))
	c.Status, c.InvalidReason, c.Meta.HTTPStatus = capture.StatusInvalid, &reason, 503
	return h.process(c)
}

func (h *harness) changeCount(monitorID string) int {
	var n int
	require.NoError(h.t, h.pool.QueryRow(context.Background(), `SELECT count(*) FROM changes WHERE monitor_id = $1`, monitorID).Scan(&n))
	return n
}

func (h *harness) change(id string) db.ChangeRow {
	h.t.Helper()
	var c db.ChangeRow
	var status string
	err := h.pool.QueryRow(context.Background(), `
		SELECT status::TEXT, suppressed_by, COALESCE(summary, ''), item_count, agent, dimensions::TEXT[], record_key
		FROM changes WHERE id = $1`, id).Scan(&status, &c.SuppressedBy, &c.Summary, &c.ItemCount, &c.Agent, &c.Dimensions, &c.RecordKey)
	require.NoError(h.t, err)
	c.Status = decide.Status(status)
	return c
}

// record loads the stored Change Record of a Change.
func (h *harness) record(monitorID, changeID string) changerecord.Record {
	h.t.Helper()
	var rec changerecord.Record
	require.NoError(h.t, objects.GetJSONGzip(context.Background(), h.objects, objects.RecordKey(monitorID, changeID), &rec))
	return rec
}

func (h *harness) getRun(runID string) db.Run {
	h.t.Helper()
	run, err := h.store.GetRun(context.Background(), runID)
	require.NoError(h.t, err)
	return run
}

func (h *harness) state(monitorID string) db.State {
	h.t.Helper()
	s, _, err := h.store.GetState(context.Background(), monitorID)
	require.NoError(h.t, err)
	return s
}

func (h *harness) config(monitorID string) monitor.Config {
	h.t.Helper()
	cfg, err := h.store.GetMonitor(context.Background(), monitorID)
	require.NoError(h.t, err)
	return cfg
}

// page is a small synthetic screenshot: a white page with coloured boxes.
type box struct {
	rect geom.Rect
	fill color.NRGBA
}

func drawShot(w, h int, boxes ...box) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = 0xff
	}
	for _, b := range boxes {
		r := b.rect.Image().Intersect(img.Rect)
		for y := r.Min.Y; y < r.Max.Y; y++ {
			for x := r.Min.X; x < r.Max.X; x++ {
				// A little texture, so rows differ and can be aligned.
				c := b.fill
				c.R = uint8((int(c.R) + (x*7+y*13)%23) % 256)
				img.SetNRGBA(x, y, c)
			}
		}
	}
	return img
}

var (
	red   = color.NRGBA{R: 200, G: 30, B: 30, A: 255}
	blue  = color.NRGBA{R: 30, G: 60, B: 200, A: 255}
	green = color.NRGBA{R: 30, G: 160, B: 60, A: 255}
	grey  = color.NRGBA{R: 120, G: 120, B: 120, A: 255}
)
