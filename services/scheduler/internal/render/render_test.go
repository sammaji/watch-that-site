package render

import (
	"bytes"
	"encoding/json"
	"flag"
	"html"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/decide"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/notify"
	"github.com/stretchr/testify/require"
)

var update = flag.Bool("update", false, "rewrite golden files in testdata/render")

const testWebURL = "https://app.watchthat.test"

type fixture struct {
	name   string
	record func() changerecord.Record
	links  Links
}

var fixtures = []fixture{
	{"price", priceRecord, Links{WebURL: testWebURL}},
	{"visual", visualRecord, Links{WebURL: testWebURL + "/", CropURL: "https://r2.test/changes/m/5c2e8a90-crop.png?X-Amz-Signature=abc&X-Amz-Expires=604800", DiffImageURL: "https://r2.test/changes/m/5c2e8a90-diff.png"}},
	{"list", listRecord, Links{WebURL: testWebURL}},
	{"fallback", fallbackRecord, Links{WebURL: testWebURL}},
}

var (
	fixtureAt = time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	fromRef   = changerecord.RunRef{RunID: "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", At: fixtureAt.Add(-time.Hour), Screenshot: "captures/m/r1/shot.png", Blocks: "captures/m/r1/blocks.json.gz"}
	toRef     = changerecord.RunRef{RunID: "2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c", At: fixtureAt, Screenshot: "captures/m/r2/shot.png", Blocks: "captures/m/r2/blocks.json.gz"}
	relevant  = decide.Verdict{Status: decide.StatusChange, Why: []decide.Why{{Kind: decide.WhyAgent, Detail: "The agent found a change that matches this Monitor's instructions."}}}
)

func agentVerdict() *changerecord.AgentVerdict {
	return &changerecord.AgentVerdict{Relevant: true, Importance: changerecord.ImportanceHigh, Model: "gpt-5.1", InputTokens: 3200, OutputTokens: 210, Steps: 1}
}

// priceRecord is a Change the agent answered with one text item, confirmed
// on a second check, under a Watch Plan.
func priceRecord() changerecord.Record {
	rect := geom.Rect{120, 400, 640, 28}
	verdict := relevant
	verdict.Why = append(append([]decide.Why{}, relevant.Why...),
		decide.Why{Kind: decide.WhyPersistence, Reason: decide.NotePersistence, Detail: "Seen on two consecutive checks."})
	return changerecord.Build(changerecord.BuildInput{
		ChangeID: "8a1f0c2e-1111-4222-8333-444455556666",
		Monitor: monitor.Config{
			ID: "3d5a7c10-aaaa-4bbb-8ccc-ddddeeeeffff", Name: "Acme Pricing", URL: "https://acme.test/pricing",
			Instructions: "Tell me when a plan's price changes.",
			WatchPlan: &monitor.WatchPlan{Version: 1, Rest: monitor.HowIgnore, Sections: []monitor.WatchSection{
				{ID: "plans", Name: "Pricing table", How: monitor.HowText, Paths: []string{"/html/body/main/section[1]"}},
			}},
		},
		From: fromRef, To: toRef, Verdict: verdict,
		Step: diff.Evidence{Text: &diff.TextEvidence{
			Ops: []diff.TextOp{{
				Op: diff.OpModify, BlockID: "b4", FromBlockID: "b4", Path: "/html/body/main/section[1]/article[2]/p", Tag: "p",
				Rect: &rect, FromRect: &rect, Section: "plans",
				Tokens:        []diff.WordOp{{Op: "=", Text: "Pro plan "}, {Op: "-", Text: "$49"}, {Op: "+", Text: "$59"}, {Op: "=", Text: "/month <billed yearly> & more"}},
				ContextBefore: []string{"Choose a plan", "Pricing"}, ContextAfter: []string{"Team plan $99/month", "Enterprise: contact us"},
			}},
			Magnitude: diff.TextMagnitude{WordsAdded: 1, WordsRemoved: 1, BlocksChanged: 1, ChangeRatio: 0.04},
		}},
		Summary: "The Pro plan went from $49 to $59 per month.",
		Items: []changerecord.Item{{
			Title: "Pro plan price raised", Before: "$49/month <billed yearly>", After: "$59/month <billed yearly>",
			Kind: changerecord.ItemText, Matches: "a plan's price changes", Ops: []int{0},
		}},
		Ignored: []changerecord.Ignored{{Note: "The footer year", Reason: "Not a price."}},
		Agent:   agentVerdict(),
		Now:     fixtureAt,
	})
}

// visualRecord is a Change the agent answered with one visual item.
func visualRecord() changerecord.Record {
	box, from := geom.Rect{0, 148, 1366, 420}, geom.Rect{0, 100, 1366, 420}
	return changerecord.Build(changerecord.BuildInput{
		ChangeID: "5c2e8a90-2222-4333-8444-555566667777",
		Monitor: monitor.Config{
			ID: "3d5a7c10-aaaa-4bbb-8ccc-ddddeeeeffff", Name: "Acme Home", URL: "https://acme.test/",
			Instructions: "Tell me when the hero banner changes.",
			WatchPlan: &monitor.WatchPlan{Version: 1, Rest: monitor.HowText, Sections: []monitor.WatchSection{
				{ID: "hero", Name: "Hero banner", How: monitor.HowVisual, Paths: []string{"/html/body/header"}},
			}},
		},
		From: fromRef, To: toRef, Verdict: relevant,
		Step: diff.Evidence{
			Text: &diff.TextEvidence{},
			Visual: &diff.VisualEvidence{
				Regions:   []diff.Region{{Box: box, Kind: diff.RegionChanged, Pixels: 24680, FromBox: &from, Section: "hero"}},
				AreaRatio: 0.043, SizeBefore: [2]int{1366, 3000}, SizeAfter: [2]int{1366, 3048},
			},
		},
		Summary: "The hero banner now advertises the winter sale.",
		Items: []changerecord.Item{{
			Title: "Hero banner replaced", Before: "A photo of the autumn collection", After: "A \"Winter sale: 30 % off\" banner",
			Kind: changerecord.ItemVisual, Matches: "the hero banner changes", Regions: []int{0},
		}},
		Agent:        agentVerdict(),
		DiffImageKey: "changes/m/5c2e8a90-diff.png", CropKey: "changes/m/5c2e8a90-crop.png",
		Now: fixtureAt,
	})
}

var roles = []string{
	"Senior Go Engineer", "Staff Designer", "Product Manager, Growth", "Support Lead <EMEA>", "Data Analyst",
	"Site Reliability Engineer", "Technical Writer", "Account Executive", "Security Engineer", "Recruiter",
	"Engineering Manager", "Frontend Engineer",
}

func roleOps() []diff.TextOp {
	ops := make([]diff.TextOp, 0, len(roles)+1)
	for i, role := range roles {
		rect := geom.Rect{40, 300 + 40*i, 800, 28}
		ops = append(ops, diff.TextOp{
			Op: diff.OpAdd, BlockID: "j" + string(rune('a'+i)), Path: "/html/body/main/ul/li", Tag: "li", Rect: &rect,
			Text: role + " — Remote", ContextBefore: []string{"Open roles"}, To: i,
		})
	}
	return append(ops, diff.TextOp{Op: diff.OpIgnored, Path: "/html/body/footer/p", Tag: "p", Text: "Updated 3 minutes ago", OldText: "Updated 9 minutes ago"})
}

func careers() monitor.Config {
	return monitor.Config{ID: "3d5a7c10-aaaa-4bbb-8ccc-ddddeeeeffff", Name: "Careers <Jobs & Openings>", URL: "https://acme.test/careers?team=all&remote=1"}
}

// listRecord is a Change with more items than a notification shows.
func listRecord() changerecord.Record {
	its := make([]changerecord.Item, len(roles))
	for i, role := range roles {
		its[i] = changerecord.Item{Title: "New role: " + role, After: role + " — Remote", Kind: changerecord.ItemText, Matches: "new job postings", Ops: []int{i}}
	}
	return changerecord.Build(changerecord.BuildInput{
		ChangeID: "c7d9e1f3-3333-4444-8555-666677778888",
		Monitor:  careers(),
		From:     fromRef, To: toRef, Verdict: relevant,
		Step: diff.Evidence{Text: &diff.TextEvidence{
			Ops: roleOps(), Magnitude: diff.TextMagnitude{WordsAdded: 37, BlocksChanged: 12, ChangeRatio: 0.3}, IgnoredCount: 1, Masked: []string{"reltime"},
		}},
		Summary: "Twelve new remote roles were posted,\nincluding a Senior Go Engineer.",
		Items:   its,
		Agent:   agentVerdict(),
		Now:     fixtureAt,
	})
}

// fallbackRecord is the same difference with the agent out of reach: no
// items, a summary built from the evidence, and the diff to show for it.
func fallbackRecord() changerecord.Record {
	r := changerecord.Build(changerecord.BuildInput{
		ChangeID: "c7d9e1f3-3333-4444-8555-666677778888",
		Monitor:  careers(),
		From:     fromRef, To: toRef,
		Verdict: decide.Verdict{Status: decide.StatusChange, Why: []decide.Why{{
			Kind: decide.WhyNote, Reason: decide.NoteAgentUnavailable, Detail: "The agent could not be reached, so this difference was sent without its review.",
		}}},
		Step: diff.Evidence{Text: &diff.TextEvidence{
			Ops: roleOps(), Magnitude: diff.TextMagnitude{WordsAdded: 37, BlocksChanged: 12, ChangeRatio: 0.3}, IgnoredCount: 1, Masked: []string{"reltime"},
		}},
		Agent: &changerecord.AgentVerdict{Relevant: true, Importance: changerecord.ImportanceMedium, Unavailable: true, Error: "agent API unreachable: connection refused"},
		Now:   fixtureAt,
	})
	r.Summary = TemplateSummary(r)
	return r
}

// golden compares got with testdata/render/{file}, rewriting it with -update.
func golden(t *testing.T, file string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", "render", file)
	if *update {
		require.NoError(t, os.WriteFile(path, got, 0o644))
		return
	}
	want, err := os.ReadFile(path)
	require.NoError(t, err, "missing golden file; run go test ./internal/render/ -update")
	require.Equal(t, string(want), string(got), "golden mismatch for %s; run with -update if intended", file)
}

func indent(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, json.Indent(&buf, raw, "", "  "))
	buf.WriteByte('\n')
	return buf.Bytes()
}

func TestGolden(t *testing.T) {
	for _, f := range fixtures {
		t.Run(f.name, func(t *testing.T) {
			r := f.record()
			p, err := Notification(r, f.links)
			require.NoError(t, err)

			golden(t, f.name+".subject.txt", []byte(p.Subject+"\n"))
			golden(t, f.name+".email.html", []byte(*p.HTML))
			golden(t, f.name+".email.txt", []byte(*p.Text))
			golden(t, f.name+".slack.json", indent(t, p.Slack))
			golden(t, f.name+".discord.json", indent(t, p.Discord))
			tg, err := json.Marshal(p.Telegram)
			require.NoError(t, err)
			golden(t, f.name+".telegram.json", indent(t, tg))

			changeURL := testWebURL + "/changes/" + r.ID
			checkAll(t, p, changeURL)
		})
	}
}

// checkAll asserts the invariants every rendered change must hold.
func checkAll(t *testing.T, p notify.NotificationPayload, changeURL string) {
	t.Helper()
	require.NotContains(t, p.Subject, "\n")
	require.LessOrEqual(t, utf8.RuneCountInString(p.Subject), subjectMaxRunes)

	h := *p.HTML
	for _, banned := range []string{"<style", "<ins", "<del", "(added)", "(removed)"} {
		require.NotContains(t, strings.ToLower(h), banned)
	}
	require.NotContains(t, *p.Text, "(added)")

	checkSlack(t, p.Slack)
	checkDiscord(t, p.Discord)
	checkTelegram(t, p.Telegram)

	// Every sink message links to the Change view.
	require.Contains(t, h, changeURL)
	require.Contains(t, *p.Text, changeURL)
	require.Contains(t, string(p.Slack), changeURL)
	require.Contains(t, string(p.Discord), changeURL)
	tgAll := p.Telegram.Text + p.Telegram.Caption
	require.Contains(t, tgAll, changeURL)
}

func checkSlack(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var msg struct {
		Text   string           `json:"text"`
		Blocks []map[string]any `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(raw, &msg))
	require.NotEmpty(t, msg.Text)
	require.LessOrEqual(t, len(msg.Blocks), SlackMaxBlocks)
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			if typ, _ := x["type"].(string); (typ == "mrkdwn" || typ == "plain_text") && x["text"] != nil {
				s := x["text"].(string)
				require.LessOrEqual(t, utf8.RuneCountInString(s), SlackMaxTextRunes)
				require.NotEmpty(t, s)
			}
			if typ, _ := x["type"].(string); typ == "header" {
				s := x["text"].(map[string]any)["text"].(string)
				require.LessOrEqual(t, utf8.RuneCountInString(s), slackHeaderMaxRunes)
			}
			for _, c := range x {
				walk(c)
			}
		case []any:
			for _, c := range x {
				walk(c)
			}
		}
	}
	var all any
	require.NoError(t, json.Unmarshal(raw, &all))
	walk(all)
}

func checkDiscord(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var msg struct {
		Content string `json:"content"`
		Embeds  []struct {
			Title       string `json:"title"`
			Description string `json:"description"`
			Footer      *struct {
				Text string `json:"text"`
			} `json:"footer"`
		} `json:"embeds"`
	}
	require.NoError(t, json.Unmarshal(raw, &msg))
	require.NotEmpty(t, msg.Content)
	require.LessOrEqual(t, utf8.RuneCountInString(msg.Content), DiscordMaxContentRunes)
	require.LessOrEqual(t, len(msg.Embeds), 10)
	total := 0
	for _, e := range msg.Embeds {
		require.LessOrEqual(t, utf8.RuneCountInString(e.Title), DiscordMaxTitleRunes)
		require.LessOrEqual(t, utf8.RuneCountInString(e.Description), DiscordMaxDescriptionRunes)
		total += utf8.RuneCountInString(e.Title) + utf8.RuneCountInString(e.Description)
		if e.Footer != nil {
			total += utf8.RuneCountInString(e.Footer.Text)
		}
	}
	require.LessOrEqual(t, total, DiscordMaxEmbedTotalRunes)
}

func checkTelegram(t *testing.T, b *notify.TelegramBody) {
	t.Helper()
	require.NotNil(t, b)
	require.True(t, b.Text != "" || b.PhotoURL != "")
	require.LessOrEqual(t, utf8.RuneCountInString(b.Text), TelegramMaxTextRunes)
	require.LessOrEqual(t, utf8.RuneCountInString(b.Caption), TelegramMaxCaptionRunes)
	if b.PhotoURL != "" {
		require.NotEmpty(t, b.Caption)
	}
	// Only the tags Telegram's HTML mode supports.
	for _, tag := range regexp.MustCompile(`</?([a-z]+)`).FindAllStringSubmatch(b.Text+b.Caption, -1) {
		require.Contains(t, []string{"b", "i", "s", "code", "a"}, tag[1])
	}
}

func TestPriceChange(t *testing.T) {
	r := priceRecord()
	links := Links{WebURL: testWebURL}

	require.Equal(t, "The Pro plan went from $49 to $59 per month.", Summary(r))
	require.Equal(t, "Acme Pricing: The Pro plan went from $49 to $59 per month.", Subject(r))
	require.Equal(t, "Seen on two consecutive checks", NoteLine(r), "the agent's own line is not repeated")

	h := EmailHTML(r, links)
	// The summary leads, ahead of the Monitor's name and everything else.
	body := h[strings.Index(h, "<body"):]
	require.Less(t, strings.Index(body, "The Pro plan went from"), strings.Index(body, "Acme Pricing"))
	require.Less(t, strings.Index(body, "The Pro plan went from"), strings.Index(body, "Pro plan price raised"))
	// The item: its title and Section, what it was struck out, what it is now.
	require.Contains(t, h, `Pro plan price raised <span style="font-weight:400;`+styleContext+`">· Pricing table</span>`)
	require.Contains(t, h, `<span style="`+styleRemoved+`">$49/month &lt;billed yearly&gt;</span> → <span style="`+styleAdded+`">$59/month &lt;billed yearly&gt;</span>`)
	require.NotContains(t, h, "<billed")
	// Items stand in for the diff: its context lines are not repeated.
	require.NotContains(t, h, "Team plan $99/month")
	// Nothing speaks of triggers any more.
	require.NotContains(t, strings.ToLower(h), "matched")
	require.NotContains(t, strings.ToLower(h), "trigger")
	// Buttons.
	require.Contains(t, h, testWebURL+"/changes/"+r.ID+"?feedback=noise")
	require.Contains(t, h, testWebURL+"/monitors/"+r.Monitor.ID+"?pause=1")
	require.NotContains(t, h, "<img")

	text := EmailText(r, links)
	require.True(t, strings.HasPrefix(text, "The Pro plan went from $49 to $59 per month.\n"))
	require.Contains(t, text, "- Pro plan price raised · Pricing table\n  $49/month <billed yearly> → $59/month <billed yearly>\n")
	require.Less(t, strings.Index(text, "- Pro plan price raised"), strings.Index(text, "View change: "), "the link comes last")

	var slack struct {
		Blocks []struct {
			Type string `json:"type"`
			Text struct {
				Text string `json:"text"`
			} `json:"text"`
		} `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(mustSlack(t, r, links), &slack))
	require.Equal(t, "header", slack.Blocks[0].Type)
	require.Equal(t, "The Pro plan went from $49 to $59 per month.", slack.Blocks[0].Text.Text)
	require.Equal(t, "*Pro plan price raised · Pricing table*\n~$49/month &lt;billed yearly&gt;~ → $59/month &lt;billed yearly&gt;", slack.Blocks[2].Text.Text)
	require.Equal(t, "actions", slack.Blocks[len(slack.Blocks)-1].Type)

	tg := Telegram(r, links)
	require.True(t, strings.HasPrefix(tg.Text, "<b>The Pro plan went from $49 to $59 per month.</b>\nAcme Pricing"))
	require.Contains(t, tg.Text, "<b>Pro plan price raised · Pricing table</b>\n<s>$49/month &lt;billed yearly&gt;</s> → $59/month &lt;billed yearly&gt;")

	raw, err := Discord(r, links)
	require.NoError(t, err)
	var d struct {
		Embeds []struct{ Title, Description string } `json:"embeds"`
	}
	require.NoError(t, json.Unmarshal(raw, &d))
	require.Equal(t, "The Pro plan went from $49 to $59 per month.", d.Embeds[0].Title)
	require.Contains(t, d.Embeds[0].Description, "**Pro plan price raised · Pricing table**\n~~$49/month <billed yearly\\>~~ → $59/month <billed yearly\\>")
}

func TestVisualOnly(t *testing.T) {
	r := visualRecord()
	links := fixtures[1].links
	require.Equal(t, "The hero banner now advertises the winter sale.", Summary(r))
	require.Equal(t, "Hero banner looks different", TemplateSummary(r), "without the agent, the Section is named")
	h := EmailHTML(r, links)
	require.Contains(t, h, `<img src="`+html.EscapeString(links.CropURL)+`"`)
	require.Contains(t, h, "Hero banner replaced")

	tg := Telegram(r, links)
	require.Equal(t, links.CropURL, tg.PhotoURL)
	require.Contains(t, tg.Caption, "The hero banner now advertises the winter sale.")
	require.Contains(t, tg.Text, "Hero banner replaced", "the item follows the photo")

	var d struct {
		Embeds []struct {
			Image struct {
				URL string `json:"url"`
			} `json:"image"`
		} `json:"embeds"`
	}
	raw, err := Discord(r, links)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &d))
	require.Equal(t, links.CropURL, d.Embeds[0].Image.URL)
	require.Contains(t, string(mustSlack(t, r, links)), `"type":"image"`)

	// With neither items nor text, the photo caption says everything.
	r.Items = nil
	tg = Telegram(r, links)
	require.Empty(t, tg.Text)
	require.NotEmpty(t, tg.Caption)
}

func TestListTruncation(t *testing.T) {
	r := listRecord()
	links := Links{WebURL: testWebURL}

	// The summary is folded onto one line.
	require.Equal(t, "Twelve new remote roles were posted, including a Senior Go Engineer.", Summary(r))
	require.Equal(t, "Careers <Jobs & Openings>: Twelve new remote roles were posted, including a Senior Go Engineer.", Subject(r))

	h := EmailHTML(r, links)
	require.Equal(t, MaxItems, strings.Count(h, `<span style="`+styleAdded+`">`))
	require.Contains(t, h, "+7 more")
	require.Contains(t, h, "New role: Support Lead &lt;EMEA&gt;")
	require.NotContains(t, h, "Recruiter", "the sixth item and later are behind the link")
	require.NotContains(t, h, "Updated 3 minutes ago", "ignored ops are not rendered")
	require.Contains(t, h, "Careers &lt;Jobs &amp; Openings&gt;")
	require.Contains(t, EmailText(r, links), "+7 more: "+testWebURL+"/changes/"+r.ID)
	require.Contains(t, EmailText(r, links), "- New role: Senior Go Engineer\n  New: Senior Go Engineer — Remote\n")
	require.Contains(t, string(mustSlack(t, r, links)), "+7 more")
	require.Contains(t, Telegram(r, links).Text, "+7 more")
}

// With the agent out of reach there are no items: every Channel shows the
// summary built from the evidence and the diff itself.
func TestFallbackShowsTheDiff(t *testing.T) {
	r := fallbackRecord()
	links := Links{WebURL: testWebURL}

	require.Equal(t, "37 words added", Summary(r))
	require.Equal(t, "The agent could not be reached, so this difference was sent without its review", NoteLine(r))

	h := EmailHTML(r, links)
	require.Equal(t, MaxOps, strings.Count(h, `<span style="`+styleAdded+`">`))
	require.Contains(t, h, "+7 more changes")
	require.Contains(t, h, "The agent could not be reached")
	require.NotContains(t, h, "Updated 3 minutes ago", "ignored ops are not rendered")

	text := EmailText(r, links)
	require.Contains(t, text, "+ Senior Go Engineer — Remote")
	require.Contains(t, text, "+7 more changes: "+testWebURL+"/changes/"+r.ID)
	require.Contains(t, string(mustSlack(t, r, links)), "+7 more changes")
	require.Contains(t, Telegram(r, links).Text, "+7 more changes")
}

func mustSlack(t *testing.T, r changerecord.Record, links Links) json.RawMessage {
	raw, err := Slack(r, links)
	require.NoError(t, err)
	return raw
}

func TestSummaryTemplates(t *testing.T) {
	r := fallbackRecord()
	require.Equal(t, "37 words added", TemplateSummary(r))
	r.Summary = "Stored summary"
	require.Equal(t, "Stored summary", Summary(r), "the record's summary wins")
	require.Equal(t, "Careers <Jobs & Openings>: Stored summary", Subject(r))

	one := fallbackRecord()
	one.Text.Ops = one.Text.Ops[:1]
	one.Text.Ops[0].Text = strings.Repeat("Brand new announcement ", 5)
	require.Equal(t, "New: Brand new announcement Brand new announcement Brand new ann…", TemplateSummary(one))

	p := priceRecord()
	require.Equal(t, "1 word added, 1 removed", TemplateSummary(p))

	// The cumulative evidence, when there is any, is what the template counts.
	p.Cumulative = &changerecord.Cumulative{Text: p.Text, Magnitude: changerecord.Magnitude{WordsAdded: 4, WordsRemoved: 2}}
	require.Equal(t, "4 words added, 2 removed", TemplateSummary(p))

	v := visualRecord()
	v.Sections = nil
	require.Equal(t, "Looks different (4.3 % of the page)", TemplateSummary(v), "no Watch Plan: the whole page was compared")
	v = visualRecord()
	v.Visual.Regions = append(v.Visual.Regions, diff.Region{Kind: diff.RegionChanged})
	require.Equal(t, "2 parts of the page look different", TemplateSummary(v))

	empty := changerecord.Record{}
	require.Equal(t, "Page changed", TemplateSummary(empty))

	long := priceRecord()
	long.Monitor.Name = strings.Repeat("Very long\nmonitor name ", 20)
	s := Subject(long)
	require.NotContains(t, s, "\n")
	require.Equal(t, subjectMaxRunes, utf8.RuneCountInString(s))
}

func TestFormatNumber(t *testing.T) {
	for in, want := range map[float64]string{49: "49", 49.5: "49.5", 0.1 + 0.2: "0.3", -3.25: "-3.25", 1e6: "1000000"} {
		require.Equal(t, want, FormatNumber(in))
	}
}

// The webhook body is the Change Record, version 2, byte for byte.
func TestWebhookIsTheRecord(t *testing.T) {
	r := listRecord()
	body, err := Webhook(r)
	require.NoError(t, err)
	var back changerecord.Record
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	require.NoError(t, dec.Decode(&back))
	require.Equal(t, r, back)
	require.Equal(t, 2, back.Version)
	require.Contains(t, string(body), "Careers <Jobs & Openings>", "no HTML escaping in the webhook body")
	for _, key := range []string{`"items":`, `"ignored":`, `"agent":`, `"sections":`} {
		require.Contains(t, string(body), key)
	}
	for _, gone := range []string{`"matched"`, `"data"`, `"ai"`, `"data_ops"`, `"scope"`} {
		require.NotContains(t, string(body), gone)
	}

	p, err := Notification(r, Links{WebURL: testWebURL})
	require.NoError(t, err)
	require.Equal(t, body, p.Webhook)
	require.Equal(t, EventChange, p.WebhookEvent)
}

func TestSign(t *testing.T) {
	// Reference vector, mirrored in services/notifications.
	got := Sign("whsec_test", []byte(`{"id":"x"}`), 1700000000)
	require.Equal(t, "t=1700000000,v1=80e8d098018f757aa814ab1abb924f35d304affa1d93d29611a54696207eb7c3", got)
}

func digestEntries() []DigestEntry {
	at := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	mk := func(i int, mid, mname, summary string) DigestEntry {
		return DigestEntry{
			ChangeID:    "c" + string(rune('0'+i)),
			MonitorID:   mid,
			MonitorName: mname,
			Summary:     summary,
			At:          at.Add(time.Duration(10-i) * time.Minute),
		}
	}
	return []DigestEntry{
		mk(1, "m-pricing", "Acme Pricing", "Price 49 → 59"),
		mk(2, "m-careers", "Careers", "New: Staff Designer — Remote"),
		mk(3, "m-pricing", "Acme Pricing", "Price 59 → 49"),
		mk(4, "m-blog", "Blog <news>", "3 words added, 1 removed"),
		mk(5, "m-careers", "Careers", "Looks different (4 % of the page)"),
		mk(6, "m-blog", "Blog <news>", "New: Launch week recap"),
		mk(7, "m-careers", "Careers", "12 words added"),
	}
}

func TestDigest(t *testing.T) {
	entries := digestEntries()
	links := Links{WebURL: testWebURL}
	p, err := DigestNotification(entries, "hourly", links)
	require.NoError(t, err)

	require.Equal(t, "Hourly digest: 7 changes on 3 monitors", p.Subject)
	require.Equal(t, EventDigest, p.WebhookEvent)

	golden(t, "digest.email.html", []byte(*p.HTML))
	golden(t, "digest.txt", []byte(*p.Text))
	golden(t, "digest.slack.json", indent(t, p.Slack))
	golden(t, "digest.discord.json", indent(t, p.Discord))
	tg, err := json.Marshal(p.Telegram)
	require.NoError(t, err)
	golden(t, "digest.telegram.json", indent(t, tg))
	golden(t, "digest.webhook.json", indent(t, p.Webhook))

	for _, e := range entries {
		u := testWebURL + "/changes/" + e.ChangeID
		require.Contains(t, *p.HTML, u)
		require.Contains(t, *p.Text, u)
		require.Contains(t, string(p.Slack), u)
		require.Contains(t, string(p.Discord), u)
		require.Contains(t, p.Telegram.Text, u)
		require.Contains(t, string(p.Webhook), u)
	}
	// Grouped: Monitors sorted by name, each once.
	text := *p.Text
	require.Equal(t, 1, strings.Count(text, "\nCareers\n"))
	require.Less(t, strings.Index(text, "Acme Pricing"), strings.Index(text, "Blog <news>"))
	require.Less(t, strings.Index(text, "Blog <news>"), strings.Index(text, "\nCareers\n"))
	require.NotContains(t, *p.HTML, "<style")
	checkSlack(t, p.Slack)
	checkDiscord(t, p.Discord)
	checkTelegram(t, p.Telegram)
}

func TestDigestLimits(t *testing.T) {
	var entries []DigestEntry
	at := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	for m := 0; m < 70; m++ {
		for c := 0; c < 20; c++ {
			entries = append(entries, DigestEntry{
				ChangeID:    strings.Repeat("x", 36),
				MonitorID:   "m" + string(rune('A'+m%26)) + string(rune('a'+m/26)),
				MonitorName: "Monitor " + string(rune('A'+m%26)) + string(rune('a'+m/26)),
				Summary:     strings.Repeat("long summary ", 12),
				At:          at,
			})
		}
	}
	links := Links{WebURL: testWebURL}
	p, err := DigestNotification(entries, "daily", links)
	require.NoError(t, err)
	checkSlack(t, p.Slack)
	checkDiscord(t, p.Discord)
	checkTelegram(t, p.Telegram)
}

func TestFailureNotification(t *testing.T) {
	m := MonitorInfo{ID: "m-1", Name: "Billing page", URL: "https://acme.test/billing"}
	p, err := FailureNotification(m, "macro_failed", "Step 3 (Open the Billing tab) could not find its element.", 3,
		time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC), Links{WebURL: testWebURL})
	require.NoError(t, err)
	require.Equal(t, "Billing page: this Monitor keeps failing", p.Subject)
	require.Equal(t, EventFailure, p.WebhookEvent)
	// The reason's message and the link to the Monitor page, on every Channel.
	for name, body := range map[string]string{
		"html": *p.HTML, "text": *p.Text, "slack": string(p.Slack), "discord": string(p.Discord), "telegram": p.Telegram.Text,
	} {
		require.Contains(t, body, "last 3 checks", name)
		require.Contains(t, body, "Open the Billing tab", name)
		require.Contains(t, body, testWebURL+"/monitors/m-1", name)
	}
	require.NotContains(t, *p.HTML, "<style")
	checkSlack(t, p.Slack)
	checkDiscord(t, p.Discord)
	checkTelegram(t, p.Telegram)
	var body map[string]any
	require.NoError(t, json.Unmarshal(p.Webhook, &body))
	require.Equal(t, "failure", body["event"])
	require.Equal(t, "macro_failed", body["reason"])
	require.Equal(t, float64(3), body["failures"])
	require.Contains(t, body["message"], "Open the Billing tab")
}

func TestDiffStaysWithinLimits(t *testing.T) {
	r := fallbackRecord()
	for i := range r.Text.Ops {
		r.Text.Ops[i].Text = strings.Repeat("<&> ", 400)
		r.Text.Ops[i].ContextBefore = []string{strings.Repeat("ctx ", 200)}
	}
	links := Links{WebURL: testWebURL}
	checkSlack(t, mustSlack(t, r, links))
	d, err := Discord(r, links)
	require.NoError(t, err)
	checkDiscord(t, d)
	tg := Telegram(r, links)
	checkTelegram(t, &tg)
}

func TestItemsStayWithinLimits(t *testing.T) {
	r := listRecord()
	for i := range r.Items {
		r.Items[i].Title = strings.Repeat("*~<&>` ", 80)
		r.Items[i].Before = strings.Repeat("~~before** ", 400)
		r.Items[i].After = strings.Repeat("<after> ", 400)
	}
	r.Summary = strings.Repeat("A very long summary sentence. ", 40)
	links := Links{WebURL: testWebURL, CropURL: "https://r2.test/crop.png"}
	p, err := Notification(r, links)
	require.NoError(t, err)
	checkAll(t, p, testWebURL+"/changes/"+r.ID)
}

func TestSafeHref(t *testing.T) {
	r := priceRecord()
	r.Monitor.URL = "javascript:alert(1)"
	require.NotContains(t, EmailHTML(r, Links{WebURL: testWebURL}), `href="javascript:`)
}
