package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/valyala/fasthttp"
)

func testRouter() fasthttp.RequestHandler {
	return newHandler()
}

func newTestRequest(t *testing.T, method, uri string) *fasthttp.Request {
	t.Helper()
	req := fasthttp.AcquireRequest()
	req.Header.SetMethod(method)
	req.SetRequestURI(uri)
	return req
}

func executeRequest(t *testing.T, handler fasthttp.RequestHandler, req *fasthttp.Request) *fasthttp.Response {
	t.Helper()
	var ctx fasthttp.RequestCtx
	ctx.Init(req, nil, nil)
	handler(&ctx)

	resp := fasthttp.AcquireResponse()
	ctx.Response.CopyTo(resp)
	return resp
}

func requireStatus(t *testing.T, resp *fasthttp.Response, want int) {
	t.Helper()
	if got := resp.StatusCode(); got != want {
		t.Fatalf("status = %d, want %d, body = %s", got, want, resp.Body())
	}
}

func TestAPIKeyMiddlewareRejectsUnauthorizedRequests(t *testing.T) {
	t.Setenv("PROXY_API_KEY", "secret")

	for _, tc := range []struct {
		name string
		uri  string
	}{
		{name: "health", uri: "/health"},
		{name: "proxy", uri: apiProxyPrefix + "/https/example.com"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := newTestRequest(t, http.MethodGet, tc.uri)
			defer fasthttp.ReleaseRequest(req)

			resp := executeRequest(t, testRouter(), req)
			defer fasthttp.ReleaseResponse(resp)

			requireStatus(t, resp, http.StatusUnauthorized)
			if got := string(resp.Header.Peek("WWW-Authenticate")); got != "ApiKey" {
				t.Fatalf("WWW-Authenticate = %q, want %q", got, "ApiKey")
			}
		})
	}
}

func TestAPIKeyMiddlewareRejectsMissingConfiguration(t *testing.T) {
	t.Setenv("PROXY_API_KEY", "")

	req := newTestRequest(t, http.MethodGet, "/health")
	defer fasthttp.ReleaseRequest(req)

	resp := executeRequest(t, testRouter(), req)
	defer fasthttp.ReleaseResponse(resp)

	requireStatus(t, resp, http.StatusServiceUnavailable)
}

func TestProxyHandlerRewritesHTML(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_TARGETS", "true")
	t.Setenv("PROXY_API_KEY", "secret")
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/page" {
			t.Fatalf("path = %q, want /page", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><head></head><body><a href="/next">Next</a></body></html>`))
	}))
	defer target.Close()

	host := strings.TrimPrefix(target.URL, "http://")
	req := newTestRequest(t, http.MethodGet, apiProxyPrefix+"/http/"+host+"/page")
	defer fasthttp.ReleaseRequest(req)
	req.Header.Set(apiKeyHeader, "secret")

	resp := executeRequest(t, testRouter(), req)
	defer fasthttp.ReleaseResponse(resp)

	requireStatus(t, resp, http.StatusOK)
	body := string(resp.Body())
	if !strings.Contains(body, "msg:preview-ready") {
		t.Fatalf("runtime was not injected:\n%s", body)
	}
	if !strings.Contains(body, apiProxyPrefix+"/http/"+host+"/next") {
		t.Fatalf("link was not rewritten through proxy:\n%s", body)
	}
}

func TestProxyHandlerRewritesRedirectLocation(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_TARGETS", "true")
	t.Setenv("PROXY_API_KEY", "secret")
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/login", http.StatusFound)
	}))
	defer target.Close()

	host := strings.TrimPrefix(target.URL, "http://")
	req := newTestRequest(t, http.MethodGet, apiProxyPrefix+"/http/"+host+"/start")
	defer fasthttp.ReleaseRequest(req)
	req.Header.Set(apiKeyHeader, "secret")

	resp := executeRequest(t, testRouter(), req)
	defer fasthttp.ReleaseResponse(resp)

	requireStatus(t, resp, http.StatusFound)
	location := string(resp.Header.Peek("Location"))
	want := apiProxyPrefix + "/http/" + host + "/login"
	if location != want {
		t.Fatalf("%s", fmt.Sprintf("Location = %q, want %q", location, want))
	}
}

func TestProxyHandlerPassesThroughResponseHeaders(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_TARGETS", "true")
	t.Setenv("PROXY_API_KEY", "secret")
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("ETag", "abc123")
		w.Header().Set("Vary", "Accept-Encoding")
		w.Header().Set("Content-Security-Policy", "default-src 'self'")
		w.Header().Set("X-Frame-Options", "DENY")
		_, _ = w.Write([]byte("ok"))
	}))
	defer target.Close()

	host := strings.TrimPrefix(target.URL, "http://")
	req := newTestRequest(t, http.MethodGet, apiProxyPrefix+"/http/"+host)
	defer fasthttp.ReleaseRequest(req)
	req.Header.Set(apiKeyHeader, "secret")

	resp := executeRequest(t, testRouter(), req)
	defer fasthttp.ReleaseResponse(resp)

	requireStatus(t, resp, http.StatusOK)
	if got := string(resp.Header.Peek("ETag")); got != "abc123" {
		t.Fatalf("ETag = %q, want %q", got, "abc123")
	}
	if got := string(resp.Header.Peek("Vary")); got != "Accept-Encoding" {
		t.Fatalf("Vary = %q, want %q", got, "Accept-Encoding")
	}
	if got := string(resp.Header.Peek("Content-Security-Policy")); got != "" {
		t.Fatalf("Content-Security-Policy = %q, want empty", got)
	}
	if got := string(resp.Header.Peek("X-Frame-Options")); got != "" {
		t.Fatalf("X-Frame-Options = %q, want empty", got)
	}
	if body := string(resp.Body()); body != "ok" {
		t.Fatalf("body = %q, want %q", body, "ok")
	}
}
