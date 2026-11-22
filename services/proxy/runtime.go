package main

import (
	_ "embed"
	"log/slog"
	"net/url"
	"strings"

	"github.com/tdewolff/minify/v2"
	"github.com/tdewolff/minify/v2/css"
	"github.com/tdewolff/minify/v2/html"
	"github.com/tdewolff/minify/v2/js"
)

// PreviewEventType defines a specific category of preview events.
type PreviewEventType string

const (
	previewSelectionType       PreviewEventType = "msg:selection"
	previewReadyType           PreviewEventType = "msg:preview-ready"
	previewSetModeType         PreviewEventType = "msg:set-mode"
	previewSetScaleType        PreviewEventType = "msg:set-scale"
	previewModeChangedType     PreviewEventType = "msg:mode-changed"
	previewRecordEventType     PreviewEventType = "msg:record-event"
	previewSetInitialStateType PreviewEventType = "msg:set-initial-state"
	previewReplayDoneType      PreviewEventType = "msg:replay-done"
)

//go:embed runtime.html
var runtimeHTMLSource string

//go:embed runtime.js
var runtimeJSSource string

var (
	minifiedHTML       string
	minifiedJSTemplate string
)

func init() {
	m := minify.New()
	m.AddFunc("text/html", html.Minify)
	m.AddFunc("text/css", css.Minify)
	m.AddFunc("application/javascript", js.Minify)

	var err error
	minifiedHTML, err = m.String("text/html", runtimeHTMLSource)
	if err != nil {
		slog.Error("failed to minify runtime HTML", "error", err)
		minifiedHTML = runtimeHTMLSource
	}

	minifiedJSTemplate, err = m.String("application/javascript", runtimeJSSource)
	if err != nil {
		slog.Error("failed to minify runtime JS", "error", err)
		minifiedJSTemplate = runtimeJSSource
	}
}

// previewRuntime renders the injected browser runtime with target URL, message types, and proxy prefix bound.
func previewRuntime(target *url.URL, record bool) string {
	recordFlag := "false"
	if record {
		recordFlag = "true"
	}
	script := strings.NewReplacer(
		"__CURRENT_TARGET__", jsonString(target.String()),
		"__SELECTION_TYPE__", jsonString(string(previewSelectionType)),
		"__READY_TYPE__", jsonString(string(previewReadyType)),
		"__SET_MODE_TYPE__", jsonString(string(previewSetModeType)),
		"__SET_SCALE_TYPE__", jsonString(string(previewSetScaleType)),
		"__MODE_CHANGED_TYPE__", jsonString(string(previewModeChangedType)),
		"__RECORD_EVENT_TYPE__", jsonString(string(previewRecordEventType)),
		"__SET_INITIAL_STATE_TYPE__", jsonString(string(previewSetInitialStateType)),
		"__REPLAY_DONE_TYPE__", jsonString(string(previewReplayDoneType)),
		"__RECORD__", recordFlag,
		"__PROXY_PREFIX__", jsonString(apiProxyPrefix),
	).Replace(minifiedJSTemplate)
	return minifiedHTML + "<script>" + script + "</script>"
}
