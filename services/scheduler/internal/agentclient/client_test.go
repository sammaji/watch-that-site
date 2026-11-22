package agentclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
)

func compareRequest() CompareRequest {
	conn, model := "c0a8012e-0000-4000-8000-000000000001", "gpt-5.1"
	at := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	return CompareRequest{
		RunID: "run-2", MonitorID: "mon-1", UserID: "user-1",
		Monitor:      MonitorInfo{Name: "Pricing", URL: "https://acme.test/pricing", Instructions: "Tell me about prices."},
		ConnectionID: &conn, Model: &model,
		From:       changerecord.RunRef{RunID: "run-1", At: at.Add(-time.Hour), Screenshot: "captures/m/r1/shot.png", Blocks: "captures/m/r1/blocks.json.gz"},
		To:         changerecord.RunRef{RunID: "run-2", At: at, Screenshot: "captures/m/r2/shot.png", Blocks: "captures/m/r2/blocks.json.gz"},
		Text:       &changerecord.TextSection{Ops: []diff.TextOp{{Op: diff.OpAdd, Path: "/html/body/p", Text: "New"}}, Masked: []string{}},
		Regions:    []Region{{Box: geom.Rect{1, 2, 3, 4}, FromBox: &geom.Rect{1, 0, 3, 4}, Kind: diff.RegionChanged, Pixels: 12, Section: "plans"}},
		Plan:       &monitor.WatchPlan{Version: 1, Sections: []monitor.WatchSection{{ID: "plans", Name: "Plans", How: monitor.HowBoth, Paths: []string{"/html/body"}}}, Rest: monitor.HowText},
		SizeBefore: [2]int{1366, 3000}, SizeAfter: [2]int{1366, 3048},
		Feedback: []Feedback{{Summary: "Footer year changed", Feedback: "noise"}},
	}
}

// keysOf lists the keys of a JSON object.
func keysOf(t *testing.T, raw json.RawMessage) []string {
	t.Helper()
	var m map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &m))
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

func TestCompareSendsTheProtocolBody(t *testing.T) {
	var got map[string]json.RawMessage
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "/internal/compare", r.URL.Path)
		require.Equal(t, "Bearer secret", r.Header.Get("Authorization"))
		require.Equal(t, "application/json", r.Header.Get("Content-Type"))
		body, _ := io.ReadAll(r.Body)
		require.NoError(t, json.Unmarshal(body, &got))
		_, _ = w.Write([]byte(`{"relevant":true,"importance":"high","summary":"Pro went up.",
			"items":[{"title":"Pro price","before":"$49","after":"$59","kind":"text","matches":"prices","ops":[0],"regions":[]}],
			"ignored":[{"note":"banner","reason":"not a price"}],
			"model":"gpt-5.1","input_tokens":1200,"output_tokens":80,"steps":2}`))
	}))
	defer srv.Close()

	c := New(Options{BaseURL: srv.URL + "/", Token: "secret"})
	resp, err := c.Compare(context.Background(), compareRequest())
	require.NoError(t, err)

	// Every field of CompareRequest in protocol.ts, and nothing else.
	require.ElementsMatch(t, []string{
		"run_id", "monitor_id", "user_id", "monitor", "connection_id", "model",
		"from", "to", "text", "regions", "plan", "size_before", "size_after", "feedback",
	}, keysOf(t, mustJSON(t, got)))
	require.ElementsMatch(t, []string{"name", "url", "instructions"}, keysOf(t, got["monitor"]))
	require.ElementsMatch(t, []string{"run_id", "at", "screenshot", "blocks"}, keysOf(t, got["from"]))
	require.JSONEq(t, `[{"box":[1,2,3,4],"from_box":[1,0,3,4],"kind":"changed","pixels":12,"section":"plans"}]`, string(got["regions"]))
	require.JSONEq(t, `[1366,3048]`, string(got["size_after"]))
	require.JSONEq(t, `[{"summary":"Footer year changed","feedback":"noise"}]`, string(got["feedback"]))

	require.True(t, resp.Relevant)
	require.Equal(t, "high", resp.Importance)
	require.Equal(t, "Pro went up.", resp.Summary)
	require.Equal(t, []CompareItem{{Title: "Pro price", Before: "$49", After: "$59", Kind: "text", Matches: "prices", Ops: []int{0}, Regions: []int{}}}, resp.Items)
	require.Equal(t, []changerecord.Ignored{{Note: "banner", Reason: "not a price"}}, resp.Ignored)
	require.Equal(t, 1200, resp.InputTokens)
	require.Equal(t, 2, resp.Steps)
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	require.NoError(t, err)
	return raw
}

func TestCompareSendsEmptyListsNotNull(t *testing.T) {
	var got map[string]json.RawMessage
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		require.NoError(t, json.Unmarshal(body, &got))
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	_, err := New(Options{BaseURL: srv.URL}).Compare(context.Background(), CompareRequest{})
	require.NoError(t, err)
	require.JSONEq(t, `[]`, string(got["regions"]))
	require.JSONEq(t, `[]`, string(got["feedback"]))
	require.JSONEq(t, `null`, string(got["plan"]))
	require.JSONEq(t, `null`, string(got["text"]))
}

func TestErrorAnswersCarryTheirCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":{"code":"provider_error","message":"401 from the model provider"}}`))
	}))
	defer srv.Close()

	_, err := New(Options{BaseURL: srv.URL}).Compare(context.Background(), compareRequest())
	require.Error(t, err)
	require.Equal(t, "provider_error", Code(err))
	require.Contains(t, err.Error(), "401 from the model provider")
}

func TestErrorAnswerWithoutAnEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := New(Options{BaseURL: srv.URL}).Plan(context.Background(), PlanRequest{})
	require.ErrorContains(t, err, "HTTP 500")
	require.ErrorContains(t, err, "boom")
	require.Empty(t, Code(err))
}

func TestUnreachableAndSlowAgents(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	_, err := New(Options{BaseURL: srv.URL, Timeout: 50 * time.Millisecond}).Compare(context.Background(), compareRequest())
	require.ErrorContains(t, err, "unreachable")
	require.Empty(t, Code(err))
	srv.Close()

	_, err = New(Options{BaseURL: srv.URL}).Compare(context.Background(), compareRequest())
	require.ErrorContains(t, err, "unreachable")
}

func TestInvalidJSONAnswerIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html>not json</html>`))
	}))
	defer srv.Close()
	_, err := New(Options{BaseURL: srv.URL}).Compare(context.Background(), compareRequest())
	require.ErrorContains(t, err, "decode response")
}

func TestPlanSendsTheProtocolBody(t *testing.T) {
	var got map[string]json.RawMessage
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/internal/plan", r.URL.Path)
		body, _ := io.ReadAll(r.Body)
		require.NoError(t, json.Unmarshal(body, &got))
		_, _ = w.Write([]byte(`{"sections":[{"id":"plans","name":"Pricing table","how":"both","why":"Prices.","paths":["/html/body/main"]}],
			"rest":"text","summary":"Watching the pricing table.","model":"gpt-5.1","input_tokens":900,"output_tokens":120,"steps":1}`))
	}))
	defer srv.Close()

	conn := "c0a8012e-0000-4000-8000-000000000001"
	resp, err := New(Options{BaseURL: srv.URL}).Plan(context.Background(), PlanRequest{
		RunID: "run-1", MonitorID: "mon-1", UserID: "user-1",
		Monitor:      MonitorInfo{Name: "Pricing", URL: "https://acme.test/pricing", Instructions: "Prices."},
		ConnectionID: &conn,
		Capture:      changerecord.RunRef{RunID: "run-1", Blocks: "captures/m/r1/blocks.json.gz"},
		Size:         [2]int{1366, 3000},
	})
	require.NoError(t, err)
	require.ElementsMatch(t, []string{
		"run_id", "monitor_id", "user_id", "monitor", "connection_id", "model", "capture", "size", "previous",
	}, keysOf(t, mustJSON(t, got)))
	require.JSONEq(t, `null`, string(got["previous"]))
	require.JSONEq(t, `null`, string(got["model"]))

	require.Equal(t, []monitor.WatchSection{{ID: "plans", Name: "Pricing table", How: monitor.HowBoth, Why: "Prices.", Paths: []string{"/html/body/main"}}}, resp.Sections)
	require.Equal(t, monitor.HowText, resp.Rest)
	require.Equal(t, 900, resp.InputTokens)
}
