// Package agentclient calls the agent API the browser worker serves
// (AGENT_URL, bearer AGENT_TOKEN). The agent runs there because the browser
// and the model keys do; the scheduler only sends it what it found and reads
// the answer.
//
// The request and response bodies mirror CompareRequest, CompareResponse,
// PlanRequest, PlanResponse and AgentError in packages/types/src/protocol.ts.
package agentclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
)

// DefaultTimeout bounds one agent call. The agent may take several model
// turns (reading more of a page, looking at a screenshot region), so this is
// generous.
const DefaultTimeout = 150 * time.Second

// maxResponseBytes caps what is read of a response.
const maxResponseBytes = 4 << 20

// MonitorInfo is what the agent is told about the Monitor.
type MonitorInfo struct {
	Name         string `json:"name"`
	URL          string `json:"url"`
	Instructions string `json:"instructions"`
}

// Region is one changed screenshot region as the agent sees it.
type Region struct {
	// Box is where the region is on the new screenshot; for an area that
	// exists on the previous screenshot only, where it was on that one.
	Box geom.Rect `json:"box"`
	// FromBox is where the same area is on the previous screenshot, nil when
	// it exists on the new one only.
	FromBox *geom.Rect `json:"from_box"`
	Kind    string     `json:"kind"`
	Pixels  int        `json:"pixels"`
	// Section is the id of the Watch Plan Section the region lies in, ""
	// outside every Section.
	Section string `json:"section"`
}

// Feedback is the owner's verdict on one earlier Change of the Monitor.
type Feedback struct {
	Summary  string `json:"summary"`
	Feedback string `json:"feedback"` // useful | noise
}

// CompareRequest asks the agent whether a difference is a Change the owner
// asked about. The scheduler has already diffed the two Captures.
type CompareRequest struct {
	RunID        string              `json:"run_id"`
	MonitorID    string              `json:"monitor_id"`
	UserID       string              `json:"user_id"`
	Monitor      MonitorInfo         `json:"monitor"`
	ConnectionID *string             `json:"connection_id"`
	Model        *string             `json:"model"`
	From         changerecord.RunRef `json:"from"`
	To           changerecord.RunRef `json:"to"`
	// Text is the text diff. Items cite its ops by index.
	Text *changerecord.TextSection `json:"text"`
	// Regions are the changed screenshot regions. Items cite them by index.
	Regions []Region `json:"regions"`
	// Plan is the Monitor's Watch Plan, or nil.
	Plan *monitor.WatchPlan `json:"plan"`
	// SizeBefore and SizeAfter are the screenshot sizes [w, h], zero when
	// there is no screenshot.
	SizeBefore [2]int `json:"size_before"`
	SizeAfter  [2]int `json:"size_after"`
	// Feedback is the owner's feedback on recent Changes, newest first.
	Feedback []Feedback `json:"feedback"`
}

// CompareItem is one thing the agent reports as changed.
type CompareItem struct {
	Title   string `json:"title"`
	Before  string `json:"before"`
	After   string `json:"after"`
	Kind    string `json:"kind"`
	Matches string `json:"matches"`
	// Ops and Regions index CompareRequest.Text.Ops and
	// CompareRequest.Regions.
	Ops     []int `json:"ops"`
	Regions []int `json:"regions"`
}

// CompareResponse is the agent's answer.
type CompareResponse struct {
	// Relevant: the difference matches what the owner asked to be told about.
	Relevant   bool   `json:"relevant"`
	Importance string `json:"importance"`
	// Summary is one sentence, written for the owner.
	Summary      string                 `json:"summary"`
	Items        []CompareItem          `json:"items"`
	Ignored      []changerecord.Ignored `json:"ignored"`
	Model        string                 `json:"model"`
	InputTokens  int                    `json:"input_tokens"`
	OutputTokens int                    `json:"output_tokens"`
	Steps        int                    `json:"steps"`
}

// PlanRequest asks the agent to divide a page into Sections and say how each
// should be watched.
type PlanRequest struct {
	RunID        string      `json:"run_id"`
	MonitorID    string      `json:"monitor_id"`
	UserID       string      `json:"user_id"`
	Monitor      MonitorInfo `json:"monitor"`
	ConnectionID *string     `json:"connection_id"`
	Model        *string     `json:"model"`
	// Capture is the Capture to plan from.
	Capture changerecord.RunRef `json:"capture"`
	// Size is the screenshot size [w, h], zero when there is none.
	Size [2]int `json:"size"`
	// Load is how the page loaded for this Capture, for deciding the wait.
	Load *PlanLoad `json:"load"`
	// Previous is the plan being replaced, so Section ids and the owner's
	// own choices carry over.
	Previous *monitor.WatchPlan `json:"previous"`
}

// PlanLoad is how a Capture's page loaded (PlanLoad in protocol.ts).
type PlanLoad struct {
	LoadMS        int  `json:"load_ms"`
	SettleMS      int  `json:"settle_ms"`
	NetworkQuiet  bool `json:"network_quiet"`
	Stable        bool `json:"stable"`
	MovingRegions int  `json:"moving_regions"`
	WaitMS        int  `json:"wait_ms"`
}

// PlanResponse is the agent's plan.
type PlanResponse struct {
	Sections     []monitor.WatchSection `json:"sections"`
	Rest         monitor.WatchHow       `json:"rest"`
	Summary      string                 `json:"summary"`
	WaitMS       int                    `json:"wait_ms"`
	Model        string                 `json:"model"`
	InputTokens  int                    `json:"input_tokens"`
	OutputTokens int                    `json:"output_tokens"`
	Steps        int                    `json:"steps"`
}

// Error is an error answer of the agent API.
type Error struct {
	// Status is the HTTP status.
	Status int
	// Code is no_connection, provider_error, bad_request, not_found,
	// unauthorized or internal_error.
	Code    string
	Message string
}

func (e *Error) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("agent API answered HTTP %d: %s", e.Status, e.Message)
	}
	return fmt.Sprintf("agent API: %s: %s", e.Code, e.Message)
}

// Reason is what a person should read about a failed agent call: the
// agent's own message when it gave one (written for the owner, e.g. "Your
// WatchThatSite credit is used up. …"), otherwise the error itself.
func Reason(err error) string {
	var e *Error
	if errors.As(err, &e) && e.Code != "" && e.Message != "" {
		return e.Message
	}
	return err.Error()
}

// Code returns the agent API's error code for err, or "" when err is not an
// agent API error (the agent could not be reached at all, say).
func Code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// Client calls the agent API.
type Client struct {
	baseURL string
	token   string
	timeout time.Duration
	http    *http.Client
}

// Options configures a Client.
type Options struct {
	// BaseURL is the agent API's origin, e.g. http://127.0.0.1:5220.
	BaseURL string
	// Token is sent as a bearer token.
	Token string
	// Timeout bounds one call; zero means DefaultTimeout.
	Timeout time.Duration
	// HTTP is the client to use; nil means a default one.
	HTTP *http.Client
}

// New builds a Client.
func New(opts Options) *Client {
	c := &Client{
		baseURL: strings.TrimRight(opts.BaseURL, "/"),
		token:   opts.Token,
		timeout: opts.Timeout,
		http:    opts.HTTP,
	}
	if c.timeout <= 0 {
		c.timeout = DefaultTimeout
	}
	if c.http == nil {
		// The agent API is a Node server, which closes an idle connection
		// after a few seconds. Reusing one it has just closed fails the
		// request, so idle connections are dropped well before that.
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.IdleConnTimeout = 2 * time.Second
		c.http = &http.Client{Transport: transport}
	}
	return c
}

// Compare asks the agent about a difference between two Captures.
func (c *Client) Compare(ctx context.Context, req CompareRequest) (CompareResponse, error) {
	if req.Regions == nil {
		req.Regions = []Region{}
	}
	if req.Feedback == nil {
		req.Feedback = []Feedback{}
	}
	var resp CompareResponse
	if err := c.post(ctx, "/internal/compare", req, &resp); err != nil {
		return CompareResponse{}, err
	}
	return resp, nil
}

// Plan asks the agent for a Watch Plan of one Capture.
func (c *Client) Plan(ctx context.Context, req PlanRequest) (PlanResponse, error) {
	var resp PlanResponse
	if err := c.post(ctx, "/internal/plan", req, &resp); err != nil {
		return PlanResponse{}, err
	}
	return resp, nil
}

func (c *Client) post(ctx context.Context, path string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("agent API: encode request: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("agent API: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("agent API unreachable: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("agent API: read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		apiErr := &Error{Status: resp.StatusCode}
		var envelope struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &envelope) == nil && envelope.Error.Code != "" {
			apiErr.Code, apiErr.Message = envelope.Error.Code, envelope.Error.Message
		} else {
			apiErr.Message = truncate(strings.TrimSpace(string(raw)), 300)
		}
		return apiErr
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("agent API: decode response: %w", err)
	}
	return nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
