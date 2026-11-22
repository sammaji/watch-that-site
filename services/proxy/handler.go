package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/valyala/fasthttp"
)

var strippedResponseHeaders = map[string]struct{}{
	"Connection":                          {},
	"Content-Length":                      {},
	"Content-Security-Policy":             {},
	"Content-Security-Policy-Report-Only": {},
	"Keep-Alive":                          {},
	"Proxy-Connection":                    {},
	"Set-Cookie":                          {},
	"Transfer-Encoding":                   {},
	"X-Frame-Options":                     {},
}

// healthHandler returns a lightweight readiness response for load balancers and local checks.
func healthHandler(ctx *fasthttp.RequestCtx) {
	writeJSON(ctx, fasthttp.StatusOK, map[string]string{"status": "ok", "time": time.Now().UTC().Format(time.RFC3339)})
}

// notFoundHandler returns a JSON 404 for routes outside the proxy surface.
func notFoundHandler(ctx *fasthttp.RequestCtx) {
	writeJSON(ctx, fasthttp.StatusNotFound, map[string]string{"error": "not found"})
}

// proxyHandler fetches a target URL, rewrites previewable documents, and streams other assets through unchanged.
func proxyHandler(ctx *fasthttp.RequestCtx) {
	scheme, _ := ctx.UserValue("scheme").(string)
	host, _ := ctx.UserValue("host").(string)
	path, _ := ctx.UserValue("path").(string)

	query := string(ctx.QueryArgs().QueryString())
	record := recordRequested(query)
	target, err := buildTargetURL(scheme, host, path, query)
	if err != nil {
		writeJSON(ctx, fasthttp.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	method := string(ctx.Method())
	body := ctx.PostBody()

	headers := map[string]string{}
	for k, v := range ctx.Request.Header.All() {
		headers[string(k)] = string(v)
	}

	resp, err := fetchTarget(target, method, headers, body)
	if err != nil {
		slog.Error("fetch failed", "url", target.String(), "err", err)
		writeJSON(ctx, fasthttp.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		writeJSON(ctx, fasthttp.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}

	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}

	ctx.SetStatusCode(resp.StatusCode)
	ctx.Response.Header.Set("Cache-Control", "no-store")
	copyResponseHeaders(ctx, resp, target)

	if strings.Contains(ct, "text/html") {
		out, err := rewriteHTMLDocument(string(respBytes), target, record)
		if err != nil {
			slog.Error("html rewrite failed", "err", err)
			writeJSON(ctx, fasthttp.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		ctx.SetContentType("text/html; charset=utf-8")
		ctx.SetBodyString(out)
		return
	}

	if strings.Contains(ct, "text/css") {
		out := rewriteCSSURLs(string(respBytes), target)
		ctx.SetContentType(ct)
		ctx.SetBodyString(out)
		return
	}

	ctx.SetContentType(ct)
	ctx.SetBody(respBytes)
}

// pass response headers through unless we know they break embedding or proxying.
func copyResponseHeaders(ctx *fasthttp.RequestCtx, resp *http.Response, target *url.URL) {
	for name, values := range resp.Header {
		if _, stripped := strippedResponseHeaders[http.CanonicalHeaderKey(name)]; stripped {
			continue
		}

		if strings.EqualFold(name, "Location") {
			continue
		}

		for _, value := range values {
			ctx.Response.Header.Add(name, value)
		}
	}

	if location := resp.Header.Get("Location"); location != "" {
		if proxied, ok := rewriteProxyAttr(location, target); ok {
			ctx.Response.Header.Set("Location", proxied)
		} else {
			ctx.Response.Header.Set("Location", location)
		}
	}
}
