// Package render turns a Change Record into every notification surface:
// email HTML and text, Slack Block Kit, Discord embeds, Telegram HTML, the
// signed webhook body, digests, and the "keeps failing" alert. Every Channel
// leads with the agent's summary sentence, then the first items as
// before → after, then the link to the Change.
//
// Every function here is pure: no I/O, no clock. Callers pass the signed
// image URLs in Links.
package render

import (
	"net/url"
	"strings"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
)

// Links carries the URLs a rendered notification points at.
type Links struct {
	// WebURL is the web app's origin, e.g. "https://app.wts.sammaji.com".
	WebURL string
	// CropURL is the signed before/after crop of the first visual region; it
	// may be empty.
	CropURL string
	// DiffImageURL is the signed annotated diff image; it may be empty.
	DiffImageURL string
}

func (l Links) base() string { return strings.TrimRight(l.WebURL, "/") }

// ChangeURL is the Change view: {WebURL}/changes/{id}.
func (l Links) ChangeURL(changeID string) string {
	return l.base() + "/changes/" + url.PathEscape(changeID)
}

// MonitorURL is the Monitor page: {WebURL}/monitors/{id}.
func (l Links) MonitorURL(monitorID string) string {
	return l.base() + "/monitors/" + url.PathEscape(monitorID)
}

// ViewURL is the "View change" action.
func (l Links) ViewURL(r changerecord.Record) string { return l.ChangeURL(r.ID) }

// NoiseURL is the "This was Noise" action.
func (l Links) NoiseURL(r changerecord.Record) string {
	return l.ChangeURL(r.ID) + "?feedback=noise"
}

// PauseURL is the "Pause" action: the Monitor page, asking to pause it.
func (l Links) PauseURL(r changerecord.Record) string {
	return l.MonitorURL(r.Monitor.ID) + "?pause=1"
}

// Image is the image a notification shows: the crop when present, else the
// diff image, else "".
func (l Links) Image() string {
	if l.CropURL != "" {
		return l.CropURL
	}
	return l.DiffImageURL
}
