// Package admin is the scheduler's internal HTTP API: Run now, Run status,
// accept-as-baseline, plan again, on-demand comparison, digests and
// retention. The web app calls it from server code after checking ownership,
// and the E2E suite drives the pipeline through it. Every route but
// /internal/health requires the SCHEDULER_ADMIN_TOKEN bearer.
package admin

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/broker"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/pipeline"
)

// Retention runs the retention job on demand.
type Retention interface {
	Run(ctx context.Context) (any, error)
}

// Options configures the server.
type Options struct {
	Addr          string
	Token         string
	Store         db.Store
	Pipeline      *pipeline.Pipeline
	Publisher     broker.Publisher
	JobRoutingKey string
	Retention     Retention
	Logger        *slog.Logger
}

// Server is the admin HTTP server.
type Server struct {
	opts Options
	srv  *http.Server
}

var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// New builds the server.
func New(opts Options) *Server {
	s := &Server{opts: opts}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/health", s.health)
	mux.HandleFunc("POST /internal/monitors/{id}/runs", s.auth(s.createRun))
	mux.HandleFunc("GET /internal/runs/{id}", s.auth(s.getRun))
	mux.HandleFunc("POST /internal/monitors/{id}/baseline", s.auth(s.acceptBaseline))
	mux.HandleFunc("POST /internal/monitors/{id}/plan", s.auth(s.replan))
	mux.HandleFunc("POST /internal/compare", s.auth(s.compare))
	mux.HandleFunc("POST /internal/digests/run", s.auth(s.runDigests))
	mux.HandleFunc("POST /internal/retention/run", s.auth(s.runRetention))
	s.srv = &http.Server{Addr: opts.Addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	return s
}

// Handler exposes the router, for tests.
func (s *Server) Handler() http.Handler { return s.srv.Handler }

// Run serves until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	errCh := make(chan error, 1)
	go func() { errCh <- s.srv.ListenAndServe() }()
	s.opts.Logger.Info("admin server listening", "addr", s.opts.Addr)
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return s.srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	want := sha256.Sum256([]byte(s.opts.Token))
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		got := sha256.Sum256([]byte(token))
		if !ok || s.opts.Token == "" || subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized", "a valid bearer token is required")
			return
		}
		next(w, r)
	}
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "env_version": s.opts.Pipeline.EnvVersion()})
}

func (s *Server) createRun(w http.ResponseWriter, r *http.Request) {
	monitorID := r.PathValue("id")
	if !uuidRE.MatchString(monitorID) {
		writeError(w, http.StatusBadRequest, "invalid_id", "monitor id must be a UUID")
		return
	}
	var body struct {
		Trigger string `json:"trigger"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	switch body.Trigger {
	case "":
		body.Trigger = db.TriggerManual
	case db.TriggerManual, db.TriggerConfirm:
	default:
		writeError(w, http.StatusBadRequest, "invalid_trigger", "trigger must be manual or confirm")
		return
	}

	job, err := s.opts.Store.CreateRun(r.Context(), monitorID, body.Trigger, s.opts.Pipeline.EnvVersion())
	if err != nil {
		s.fail(w, err)
		return
	}
	if err := s.opts.Publisher.Publish(r.Context(), s.opts.JobRoutingKey, job); err != nil {
		_ = s.opts.Store.MarkRunFailed(context.WithoutCancel(r.Context()), job.RunID, db.RunError{Code: "publish_failed", Message: err.Error()})
		writeError(w, http.StatusBadGateway, "publish_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"run_id": job.RunID})
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("id")
	if !uuidRE.MatchString(runID) {
		writeError(w, http.StatusBadRequest, "invalid_id", "run id must be a UUID")
		return
	}
	run, err := s.opts.Store.GetRun(r.Context(), runID)
	if err != nil {
		s.fail(w, err)
		return
	}
	resp := map[string]any{
		"run_id":         run.ID,
		"monitor_id":     run.MonitorID,
		"status":         run.Status,
		"trigger":        run.Trigger,
		"verdict":        run.Verdict,
		"invalid_reason": run.InvalidReason,
		"error":          json.RawMessage(nullIfEmpty(run.Error)),
		"summary":        run.Summary,
		"macro_id":       run.MacroID,
		"macro_status":   run.MacroStatus,
		"input_tokens":   run.InputTokens,
		"output_tokens":  run.OutputTokens,
		"change_id":      nil,
		"change_status":  nil,
	}
	change, err := s.opts.Store.GetChangeByRun(r.Context(), runID)
	if err != nil {
		s.fail(w, err)
		return
	}
	if change != nil {
		resp["change_id"] = change.ID
		resp["change_status"] = change.Status
		resp["suppressed_by"] = change.SuppressedBy
		resp["record_key"] = change.RecordKey
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) acceptBaseline(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RunID string `json:"run_id"`
	}
	if err := decodeBody(r, &body); err != nil || !uuidRE.MatchString(body.RunID) {
		writeError(w, http.StatusBadRequest, "invalid_body", "run_id must be a UUID")
		return
	}
	if err := s.opts.Pipeline.AcceptBaseline(r.Context(), r.PathValue("id"), body.RunID); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// replan makes a new Watch Plan from the Monitor's latest valid Capture and
// answers with the plan it saved.
func (s *Server) replan(w http.ResponseWriter, r *http.Request) {
	monitorID := r.PathValue("id")
	if !uuidRE.MatchString(monitorID) {
		writeError(w, http.StatusBadRequest, "invalid_id", "monitor id must be a UUID")
		return
	}
	plan, err := s.opts.Pipeline.Replan(r.Context(), monitorID)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

func (s *Server) compare(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FromRun string `json:"from_run"`
		ToRun   string `json:"to_run"`
	}
	if err := decodeBody(r, &body); err != nil || !uuidRE.MatchString(body.FromRun) || !uuidRE.MatchString(body.ToRun) {
		writeError(w, http.StatusBadRequest, "invalid_body", "from_run and to_run must be UUIDs")
		return
	}
	rec, err := s.opts.Pipeline.Compare(r.Context(), body.FromRun, body.ToRun)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) runDigests(w http.ResponseWriter, r *http.Request) {
	res, err := s.opts.Pipeline.RunDigests(r.Context(), r.URL.Query().Get("bucket"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) runRetention(w http.ResponseWriter, r *http.Request) {
	if s.opts.Retention == nil {
		writeError(w, http.StatusNotImplemented, "not_configured", "retention is not configured")
		return
	}
	res, err := s.opts.Retention.Run(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// fail maps pipeline and store errors onto HTTP statuses.
func (s *Server) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, db.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, pipeline.ErrBadRequest):
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, pipeline.ErrAgent):
		writeError(w, http.StatusBadGateway, "agent_failed", err.Error())
	default:
		s.opts.Logger.Error("admin request failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
	}
}

func decodeBody(r *http.Request, v any) error {
	if r.Body == nil || r.ContentLength == 0 {
		return nil
	}
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	return dec.Decode(v)
}

func nullIfEmpty(raw []byte) []byte {
	if len(raw) == 0 {
		return []byte("null")
	}
	return raw
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
