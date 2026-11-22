package main

import (
	"bytes"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/bytedance/sonic"
	"github.com/valyala/fasthttp"
)

// jsonString encodes a Go string as a JavaScript string literal for runtime template injection.
func jsonString(v string) string {
	b, err := sonic.Marshal(v)
	if err != nil {
		return `""`
	}
	return string(b)
}

// writeJSON sends a JSON response with the provided HTTP status.
func writeJSON(ctx *fasthttp.RequestCtx, status int, data any) {
	json, err := sonic.Marshal(data)
	if err != nil {
		slog.Error("failed to marshal error message", "error", err)
		return
	}
	ctx.SetContentType("application/json")
	ctx.SetStatusCode(status)
	ctx.SetBody(json)
}

var httpClient = &http.Client{
	Timeout: 30 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// fetchTarget constructs and executes an HTTP request to a given URL.
// It handles body assignment for non-GET/HEAD methods and sets a default User-Agent if not present.
// Security or Context headers like Origin and Referer are automatically set based on the target.
func fetchTarget(target *url.URL, method string, headers map[string]string, body []byte) (*http.Response, error) {
	var reqBody io.Reader
	if method != http.MethodGet && method != http.MethodHead && len(body) > 0 {
		reqBody = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, target.String(), reqBody)
	if err != nil {
		return nil, err
	}

	ua := headers["User-Agent"]
	if ua == "" {
		ua = "watchthatsite-preview/0.3 (+https://wts.sammaji.com)"
	}
	req.Header.Set("User-Agent", ua)

	for _, name := range []string{"Accept", "Accept-Language", "Content-Type", "Authorization"} {
		if v, ok := headers[name]; ok {
			req.Header.Set(name, v)
		}
	}

	origin := fmt.Sprintf("%s://%s", target.Scheme, target.Host)
	req.Header.Set("Origin", origin)
	req.Header.Set("Referer", target.String())
	return httpClient.Do(req)
}
