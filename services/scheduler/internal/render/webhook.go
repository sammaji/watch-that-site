package render

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
)

// Webhook event names, sent as the X-WatchThatSite-Event header.
const (
	EventChange  = "change"
	EventDigest  = "digest"
	EventFailure = "failure"
)

// SignatureHeader carries Sign's output on every webhook request.
const SignatureHeader = "X-WatchThatSite-Signature"

// Webhook is the webhook body for a Change: the Change Record (version 2)
// JSON, exactly.
func Webhook(r changerecord.Record) ([]byte, error) {
	return marshalNoEscape(r)
}

// Sign returns the X-WatchThatSite-Signature value for body sent at unix
// time ts: "t={ts},v1={hex(HMAC-SHA256(secret, "{ts}.{body}"))}". The
// notifications service signs every webhook with this scheme; receivers
// recompute it and compare in constant time.
func Sign(secret string, body []byte, ts int64) string {
	t := strconv.FormatInt(ts, 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t))
	mac.Write([]byte("."))
	mac.Write(body)
	return "t=" + t + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

// marshalNoEscape is json.Marshal without HTML escaping (so "<" stays "<"),
// without the Encoder's trailing newline.
func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
