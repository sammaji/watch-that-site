package main

import (
	"net/url"
	"strings"
	"testing"
)

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestGetProxyPathUsesShortPrefix(t *testing.T) {
	target := mustURL(t, "https://example.com/assets/app.css?v=1")
	got := getProxyPath(target)
	want := "/api/v1/proxy/https/example.com/assets/app.css?v=1"
	if got != want {
		t.Fatalf("getProxyPath() = %q, want %q", got, want)
	}
}

func TestGetProxyPathOmitsRootSlash(t *testing.T) {
	target := mustURL(t, "https://example.com/")
	got := getProxyPath(target)
	want := "/api/v1/proxy/https/example.com"
	if got != want {
		t.Fatalf("getProxyPath() = %q, want %q", got, want)
	}
}

func TestRewriteHTMLDocumentInjectsRuntimeAndRewritesAssets(t *testing.T) {
	target := mustURL(t, "https://example.com/docs/page.html")
	out, err := rewriteHTMLDocument(`<!doctype html><html><head><title>x</title><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head><body><a href="/next">Next</a><img src="image.png" srcset="small.png 1x, /large.png 2x"><script src="/app.js" integrity="sha256-test" crossorigin="anonymous"></script></body></html>`, target, false)
	if err != nil {
		t.Fatal(err)
	}

	for _, want := range []string{
		"msg:selection",
		`/api/v1/proxy/https/example.com/next`,
		`/api/v1/proxy/https/example.com/docs/image.png`,
		`/api/v1/proxy/https/example.com/docs/small.png 1x`,
		`/api/v1/proxy/https/example.com/large.png 2x`,
		`/api/v1/proxy/https/example.com/app.js`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("rewritten html does not contain %q:\n%s", want, out)
		}
	}

	for _, forbidden := range []string{"Content-Security-Policy", "integrity=", "crossorigin="} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("rewritten html still contains %q:\n%s", forbidden, out)
		}
	}
}

func TestRecordRequested(t *testing.T) {
	if !recordRequested("foo=1&record=true&bar=2") {
		t.Fatalf("recordRequested = false, want true")
	}
	if recordRequested("q=search") {
		t.Fatalf("recordRequested = true, want false")
	}
}

func TestRewriteHTMLDocumentRecordingInjectsRecordType(t *testing.T) {
	target := mustURL(t, "https://example.com/")
	out, err := rewriteHTMLDocument(`<!doctype html><html><head></head><body></body></html>`, target, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"msg:record-event", "true"} {
		if !strings.Contains(out, want) {
			t.Fatalf("recording runtime missing %q", want)
		}
	}
}

func TestRewriteCSSURLs(t *testing.T) {
	target := mustURL(t, "https://example.com/assets/main.css")
	got := rewriteCSSURLs(`.a{background:url("../img/bg.png")} .b{background:url(data:image/png;base64,abc)}`, target)
	want := `.a{background:url("/api/v1/proxy/https/example.com/img/bg.png")} .b{background:url(data:image/png;base64,abc)}`
	if got != want {
		t.Fatalf("rewriteCSSURLs() = %q, want %q", got, want)
	}
}
