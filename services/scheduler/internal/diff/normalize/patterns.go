package normalize

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// MaskVersion versions the built-in volatile-token library below. Bump it
// whenever a pattern changes what it masks, so stored evidence can say which
// library produced it.
const MaskVersion = 1

// Volatile-token classes.
const (
	ClassReltime   = "reltime"
	ClassClock     = "clock"
	ClassToday     = "today"
	ClassCounter   = "counter"
	ClassNonce     = "nonce"
	ClassCopyright = "copyright"
)

// classPriority breaks ties between matches that start at the same offset
// and have the same length: lower wins.
var classPriority = map[string]int{
	ClassNonce:     1,
	ClassToday:     2,
	ClassClock:     3,
	ClassReltime:   4,
	ClassCounter:   5,
	ClassCopyright: 6,
}

// pattern is one compiled masking (or protecting) regex with cheap
// prefilters, so most blocks never reach the regex engine.
type pattern struct {
	class string
	re    *regexp.Regexp
	// group is the submatch whose span is masked; 0 masks the whole match.
	group int
	// needDigit skips blocks without an ASCII digit.
	needDigit bool
	// needAny skips blocks whose lowercased text contains none of these.
	needAny []string
	// needAlso, when set, is a second needAny list that must also hit.
	needAlso []string
	// minRun skips blocks whose longest id-like run is shorter.
	minRun int
	// check, when set, must accept the masked text.
	check func(string) bool
}

// features are the per-block facts the prefilters test.
type features struct {
	lower    string
	hasDigit bool
	maxRun   int
}

func blockFeatures(s string) features {
	f := features{lower: strings.ToLower(s)}
	run := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= '0' && c <= '9' {
			f.hasDigit = true
		}
		if isRunByte(c) {
			run++
			if run > f.maxRun {
				f.maxRun = run
			}
		} else {
			run = 0
		}
	}
	return f
}

func isRunByte(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' ||
		c == '_' || c == '-' || c == '+' || c == '/' || c == '='
}

func (p *pattern) applies(f *features) bool {
	if p.needDigit && !f.hasDigit {
		return false
	}
	if p.minRun > 0 && f.maxRun < p.minRun {
		return false
	}
	return containsAny(f.lower, p.needAny) && containsAny(f.lower, p.needAlso)
}

// containsAny reports whether s contains one of subs; an empty list passes.
func containsAny(s string, subs []string) bool {
	if len(subs) == 0 {
		return true
	}
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// Shared fragments.
const (
	// counterNum is a count: 1,234 / 1.2 / 12 with an optional k/m/b suffix
	// or a trailing plus.
	counterNum = `(?:\d{1,3}(?:[,.]\d{3})+|\d+(?:[.,]\d+)?)(?:\s?[kmb]\b|\+)?`
	relUnits   = `(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mos?|months?|y|yrs?|years?)`
)

// builtinPatterns is the versioned library of volatile-token patterns.
var builtinPatterns = []*pattern{
	// reltime: "3 minutes ago", "5m ago", "an hour ago".
	{
		class:   ClassReltime,
		re:      regexp.MustCompile(`(?i)\b(?:\d+\s*|(?:an?|one|two|three|a few|few|several|a couple of)\s+)` + relUnits + `\.?\s+ago\b`),
		needAny: []string{"ago"},
	},
	// reltime: fixed phrases.
	{
		class:   ClassReltime,
		re:      regexp.MustCompile(`(?i)\b(?:just now|a moment ago|moments? ago|a few seconds ago|yesterday)\b`),
		needAny: []string{"now", "moment", "ago", "yesterday"},
	},
	// reltime: "in 2 hours", "in a few minutes".
	{
		class:    ClassReltime,
		re:       regexp.MustCompile(`(?i)\bin\s+(?:\d+|an?|a few)\s+(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|months?)\b`),
		needAny:  []string{"in "},
		needAlso: []string{"sec", "min", "hour", "hr", "day", "week", "month"},
	},
	// clock: "14:03", "2:03 PM", "14:03:22 UTC".
	{
		class: ClassClock,
		re: regexp.MustCompile(`(?i)\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b` +
			`(?:\s?(?:[ap]\.m\.|[ap]m\b))?` +
			`(?:\s?(?:utc|gmt|[ecmp][sd]t|cet|cest|bst|ist|jst|aest|aedt)\b|\s?[+-]\d{2}:?\d{2}\b)?`),
		needDigit: true,
		needAny:   []string{":"},
	},
	// counter: "1,234 views", "38 comments", "1.2k likes".
	{
		class: ClassCounter,
		re: regexp.MustCompile(`(?i)\b` + counterNum + `\s+(?:views?|viewers?|likes?|comments?|replies|reply|shares?|` +
			`followers?|subscribers?|downloads?|reads?|visits?|visitors?|reactions?|retweets?|reposts?|clicks?|` +
			`plays?|listens?|watching|online|answers?|upvotes?|votes?|points|reviews?|ratings?|items?|` +
			`notifications?|messages?)\b`),
		needDigit: true,
		needAny: []string{"view", "like", "comment", "repl", "share", "follow", "subscri", "download", "read", "visit",
			"reaction", "retweet", "repost", "click", "play", "listen", "watching", "online", "answer", "vote", "points",
			"review", "rating", "item", "notification", "message"},
	},
	// counter: "12 people are looking at this".
	{
		class: ClassCounter,
		re: regexp.MustCompile(`(?i)\b\d[\d,]*\+?\s+(?:people|persons|others|users|shoppers|visitors|guests|travell?ers)\s+` +
			`(?:are\s+|have\s+)?(?:currently\s+)?(?:looking at|viewing|watching|browsing|online|here|bought|booked|purchased)` +
			`(?:\s+(?:this|it|right now|now))?(?:\s+(?:item|product|page|listing|hotel|property|room|deal))?`),
		needDigit: true,
		needAny:   []string{"people", "persons", "others", "users", "shoppers", "visitors", "guests", "travel"},
	},
	// counter: "viewed 1,234 times".
	{
		class:     ClassCounter,
		re:        regexp.MustCompile(`(?i)\b(?:viewed|watched|read|played|downloaded|seen|shared)\s+` + counterNum + `\s+times\b`),
		needDigit: true,
		needAny:   []string{"times"},
	},
	// counter: "(38)" right after a nav-like label; only the parenthesis is
	// masked.
	{
		class: ClassCounter,
		re: regexp.MustCompile(`(?i)\b(?:inbox|messages?|notifications?|alerts?|comments?|cart|basket|bag|replies|updates?|` +
			`unread|followers?|following|likes?|issues|pull requests|discussions|reviews|answers|tasks|drafts|chats?|mentions)` +
			`\s*(\(\d[\d,]*\+?\))`),
		group:     1,
		needDigit: true,
		needAny:   []string{"("},
	},
	// nonce: cache-buster and signature query params.
	{
		class: ClassNonce,
		re: regexp.MustCompile(`(?i)[?&](?:ver|version|cb|cachebust(?:er)?|cache|nocache|_|t|ts|timestamp|rev|build|hash|` +
			`nonce|sig|signature|token|csrf(?:_?token)?|_token|authenticity_token|x-amz-[a-z-]+|expires)=[^\s&#"'<>]+`),
		needAny: []string{"="},
	},
	// nonce: "?v=" with a version-like or hex value (not a YouTube id).
	{
		class:   ClassNonce,
		re:      regexp.MustCompile(`(?i)[?&]v=[0-9a-f][0-9a-f.\-]*\b`),
		needAny: []string{"v="},
	},
	// nonce: CSRF tokens written out as key: value.
	{
		class:   ClassNonce,
		re:      regexp.MustCompile(`(?i)\b(?:csrf|xsrf)[\w-]*\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{8,}|\b(?:authenticity_token|_token|nonce)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{8,}`),
		needAny: []string{"csrf", "xsrf", "token", "nonce"},
	},
	// nonce: UUIDs.
	{
		class:  ClassNonce,
		re:     regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`),
		minRun: 36,
	},
	// nonce: 16+ character hex ids (hash-like: digits and letters, one case).
	{
		class:  ClassNonce,
		re:     regexp.MustCompile(`\b[0-9a-fA-F]{16,}\b`),
		minRun: 16,
		check:  isHashLikeHex,
	},
	// nonce: 16+ character base64-ish ids (upper, lower and digits).
	{
		class:  ClassNonce,
		re:     regexp.MustCompile(`[A-Za-z0-9+/_-]{16,}={0,2}`),
		minRun: 16,
		check:  isBase64Like,
	},
	// copyright: "© 2026", "Copyright 2025-2026".
	{
		class:     ClassCopyright,
		re:        regexp.MustCompile(`(?i)(?:©|\(c\)|\bcopyright\b)(?:\s*(?:©|\(c\)))?\s*(?:\d{4}\s*[-–—‒]\s*)?\d{4}\b`),
		needDigit: true,
		needAny:   []string{"©", "(c)", "copyright"},
	},
}

func isHashLikeHex(s string) bool {
	var digit, lower, upper bool
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c >= '0' && c <= '9':
			digit = true
		case c >= 'a' && c <= 'f':
			lower = true
		case c >= 'A' && c <= 'F':
			upper = true
		}
	}
	return digit && (lower != upper)
}

func isBase64Like(s string) bool {
	var digit, lower, upper bool
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c >= '0' && c <= '9':
			digit = true
		case c >= 'a' && c <= 'z':
			lower = true
		case c >= 'A' && c <= 'Z':
			upper = true
		}
	}
	return digit && lower && upper
}

// currencyCodes are ISO 4217 codes that make a nearby number a price.
const currencyCodes = `(?:USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|CNY|RMB|HKD|SGD|SEK|NOK|DKK|PLN|CZK|HUF|RUB|BRL|MXN|KRW|ZAR|TRY|AED|SAR|ILS|THB|IDR|MYR|PHP|VND|BTC|ETH)`

var currencyCodesLower = strings.Split(strings.ToLower(strings.Trim(currencyCodes, "(?:)")), "|")

// protectPatterns find text that is never masked: prices and stock counts.
// A mask candidate overlapping one of these is dropped.
var protectPatterns = []*pattern{
	{
		re:        regexp.MustCompile(`[$€£¥₹]\s?\d[\d,.]*`),
		needDigit: true,
		needAny:   []string{"$", "€", "£", "¥", "₹"},
	},
	{
		re:        regexp.MustCompile(`(?i)\d[\d,.]*\s?` + currencyCodes + `\b|\b` + currencyCodes + `\s?\d[\d,.]*`),
		needDigit: true,
		needAny:   currencyCodesLower,
	},
	{
		re:        regexp.MustCompile(`(?i)\b(?:only\s+|just\s+)?\d[\d,]*\+?\s+(?:[\p{L}-]+\s+){0,2}(?:left|remaining|in stock|available)\b|\bin stock:?\s*\d+|\bstock:?\s*\d+`),
		needDigit: true,
		needAny:   []string{"left", "remaining", "stock", "available"},
	},
}

var monthNames = [...][]string{
	time.January:   {"january", "jan"},
	time.February:  {"february", "feb"},
	time.March:     {"march", "mar"},
	time.April:     {"april", "apr"},
	time.May:       {"may"},
	time.June:      {"june", "jun"},
	time.July:      {"july", "jul"},
	time.August:    {"august", "aug"},
	time.September: {"september", "sept", "sep"},
	time.October:   {"october", "oct"},
	time.November:  {"november", "nov"},
	time.December:  {"december", "dec"},
}

var weekdayNames = [...][]string{
	time.Sunday:    {"sunday", "sun"},
	time.Monday:    {"monday", "mon"},
	time.Tuesday:   {"tuesday", "tues", "tue"},
	time.Wednesday: {"wednesday", "wed"},
	time.Thursday:  {"thursday", "thurs", "thu"},
	time.Friday:    {"friday", "fri"},
	time.Saturday:  {"saturday", "sat"},
}

var trailingYearRE = regexp.MustCompile(`(\d{4})$`)

// todayPatterns builds the `today` class for one Capture date: the date in
// common numeric and written formats, matched only when it is that date.
func todayPatterns(date time.Time) []*pattern {
	if date.IsZero() {
		return nil
	}
	y, m, d := date.Date()
	year := fmt.Sprintf("%04d", y)
	yy := fmt.Sprintf("%02d", y%100)
	num := func(n int) string {
		if n < 10 {
			return fmt.Sprintf("0?%d", n)
		}
		return fmt.Sprintf("%d", n)
	}
	mn, dn := num(int(m)), num(d)
	month := `(?:` + altWithDot(monthNames[m]) + `)`
	weekday := `(?:(?:` + altWithDot(weekdayNames[date.Weekday()]) + `),?\s+)?`
	day := dn + `(?:st|nd|rd|th)?`

	written := regexp.MustCompile(`(?i)\b` + weekday + `(?:` + month + `\s+` + day + `|` + day + `\s+(?:of\s+)?` + month + `)` +
		`(?:,?\s+\d{4})?\b`)
	numeric := regexp.MustCompile(`\b(?:` +
		year + `[-/.]` + mn + `[-/.]` + dn +
		`|` + mn + `[/-]` + dn + `[/-](?:` + year + `|` + yy + `)` +
		`|` + dn + `[/.-]` + mn + `[/.-](?:` + year + `|` + yy + `)` +
		`)\b`)

	return []*pattern{
		{
			class:   ClassToday,
			re:      written,
			needAny: monthNames[m],
			// A written date followed by another year is not today.
			check: func(s string) bool {
				if mm := trailingYearRE.FindStringSubmatch(s); mm != nil {
					return mm[1] == year
				}
				return true
			},
		},
		{class: ClassToday, re: numeric, needDigit: true, needAny: []string{fmt.Sprint(d)}, needAlso: []string{fmt.Sprint(int(m))}},
	}
}

// altWithDot joins lowercase names into an alternation, letting abbreviations
// carry a trailing dot ("Sep.").
func altWithDot(names []string) string {
	parts := make([]string, len(names))
	for i, n := range names {
		parts[i] = regexp.QuoteMeta(n)
		if i > 0 {
			parts[i] += `\.?`
		}
	}
	return strings.Join(parts, "|")
}
