package admin

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/pipeline"
)

const (
	monitorID = "8dea949d-d40b-49f6-8f9a-9e31f891eb4e"
	runID     = "2136440b-8e77-4a2d-8fe2-fcaea8af11f7"
	macroID   = "5b0c2f0e-3c57-4a55-b1a5-0d6f3f0f7a11"
)

// fakeStore answers the few calls these routes make. Anything else would
// panic on the nil embedded Store, which is the point: the test would say so.
type fakeStore struct {
	db.Store
	created []string
	run     db.Run
	change  *db.ChangeRow
}

func (f *fakeStore) CreateRun(_ context.Context, monitor, trigger, env string) (db.ScrapeJob, error) {
	f.created = append(f.created, trigger)
	return db.ScrapeJob{Version: db.ScrapeJobVersion, RunID: runID, MonitorID: monitor, EnvVersion: env}, nil
}

func (f *fakeStore) GetRun(context.Context, string) (db.Run, error) { return f.run, nil }

func (f *fakeStore) GetChangeByRun(context.Context, string) (*db.ChangeRow, error) {
	return f.change, nil
}

func (f *fakeStore) GetMonitor(_ context.Context, id string) (monitor.Config, error) {
	return monitor.Config{ID: id}, nil
}

type fakePublisher struct{ published []any }

func (p *fakePublisher) Publish(_ context.Context, _ string, payload any) error {
	p.published = append(p.published, payload)
	return nil
}

func newServer(store *fakeStore, pub *fakePublisher) http.Handler {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(Options{
		Token: "secret", Store: store, Publisher: pub, JobRoutingKey: "monitor_scrape_job", Logger: log,
		Pipeline: pipeline.New(pipeline.Options{Store: store, EnvVersion: "test-env", Logger: log}),
	}).Handler()
}

func call(t *testing.T, h http.Handler, method, path, body, token string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	if rec.Body.Len() > 0 && strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	}
	return rec.Code, out
}

func errorCode(body map[string]any) string {
	e, _ := body["error"].(map[string]any)
	code, _ := e["code"].(string)
	return code
}

func TestRunsAcceptManualAndConfirmOnly(t *testing.T) {
	store, pub := &fakeStore{}, &fakePublisher{}
	h := newServer(store, pub)
	path := "/internal/monitors/" + monitorID + "/runs"

	status, body := call(t, h, http.MethodPost, path, ``, "secret")
	require.Equal(t, http.StatusAccepted, status)
	require.Equal(t, runID, body["run_id"])
	status, _ = call(t, h, http.MethodPost, path, `{"trigger":"confirm"}`, "secret")
	require.Equal(t, http.StatusAccepted, status)
	require.Equal(t, []string{"manual", "confirm"}, store.created, "no trigger means manual")
	require.Len(t, pub.published, 2)
	require.Equal(t, 3, pub.published[0].(db.ScrapeJob).Version)

	for _, trigger := range []string{"learning", "schedule", "replay"} {
		status, body = call(t, h, http.MethodPost, path, `{"trigger":"`+trigger+`"}`, "secret")
		require.Equal(t, http.StatusBadRequest, status, trigger)
		require.Equal(t, "invalid_trigger", errorCode(body))
	}
	require.Len(t, store.created, 2)

	status, body = call(t, h, http.MethodPost, "/internal/monitors/not-a-uuid/runs", ``, "secret")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "invalid_id", errorCode(body))
}

func TestRunStatusCarriesSummaryMacroAndTokens(t *testing.T) {
	summary, verdict, macroStatus, macro := "The Pro plan went from $49 to $59.", "change", "repaired", macroID
	record := "changes/m/c.json.gz"
	store := &fakeStore{
		run: db.Run{
			ID: runID, MonitorID: monitorID, Status: db.RunSucceeded, Trigger: db.TriggerSchedule, Verdict: &verdict,
			Summary: &summary, MacroID: &macro, MacroStatus: &macroStatus, InputTokens: 1300, OutputTokens: 90,
		},
		change: &db.ChangeRow{ID: "0c9f2d1e-8b7a-4c3d-9e2f-1a0b9c8d7e6f", Status: "change", SuppressedBy: []string{}, RecordKey: &record},
	}
	status, body := call(t, newServer(store, &fakePublisher{}), http.MethodGet, "/internal/runs/"+runID, ``, "secret")
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, map[string]any{
		"run_id": runID, "monitor_id": monitorID, "status": "succeeded", "trigger": "schedule", "verdict": "change",
		"invalid_reason": nil, "error": nil,
		"summary": summary, "macro_id": macroID, "macro_status": "repaired",
		"input_tokens": float64(1300), "output_tokens": float64(90),
		"change_id": "0c9f2d1e-8b7a-4c3d-9e2f-1a0b9c8d7e6f", "change_status": "change",
		"suppressed_by": []any{}, "record_key": record,
	}, body)

	// A Run that failed before anything was concluded.
	store.run = db.Run{ID: runID, MonitorID: monitorID, Status: db.RunProcessing, Trigger: db.TriggerManual}
	store.change = nil
	_, body = call(t, newServer(store, &fakePublisher{}), http.MethodGet, "/internal/runs/"+runID, ``, "secret")
	require.Nil(t, body["summary"])
	require.Nil(t, body["macro_status"])
	require.Equal(t, float64(0), body["input_tokens"])
	require.Nil(t, body["change_id"])
}

func TestRoutes(t *testing.T) {
	h := newServer(&fakeStore{}, &fakePublisher{})

	// Health needs no token and names the capture environment.
	status, body := call(t, h, http.MethodGet, "/internal/health", ``, "")
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, "test-env", body["env_version"])

	// Everything else does.
	for _, token := range []string{"", "wrong"} {
		status, body = call(t, h, http.MethodGet, "/internal/runs/"+runID, ``, token)
		require.Equal(t, http.StatusUnauthorized, status)
		require.Equal(t, "unauthorized", errorCode(body))
	}

	// Replay went away with Rules.
	status, _ = call(t, h, http.MethodPost, "/internal/monitors/"+monitorID+"/replay", `{"rules":{}}`, "secret")
	require.Equal(t, http.StatusNotFound, status)

	// Plan again: a Monitor without a model connection cannot be planned for.
	status, body = call(t, h, http.MethodPost, "/internal/monitors/"+monitorID+"/plan", ``, "secret")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "bad_request", errorCode(body))
	status, body = call(t, h, http.MethodPost, "/internal/monitors/nope/plan", ``, "secret")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "invalid_id", errorCode(body))

	status, body = call(t, h, http.MethodPost, "/internal/compare", `{"from_run":"x","to_run":"y"}`, "secret")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "invalid_body", errorCode(body))
}
