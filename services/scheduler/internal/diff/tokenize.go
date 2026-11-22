package diff

import (
	"regexp"
	"strings"
	"unicode"
)

// tokenRE splits text into numbers (with an optional leading currency symbol,
// thousands and decimal separators, and a trailing percent sign), words,
// whitespace runs and single punctuation runes. Numbers are one token, so
// `$49.00` → `$59.00` diffs as one replaced token rather than `4` → `5`.
var tokenRE = regexp.MustCompile(
	`[$€£¥₹]?\d+(?:[.,\x{00a0} ]\d{3})*(?:[.,]\d+)?%?` +
		`|[\p{L}\p{M}][\p{L}\p{M}\p{N}_'’-]*` +
		`|\p{N}+` +
		`|\s+` +
		`|.`,
)

var numberStartRE = regexp.MustCompile(`^[$€£¥₹]?\d`)

// Tokenize splits already-canonical text into tokens whose Compare is their
// Display with quotes and dashes folded. Masking is applied by the caller
// (diff/normalize), which tokenizes only the unmasked stretches.
func Tokenize(text string) []Token {
	matches := tokenRE.FindAllString(text, -1)
	out := make([]Token, 0, len(matches))
	for _, m := range matches {
		out = append(out, Token{Display: m, Compare: FoldPunctuation(m), Kind: classify(m)})
	}
	return out
}

func classify(tok string) TokenKind {
	switch {
	case strings.TrimSpace(tok) == "":
		return TokenSpace
	case numberStartRE.MatchString(tok):
		return TokenNumber
	case len([]rune(tok)) == 1 && !isLetterOrDigit([]rune(tok)[0]):
		return TokenPunct
	default:
		return TokenWord
	}
}

func isLetterOrDigit(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

var punctFolder = strings.NewReplacer(
	"‘", "'", "’", "'", "‚", "'", "‛", "'", "′", "'",
	"“", `"`, "”", `"`, "„", `"`, "‟", `"`, "″", `"`, "«", `"`, "»", `"`,
	"–", "-", "—", "-", "‒", "-", "―", "-", "−", "-", "‐", "-", "‑", "-",
	"…", "...",
)

// FoldPunctuation unifies quotes and dashes for comparison only.
func FoldPunctuation(s string) string {
	// Every folded rune is multi-byte, so plain ASCII needs no work.
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return punctFolder.Replace(s)
		}
	}
	return s
}

// WordCount counts the tokens that count as words.
func WordCount(tokens []Token) int {
	n := 0
	for _, t := range tokens {
		if t.Counts() {
			n++
		}
	}
	return n
}
