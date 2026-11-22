package r2

import (
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// Prefix is the first segment of every key. R2 lifecycle rules target whole
// prefixes, and the object-store Worker only lists under these.
type Prefix string

const (
	// PrefixCaptures holds per-Run evidence: screenshots and text blocks.
	PrefixCaptures Prefix = "captures"

	// PrefixChanges holds Change Records and their rendered images.
	PrefixChanges Prefix = "changes"

	// PrefixState holds one browser storage state per Monitor.
	PrefixState Prefix = "state"

	// PrefixSteps holds the screenshots taken after the steps of a Run or of
	// a Macro recording.
	PrefixSteps Prefix = "steps"
)

// Kind says what an object is, which also fixes its content type.
type Kind string

const (
	KindShot   Kind = "shot"   // captures/{m}/{r}/shot.{png|webp}
	KindLearn  Kind = "learn"  // captures/{m}/{r}/learn-{0..2}.{png|webp}
	KindBlocks Kind = "blocks" // captures/{m}/{r}/blocks.json.gz
	KindChange Kind = "change" // changes/{m}/{c}.json.gz
	KindDiff   Kind = "diff"   // changes/{m}/{c}-diff.png
	KindCrop   Kind = "crop"   // changes/{m}/{c}-crop.png
	KindState  Kind = "state"  // state/{m}.json
	KindStep   Kind = "step"   // steps/{m}/{run or macro}/{seq}.webp
)

// Image formats accepted by CaptureShotKey and LearnShotKey.
const (
	FormatPNG  = "png"
	FormatWebP = "webp"
)

// Content types the object-store Worker accepts. Each key has exactly one.
const (
	ContentTypePNG  = "image/png"
	ContentTypeWebP = "image/webp"
	ContentTypeJSON = "application/json"
	ContentTypeGzip = "application/gzip"
)

// KeyLayout describes the enforced key format. It appears in ErrInvalidKey
// messages so a bad key is self-explanatory in a log line.
const KeyLayout = "captures/{monitor}/{run}/{shot|learn-0|learn-1|learn-2}.{png|webp}, " +
	"captures/{monitor}/{run}/blocks.json.gz, changes/{monitor}/{change}.json.gz, " +
	"changes/{monitor}/{change}-{diff|crop}.png, state/{monitor}.json, " +
	"steps/{monitor}/{run|macro}/{seq}.webp (lower-case UUIDs)"

// uuidPattern is lower-case only: keys have one canonical spelling, so a
// signature over a key and an ownership lookup by its Monitor id agree.
const uuidPattern = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

var (
	captureImageRE  = regexp.MustCompile(`^captures/(` + uuidPattern + `)/(` + uuidPattern + `)/(shot|learn-([0-2]))\.(png|webp)$`)
	captureBlocksRE = regexp.MustCompile(`^captures/(` + uuidPattern + `)/(` + uuidPattern + `)/blocks\.json\.gz$`)
	changeRecordRE  = regexp.MustCompile(`^changes/(` + uuidPattern + `)/(` + uuidPattern + `)\.json\.gz$`)
	changeImageRE   = regexp.MustCompile(`^changes/(` + uuidPattern + `)/(` + uuidPattern + `)-(diff|crop)\.png$`)
	storageStateRE  = regexp.MustCompile(`^state/(` + uuidPattern + `)\.json$`)
	// seq has one spelling, like everything else in a key: no leading zeros.
	stepShotRE = regexp.MustCompile(`^steps/(` + uuidPattern + `)/(` + uuidPattern + `)/(0|[1-9][0-9]{0,8})\.webp$`)
	uuidRE     = regexp.MustCompile(`^` + uuidPattern + `$`)
)

// Key is a parsed object key. It mirrors ParsedObjectKey in
// packages/cloudflare/src/shared/keys.ts.
type Key struct {
	// Raw is the key as stored.
	Raw string

	Prefix Prefix
	Kind   Kind

	// MonitorID is the first UUID in every key: the Monitor that owns it.
	MonitorID string

	// RunID is set for captures/ keys.
	RunID string

	// ChangeID is set for changes/ keys.
	ChangeID string

	// LearnIndex is 0–2 for KindLearn, -1 otherwise.
	LearnIndex int

	// SubjectID is set for steps/ keys: the Run, or the Macro version being
	// recorded, whose steps the screenshot belongs to.
	SubjectID string

	// StepSeq is the step's sequence number for KindStep, -1 otherwise.
	StepSeq int

	// ContentType is the only content type this key may be stored with.
	ContentType string
}

// String returns the key in its storage form.
func (k Key) String() string { return k.Raw }

// ParseKey validates a key and splits it into its parts.
func ParseKey(raw string) (Key, error) {
	if m := captureImageRE.FindStringSubmatch(raw); m != nil {
		k := Key{Raw: raw, Prefix: PrefixCaptures, Kind: KindShot, MonitorID: m[1], RunID: m[2], LearnIndex: -1, StepSeq: -1, ContentType: imageContentType(m[5])}
		if m[3] != "shot" {
			k.Kind = KindLearn
			k.LearnIndex, _ = strconv.Atoi(m[4])
		}
		return k, nil
	}
	if m := captureBlocksRE.FindStringSubmatch(raw); m != nil {
		return Key{Raw: raw, Prefix: PrefixCaptures, Kind: KindBlocks, MonitorID: m[1], RunID: m[2], LearnIndex: -1, StepSeq: -1, ContentType: ContentTypeGzip}, nil
	}
	if m := changeRecordRE.FindStringSubmatch(raw); m != nil {
		return Key{Raw: raw, Prefix: PrefixChanges, Kind: KindChange, MonitorID: m[1], ChangeID: m[2], LearnIndex: -1, StepSeq: -1, ContentType: ContentTypeGzip}, nil
	}
	if m := changeImageRE.FindStringSubmatch(raw); m != nil {
		return Key{Raw: raw, Prefix: PrefixChanges, Kind: Kind(m[3]), MonitorID: m[1], ChangeID: m[2], LearnIndex: -1, StepSeq: -1, ContentType: ContentTypePNG}, nil
	}
	if m := storageStateRE.FindStringSubmatch(raw); m != nil {
		return Key{Raw: raw, Prefix: PrefixState, Kind: KindState, MonitorID: m[1], LearnIndex: -1, StepSeq: -1, ContentType: ContentTypeJSON}, nil
	}
	if m := stepShotRE.FindStringSubmatch(raw); m != nil {
		seq, _ := strconv.Atoi(m[3])
		return Key{Raw: raw, Prefix: PrefixSteps, Kind: KindStep, MonitorID: m[1], SubjectID: m[2], LearnIndex: -1, StepSeq: seq, ContentType: ContentTypeWebP}, nil
	}
	return Key{}, fmt.Errorf("%w: %q does not match %s", ErrInvalidKey, raw, KeyLayout)
}

// ValidKey reports whether raw is a well-formed object key.
func ValidKey(raw string) bool {
	_, err := ParseKey(raw)
	return err == nil
}

func imageContentType(format string) string {
	if format == FormatWebP {
		return ContentTypeWebP
	}
	return ContentTypePNG
}

func normUUID(label, value string) (string, error) {
	lower := strings.ToLower(value)
	if !uuidRE.MatchString(lower) {
		return "", fmt.Errorf("%w: %s %q is not a UUID", ErrInvalidKey, label, value)
	}
	return lower, nil
}

func normFormat(format string) (string, error) {
	f := strings.ToLower(strings.TrimPrefix(format, "."))
	if f != FormatPNG && f != FormatWebP {
		return "", fmt.Errorf("%w: image format must be png or webp, got %q", ErrInvalidKey, format)
	}
	return f, nil
}

func ids2(first, firstLabel, second, secondLabel string) (string, string, error) {
	a, err := normUUID(firstLabel, first)
	if err != nil {
		return "", "", err
	}
	b, err := normUUID(secondLabel, second)
	if err != nil {
		return "", "", err
	}
	return a, b, nil
}

// CaptureShotKey is captures/{monitor}/{run}/shot.{format}; format is png or webp.
func CaptureShotKey(monitorID, runID, format string) (string, error) {
	m, r, err := ids2(monitorID, "monitor id", runID, "run id")
	if err != nil {
		return "", err
	}
	f, err := normFormat(format)
	if err != nil {
		return "", err
	}
	return "captures/" + m + "/" + r + "/shot." + f, nil
}

// LearnShotKey is captures/{monitor}/{run}/learn-{index}.{format}, index 0–2.
func LearnShotKey(monitorID, runID string, index int, format string) (string, error) {
	m, r, err := ids2(monitorID, "monitor id", runID, "run id")
	if err != nil {
		return "", err
	}
	if index < 0 || index > 2 {
		return "", fmt.Errorf("%w: learn index must be 0, 1 or 2, got %d", ErrInvalidKey, index)
	}
	f, err := normFormat(format)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("captures/%s/%s/learn-%d.%s", m, r, index, f), nil
}

// BlocksKey is captures/{monitor}/{run}/blocks.json.gz.
func BlocksKey(monitorID, runID string) (string, error) {
	m, r, err := ids2(monitorID, "monitor id", runID, "run id")
	if err != nil {
		return "", err
	}
	return "captures/" + m + "/" + r + "/blocks.json.gz", nil
}

// ChangeRecordKey is changes/{monitor}/{change}.json.gz.
func ChangeRecordKey(monitorID, changeID string) (string, error) {
	m, c, err := ids2(monitorID, "monitor id", changeID, "change id")
	if err != nil {
		return "", err
	}
	return "changes/" + m + "/" + c + ".json.gz", nil
}

// ChangeDiffKey is changes/{monitor}/{change}-diff.png.
func ChangeDiffKey(monitorID, changeID string) (string, error) {
	m, c, err := ids2(monitorID, "monitor id", changeID, "change id")
	if err != nil {
		return "", err
	}
	return "changes/" + m + "/" + c + "-diff.png", nil
}

// ChangeCropKey is changes/{monitor}/{change}-crop.png.
func ChangeCropKey(monitorID, changeID string) (string, error) {
	m, c, err := ids2(monitorID, "monitor id", changeID, "change id")
	if err != nil {
		return "", err
	}
	return "changes/" + m + "/" + c + "-crop.png", nil
}

// StorageStateKey is state/{monitor}.json.
func StorageStateKey(monitorID string) (string, error) {
	m, err := normUUID("monitor id", monitorID)
	if err != nil {
		return "", err
	}
	return "state/" + m + ".json", nil
}

// maxStepSeq is the largest step sequence number a key may carry.
const maxStepSeq = 999_999_999

// StepShotKey is steps/{monitor}/{subject}/{seq}.webp: the screenshot taken
// after step seq of a Run or of a Macro recording. subjectID is the Run's id
// or the Macro version's; seq counts from 0. It mirrors stepScreenshotKey in
// packages/types/src/protocol.ts.
func StepShotKey(monitorID, subjectID string, seq int) (string, error) {
	m, sub, err := ids2(monitorID, "monitor id", subjectID, "run or macro id")
	if err != nil {
		return "", err
	}
	if seq < 0 || seq > maxStepSeq {
		return "", fmt.Errorf("%w: step seq must be between 0 and %d, got %d", ErrInvalidKey, maxStepSeq, seq)
	}
	return "steps/" + m + "/" + sub + "/" + strconv.Itoa(seq) + ".webp", nil
}

// MonitorPrefix is the listing prefix for one Monitor's objects under p:
// "captures/{m}/", "changes/{m}/", "steps/{m}/", or "state/{m}" (a single
// object).
func MonitorPrefix(p Prefix, monitorID string) (string, error) {
	m, err := normUUID("monitor id", monitorID)
	if err != nil {
		return "", err
	}
	switch p {
	case PrefixCaptures, PrefixChanges, PrefixSteps:
		return string(p) + "/" + m + "/", nil
	case PrefixState:
		return "state/" + m, nil
	}
	return "", fmt.Errorf("%w: unknown prefix %q", ErrInvalidKey, p)
}

// ContentTypeForKey returns the content type a key must be stored with, or,
// for a key outside the layout, a guess from its extension.
func ContentTypeForKey(key string) string {
	if k, err := ParseKey(key); err == nil {
		return k.ContentType
	}
	switch {
	case strings.HasSuffix(strings.ToLower(key), ".json.gz"):
		return ContentTypeGzip
	}
	switch strings.ToLower(path.Ext(key)) {
	case ".png":
		return ContentTypePNG
	case ".webp":
		return ContentTypeWebP
	case ".json":
		return ContentTypeJSON
	case ".gz":
		return ContentTypeGzip
	}
	return "application/octet-stream"
}
