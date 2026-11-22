package text

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/stretchr/testify/require"
)

// fixtureBlock is a block as written in testdata/text/*.json. Text may hold
// masked spans written as {{class:display}}; they become one mask token
// whose Compare is the ⟨class⟩ placeholder.
type fixtureBlock struct {
	ID      string `json:"id"`
	Path    string `json:"path"`
	Tag     string `json:"tag"`
	Text    string `json:"text"`
	Ignored bool   `json:"ignored"`
}

// fixtureOp is the subset of a TextOp a golden fixture pins down.
type fixtureOp struct {
	Op            diff.OpKind   `json:"op"`
	BlockID       string        `json:"block_id,omitempty"`
	FromBlockID   string        `json:"from_block_id,omitempty"`
	Text          string        `json:"text,omitempty"`
	OldText       string        `json:"old_text,omitempty"`
	Tokens        []diff.WordOp `json:"tokens,omitempty"`
	Whole         bool          `json:"whole,omitempty"`
	From          int           `json:"from,omitempty"`
	To            int           `json:"to,omitempty"`
	ContextBefore []string      `json:"context_before,omitempty"`
	ContextAfter  []string      `json:"context_after,omitempty"`
}

type fixture struct {
	A        []fixtureBlock `json:"a"`
	B        []fixtureBlock `json:"b"`
	Expected struct {
		Ops []fixtureOp `json:"ops"`
		// Magnitude compares only the keys present.
		Magnitude    map[string]float64 `json:"magnitude"`
		IgnoredCount *int               `json:"ignored_count"`
		CountedOps   *int               `json:"counted_ops"`
		Masked       []string           `json:"masked"`
	} `json:"expected"`
}

var maskSpanRE = regexp.MustCompile(`\{\{(\w+):([^}]*)\}\}`)

// block builds a normalized block the way diff/normalize would: tokens from
// diff.Tokenize, Compare the concatenation of token Compare, Display the
// text. {{class:display}} spans become masked tokens.
func block(id, tag, text string, ignored bool) diff.NBlock {
	blk := diff.NBlock{ID: id, Path: "/body/" + tag + "[" + id + "]", Tag: tag, Ignored: ignored}
	var display strings.Builder
	rest := text
	for {
		loc := maskSpanRE.FindStringSubmatchIndex(rest)
		if loc == nil {
			break
		}
		plain := rest[:loc[0]]
		class, shown := rest[loc[2]:loc[3]], rest[loc[4]:loc[5]]
		blk.Tokens = append(blk.Tokens, diff.Tokenize(plain)...)
		blk.Tokens = append(blk.Tokens, diff.Token{Display: shown, Compare: "⟨" + class + "⟩", Mask: class, Kind: diff.TokenMask})
		blk.Masked = append(blk.Masked, class)
		display.WriteString(plain)
		display.WriteString(shown)
		rest = rest[loc[1]:]
	}
	blk.Tokens = append(blk.Tokens, diff.Tokenize(rest)...)
	display.WriteString(rest)
	blk.Display = display.String()
	var cmp strings.Builder
	for _, t := range blk.Tokens {
		cmp.WriteString(t.Compare)
	}
	blk.Compare = cmp.String()
	return blk
}

func fixtureBlocks(in []fixtureBlock) []diff.NBlock {
	out := make([]diff.NBlock, len(in))
	for i, fb := range in {
		out[i] = block(fb.ID, fb.Tag, fb.Text, fb.Ignored)
		if fb.Path != "" {
			out[i].Path = fb.Path
		}
	}
	return out
}

func reduceOps(ops []diff.TextOp) []fixtureOp {
	out := make([]fixtureOp, len(ops))
	for i, op := range ops {
		out[i] = fixtureOp{
			Op: op.Op, BlockID: op.BlockID, FromBlockID: op.FromBlockID,
			Text: op.Text, OldText: op.OldText, Tokens: op.Tokens, Whole: op.Whole,
			From: op.From, To: op.To,
			ContextBefore: op.ContextBefore, ContextAfter: op.ContextAfter,
		}
	}
	return out
}

func TestGolden(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("testdata", "text", "*.json"))
	require.NoError(t, err)
	require.NotEmpty(t, files)

	for _, file := range files {
		t.Run(strings.TrimSuffix(filepath.Base(file), ".json"), func(t *testing.T) {
			raw, err := os.ReadFile(file)
			require.NoError(t, err)
			var fx fixture
			require.NoError(t, json.Unmarshal(raw, &fx))

			ev := Compare(fixtureBlocks(fx.A), fixtureBlocks(fx.B))
			require.NotNil(t, ev)
			require.NotNil(t, ev.Ops)

			want := fx.Expected.Ops
			if want == nil {
				want = []fixtureOp{}
			}
			// Context is only checked where the fixture states it.
			got := reduceOps(ev.Ops)
			for i := range got {
				if i < len(want) && want[i].ContextBefore == nil && want[i].ContextAfter == nil {
					got[i].ContextBefore, got[i].ContextAfter = nil, nil
				}
			}
			require.Equal(t, want, got)

			var mag map[string]float64
			magRaw, err := json.Marshal(ev.Magnitude)
			require.NoError(t, err)
			require.NoError(t, json.Unmarshal(magRaw, &mag))
			for k, v := range fx.Expected.Magnitude {
				require.InDelta(t, v, mag[k], 1e-9, "magnitude %s", k)
			}
			if fx.Expected.IgnoredCount != nil {
				require.Equal(t, *fx.Expected.IgnoredCount, ev.IgnoredCount)
			}
			if fx.Expected.CountedOps != nil {
				require.Len(t, ev.CountedOps(), *fx.Expected.CountedOps)
			}
			if fx.Expected.Masked != nil {
				require.Equal(t, fx.Expected.Masked, ev.Masked)
			}

			out, err := json.Marshal(ev)
			require.NoError(t, err)
			require.Contains(t, string(out), `"ops":[`)
		})
	}
}
