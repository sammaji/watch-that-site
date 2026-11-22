package normalize

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

var captureDate = time.Date(2026, time.September, 27, 10, 0, 0, 0, time.UTC)

func defaultOpts() Options { return Options{CaptureDate: captureDate} }

// masks normalizes one block and returns its masked spans as "class:display".
func masks(t *testing.T, text string, opts Options) []string {
	t.Helper()
	out := Normalize([]capture.Block{{ID: "b1", Path: "/html/body/p[1]", Tag: "p", Text: text}}, opts)
	require.Len(t, out, 1)
	var got []string
	for _, tok := range out[0].Tokens {
		if tok.Kind == diff.TokenMask {
			got = append(got, tok.Mask+":"+tok.Display)
		}
	}
	return got
}

func TestMaskClasses(t *testing.T) {
	cases := []struct {
		name string
		text string
		date *time.Time
		want []string
	}{
		// reltime
		{name: "reltime minutes ago", text: "Updated 3 minutes ago", want: []string{"reltime:3 minutes ago"}},
		{name: "reltime just now", text: "Posted just now by Ann", want: []string{"reltime:just now"}},
		{name: "reltime yesterday", text: "Yesterday at the office", want: []string{"reltime:Yesterday"}},
		{name: "reltime in 2 hours", text: "Sale ends in 2 hours", want: []string{"reltime:in 2 hours"}},
		{name: "reltime 5m ago", text: "edited 5m ago", want: []string{"reltime:5m ago"}},
		{name: "reltime 2 hrs ago", text: "2 hrs ago", want: []string{"reltime:2 hrs ago"}},
		{name: "reltime an hour ago", text: "an hour ago", want: []string{"reltime:an hour ago"}},
		{name: "reltime negative duration", text: "Bake for 3 minutes", want: nil},
		{name: "reltime negative in year", text: "Founded in 2024", want: nil},
		{name: "reltime negative ago word", text: "Long ago in a galaxy", want: nil},

		// clock
		{name: "clock 24h", text: "Last check 14:03", want: []string{"clock:14:03"}},
		{name: "clock 12h pm", text: "Opens 2:03 PM daily", want: []string{"clock:2:03 PM"}},
		{name: "clock seconds tz", text: "At 14:03:22 UTC", want: []string{"clock:14:03:22 UTC"}},
		{name: "clock negative aspect ratio", text: "Aspect 16:9 widescreen", want: nil},
		{name: "clock negative invalid hour", text: "Score 25:61", want: nil},

		// today
		{name: "today iso", text: "Published 2026-09-27", want: []string{"today:2026-09-27"}},
		{name: "today us written", text: "Sep 27, 2026 edition", want: []string{"today:Sep 27, 2026"}},
		{name: "today eu written", text: "27 September 2026", want: []string{"today:27 September 2026"}},
		{name: "today us numeric", text: "as of 9/27/2026", want: []string{"today:9/27/2026"}},
		{name: "today eu numeric", text: "as of 27/09/2026", want: []string{"today:27/09/2026"}},
		{name: "today no year", text: "Deals for September 27", want: []string{"today:September 27"}},
		{name: "today weekday", text: "Sunday, September 27, 2026", want: []string{"today:Sunday, September 27, 2026"}},
		{name: "today negative other day", text: "Sep 26, 2026", want: nil},
		{name: "today negative other year", text: "September 27, 2025", want: nil},
		{name: "today negative iso other day", text: "2026-09-28", want: nil},
		{name: "today off without capture date", text: "2026-09-27", date: &time.Time{}, want: nil},
		{name: "today on the other capture date", text: "2026-09-26 and 2026-09-27",
			date: ptr(time.Date(2026, 9, 26, 23, 0, 0, 0, time.UTC)), want: []string{"today:2026-09-26"}},

		// counter
		{name: "counter views", text: "1,234 views", want: []string{"counter:1,234 views"}},
		{name: "counter people looking", text: "12 people are looking at this", want: []string{"counter:12 people are looking at this"}},
		{name: "counter comments", text: "38 comments", want: []string{"counter:38 comments"}},
		{name: "counter nav label", text: "Inbox (38)", want: []string{"counter:(38)"}},
		{name: "counter k suffix", text: "1.2k likes", want: []string{"counter:1.2k likes"}},
		{name: "counter items default", text: "3 items", want: []string{"counter:3 items"}},
		{name: "counter negative plain noun", text: "5 bedrooms and 2 baths", want: nil},
		{name: "counter negative paren without label", text: "Chapter (38)", want: nil},
		{name: "counter negative stock", text: "Only 3 items left", want: nil},
		{name: "counter negative in stock", text: "12 items in stock", want: nil},
		{name: "counter whole block", text: "1,234 views", want: []string{"counter:1,234 views"}},

		// nonce
		{name: "nonce ver param", text: "style.css?ver=6.4.2", want: []string{"nonce:?ver=6.4.2"}},
		{name: "nonce v param", text: "app.js?v=1695812345", want: []string{"nonce:?v=1695812345"}},
		{name: "nonce cache buster", text: "img.png?cb=abc123&size=2", want: []string{"nonce:?cb=abc123"}},
		{name: "nonce csrf token", text: "csrf_token: 9f8A7b6C5d4E3f2A", want: []string{"nonce:csrf_token: 9f8A7b6C5d4E3f2A"}},
		{name: "nonce hex id", text: "build 3fa9c1d2e4b5a6c7d8 ok", want: []string{"nonce:3fa9c1d2e4b5a6c7d8"}},
		{name: "nonce base64 id", text: "session aB3dE5fG7hJ9kL1mN3pQ", want: []string{"nonce:aB3dE5fG7hJ9kL1mN3pQ"}},
		{name: "nonce uuid", text: "req 123e4567-e89b-12d3-a456-426614174000", want: []string{"nonce:123e4567-e89b-12d3-a456-426614174000"}},
		{name: "nonce negative youtube id", text: "watch?v=dQw4w9WgXcQ", want: nil},
		{name: "nonce negative long word", text: "Incomprehensibilities abound", want: nil},
		{name: "nonce negative long number", text: "Order 1234567890123456", want: nil},
		{name: "nonce negative sku", text: "SKU ABC-12345-XYZ-678", want: nil},

		// copyright
		{name: "copyright symbol", text: "© 2026 Acme Inc.", want: []string{"copyright:© 2026"}},
		{name: "copyright range", text: "Copyright 2025-2026 Acme", want: []string{"copyright:Copyright 2025-2026"}},
		{name: "copyright word and symbol", text: "Copyright © 2026", want: []string{"copyright:Copyright © 2026"}},
		{name: "copyright negative no year", text: "© Acme Inc.", want: nil},
		{name: "copyright negative prose", text: "Copyright law in 2026", want: nil},

		// currency is never masked
		{name: "currency dollar", text: "$49.99", want: nil},
		{name: "currency dollar with reltime", text: "$49.99 updated 3 minutes ago", want: []string{"reltime:3 minutes ago"}},
		{name: "currency code suffix", text: "1,234 USD views", want: nil},
		{name: "currency euro spaced", text: "€ 1.234 likes", want: nil},
		{name: "currency code prefix", text: "EUR 38 comments", want: nil},

		// overlaps
		{name: "overlap longest wins", text: "at 14:03 UTC", want: []string{"clock:14:03 UTC"}},
		{name: "several classes in one block", text: "© 2026 · 14:03 · 38 comments",
			want: []string{"copyright:© 2026", "clock:14:03", "counter:38 comments"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := Options{CaptureDate: captureDate}
			if tc.date != nil {
				opts.CaptureDate = *tc.date
			}
			require.Equal(t, tc.want, masks(t, tc.text, opts))
		})
	}
}

func ptr[T any](v T) *T { return &v }

func TestCanonicalize(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"nbsp", "a\u00a0b", "a b"},
		{"narrow nbsp and em space", "a\u202fb\u2003c", "a b c"},
		{"zero width space", "ab\u200bc", "abc"},
		{"zero width joiners and bom", "\ufeffa\u200cb\u200dc\u2060d", "abcd"},
		{"soft hyphen", "co\u00adoperate", "cooperate"},
		{"collapse and trim", "  a \n\t b  ", "a b"},
		{"nfkc ligature", "ﬁle", "file"},
		{"nfkc fullwidth", "ＡＢＣ１２３", "ABC123"},
		{"only invisible", "\u200b\u00ad ", ""},
		{"quotes kept", "don’t — stop", "don’t — stop"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, Canonicalize(tc.in))
		})
	}
}

func TestNormalizeBlocks(t *testing.T) {
	norm1 := func(text string, opts Options) diff.NBlock {
		out := Normalize([]capture.Block{{ID: "b", Path: "/p", Tag: "p", Text: text}}, opts)
		require.Len(t, out, 1)
		return out[0]
	}

	t.Run("nbsp and space compare equal", func(t *testing.T) {
		require.Equal(t, norm1("Price\u00a0list", defaultOpts()).Compare, norm1("Price list", defaultOpts()).Compare)
	})
	t.Run("zero width stripped in compare", func(t *testing.T) {
		require.Equal(t, "Hello world", norm1("Hel\u200blo world", defaultOpts()).Compare)
	})
	t.Run("soft hyphen stripped in compare", func(t *testing.T) {
		require.Equal(t, "cooperate", norm1("co\u00adoperate", defaultOpts()).Compare)
	})
	t.Run("quotes and dashes folded in compare not display", func(t *testing.T) {
		b := norm1("“Don’t” — stop…", defaultOpts())
		require.Equal(t, `"Don't" - stop...`, b.Compare)
		require.Equal(t, "“Don’t” — stop…", b.Display)
	})
	t.Run("display keeps original with collapsed whitespace", func(t *testing.T) {
		b := norm1("  Updated\n  3 minutes ago ", defaultOpts())
		require.Equal(t, "Updated 3 minutes ago", b.Display)
		require.Equal(t, "Updated ⟨reltime⟩", b.Compare)
		require.Equal(t, []string{"reltime"}, b.Masked)
	})
	t.Run("masked classes sorted unique", func(t *testing.T) {
		b := norm1("3 minutes ago, 14:03, 5 hours ago, 38 comments", defaultOpts())
		require.Equal(t, []string{"clock", "counter", "reltime"}, b.Masked)
	})
	t.Run("masked timestamps compare equal", func(t *testing.T) {
		require.Equal(t, norm1("Updated 3 minutes ago", defaultOpts()).Compare, norm1("Updated 7 minutes ago", defaultOpts()).Compare)
	})
	t.Run("mask token is one token", func(t *testing.T) {
		b := norm1("x 12 people are looking at this", defaultOpts())
		last := b.Tokens[len(b.Tokens)-1]
		require.Equal(t, diff.Token{Display: "12 people are looking at this", Compare: "⟨counter⟩", Mask: "counter", Kind: diff.TokenMask}, last)
	})
	t.Run("price kept as number token", func(t *testing.T) {
		b := norm1("Now $49.99", defaultOpts())
		require.Equal(t, "Now $49.99", b.Compare)
		require.Empty(t, b.Masked)
	})
}

func TestNormalizeStructure(t *testing.T) {
	blocks := []capture.Block{
		{ID: "a", Path: "/html/body/div[1]", Tag: "div", Text: "First", Rect: geom.Rect{1, 2, 3, 4}},
		{ID: "b", Path: "/html/body/div[2]", Tag: "div", Text: " \u200b\u00a0 "},
		{ID: "c", Path: "/html/body/div[3]", Tag: "h1", Text: "Third"},
	}
	out := Normalize(blocks, defaultOpts())
	require.Len(t, out, 2)
	require.Equal(t, "a", out[0].ID)
	require.Equal(t, "/html/body/div[1]", out[0].Path)
	require.Equal(t, "div", out[0].Tag)
	require.Equal(t, geom.Rect{1, 2, 3, 4}, out[0].Rect)
	require.Equal(t, "c", out[1].ID)
	require.Equal(t, "h1", out[1].Tag)
	require.Empty(t, Normalize(nil, defaultOpts()))
}

func TestIgnoreMarksBlocksByPath(t *testing.T) {
	blocks := []capture.Block{
		{ID: "a", Path: "/html/body/main/p[1]", Tag: "p", Text: "Pro plan $49/month"},
		{ID: "b", Path: "/html/body/aside/p[1]", Tag: "p", Text: "What our customers say"},
	}
	out := Normalize(blocks, Options{CaptureDate: captureDate, Ignore: func(path string) bool {
		return path == "/html/body/aside/p[1]"
	}})
	require.Len(t, out, 2)
	require.False(t, out[0].Ignored)
	require.True(t, out[1].Ignored)
	// An ignored block is still normalized, so it can be aligned and shown.
	require.Equal(t, "What our customers say", out[1].Compare)

	for _, b := range Normalize(blocks, defaultOpts()) {
		require.False(t, b.Ignored, "nothing is ignored without an Ignore function")
	}
}

func TestTokenInvariants(t *testing.T) {
	out := Normalize(benchBlocks(40), defaultOpts())
	require.Len(t, out, 40)
	for _, b := range out {
		var cmp, disp string
		for _, tok := range b.Tokens {
			cmp += tok.Compare
			disp += tok.Display
		}
		require.Equal(t, b.Compare, cmp, b.Display)
		require.Equal(t, Canonicalize(b.Display), disp)
	}
}

func benchBlocks(n int) []capture.Block {
	texts := []string{
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.",
		"Updated 3 minutes ago by the editorial team",
		"Now $49.99 — was $59.99. Only 3 items left in stock!",
		"© 2026 Example Corp. All rights reserved.",
		"Sunday, September 27, 2026 at 14:03 UTC",
		"1,234 views · 38 comments · Inbox (12)",
		"<script src=\"/app.js?ver=6.4.2\"></script> session aB3dE5fG7hJ9kL1mN3pQ",
		"Products",
		"The quick brown fox jumps over the lazy dog while 12 people are looking at this",
		"Terms of Service",
	}
	blocks := make([]capture.Block, n)
	for i := range blocks {
		blocks[i] = capture.Block{
			ID:   fmt.Sprintf("b%d", i),
			Path: fmt.Sprintf("/html/body/div[%d]/p", i),
			Tag:  "p",
			Text: texts[i%len(texts)],
		}
	}
	return blocks
}

func BenchmarkNormalize5000(b *testing.B) {
	blocks := benchBlocks(5000)
	opts := Options{CaptureDate: captureDate, Ignore: func(path string) bool {
		return strings.HasPrefix(path, "/html/body/footer")
	}}
	b.ReportAllocs()
	for b.Loop() {
		Normalize(blocks, opts)
	}
}
