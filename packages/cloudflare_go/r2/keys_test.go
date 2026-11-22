package r2

import (
	"errors"
	"testing"
)

const (
	monitorID = "8dea949d-d40b-49f6-8f9a-9e31f891eb4e"
	runID     = "2136440b-8e77-4a2d-8fe2-fcaea8af11f7"
)

// must unwraps a key builder's result; the inputs in these tests are valid,
// so an error is a bug in the builder.
func must(key string, err error) string {
	if err != nil {
		panic(err)
	}
	return key
}

func TestKeyBuildersProduceTheDocumentedLayout(t *testing.T) {
	cases := []struct {
		name string
		got  func() (string, error)
		want string
	}{
		{"shot png", func() (string, error) { return CaptureShotKey(monitorID, runID, "png") }, "captures/" + monitorID + "/" + runID + "/shot.png"},
		{"shot webp", func() (string, error) { return CaptureShotKey(monitorID, runID, ".WEBP") }, "captures/" + monitorID + "/" + runID + "/shot.webp"},
		{"learn", func() (string, error) { return LearnShotKey(monitorID, runID, 2, "png") }, "captures/" + monitorID + "/" + runID + "/learn-2.png"},
		{"blocks", func() (string, error) { return BlocksKey(monitorID, runID) }, "captures/" + monitorID + "/" + runID + "/blocks.json.gz"},
		{"change", func() (string, error) { return ChangeRecordKey(monitorID, runID) }, "changes/" + monitorID + "/" + runID + ".json.gz"},
		{"diff", func() (string, error) { return ChangeDiffKey(monitorID, runID) }, "changes/" + monitorID + "/" + runID + "-diff.png"},
		{"crop", func() (string, error) { return ChangeCropKey(monitorID, runID) }, "changes/" + monitorID + "/" + runID + "-crop.png"},
		{"state", func() (string, error) { return StorageStateKey(monitorID) }, "state/" + monitorID + ".json"},
		{"upper-case ids", func() (string, error) { return StorageStateKey("8DEA949D-D40B-49F6-8F9A-9E31F891EB4E") }, "state/" + monitorID + ".json"},
		{"step 0", func() (string, error) { return StepShotKey(monitorID, runID, 0) }, "steps/" + monitorID + "/" + runID + "/0.webp"},
		{"step 12", func() (string, error) { return StepShotKey(monitorID, runID, 12) }, "steps/" + monitorID + "/" + runID + "/12.webp"},
		{"step upper-case ids", func() (string, error) { return StepShotKey(monitorID, "2136440B-8E77-4A2D-8FE2-FCAEA8AF11F7", 3) }, "steps/" + monitorID + "/" + runID + "/3.webp"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := tc.got()
			if err != nil {
				t.Fatalf("builder returned error: %v", err)
			}
			if got != tc.want {
				t.Errorf("got = %v, want %v", got, tc.want)
			}
			if !ValidKey(got) {
				t.Errorf("ValidKey(%q) = false", got)
			}
		})
	}
}

func TestKeyBuildersRejectBadInput(t *testing.T) {
	cases := map[string]func() (string, error){
		"monitor not uuid": func() (string, error) { return CaptureShotKey("nope", runID, "png") },
		"run not uuid":     func() (string, error) { return BlocksKey(monitorID, "42") },
		"traversal":        func() (string, error) { return StorageStateKey("../../etc") },
		"bad format":       func() (string, error) { return CaptureShotKey(monitorID, runID, "jpg") },
		"learn index 3":    func() (string, error) { return LearnShotKey(monitorID, runID, 3, "png") },
		"learn index -1":   func() (string, error) { return LearnShotKey(monitorID, runID, -1, "png") },
		"change not uuid":  func() (string, error) { return ChangeRecordKey(monitorID, "x") },
		"step seq -1":      func() (string, error) { return StepShotKey(monitorID, runID, -1) },
		"step seq huge":    func() (string, error) { return StepShotKey(monitorID, runID, 1_000_000_000) },
		"step subject":     func() (string, error) { return StepShotKey(monitorID, "run-7", 0) },
		"step monitor":     func() (string, error) { return StepShotKey("nope", runID, 0) },
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			if got, err := build(); !errors.Is(err, ErrInvalidKey) {
				t.Errorf("got = %q, %v; want ErrInvalidKey", got, err)
			}
		})
	}
}

func TestParseKeyReturnsTheMonitorAndKind(t *testing.T) {
	learn := must(LearnShotKey(monitorID, runID, 1, "webp"))
	k, err := ParseKey(learn)
	if err != nil {
		t.Fatalf("ParseKey: %v", err)
	}
	want := Key{Raw: learn, Prefix: PrefixCaptures, Kind: KindLearn, MonitorID: monitorID, RunID: runID, LearnIndex: 1, StepSeq: -1, ContentType: ContentTypeWebP}
	if k != want {
		t.Errorf("got = %+v, want %+v", k, want)
	}

	crop := must(ChangeCropKey(monitorID, runID))
	k, err = ParseKey(crop)
	if err != nil {
		t.Fatalf("ParseKey: %v", err)
	}
	want = Key{Raw: crop, Prefix: PrefixChanges, Kind: KindCrop, MonitorID: monitorID, ChangeID: runID, LearnIndex: -1, StepSeq: -1, ContentType: ContentTypePNG}
	if k != want {
		t.Errorf("got = %+v, want %+v", k, want)
	}

	// A step screenshot: the second UUID is a Run or a Macro version.
	step := must(StepShotKey(monitorID, runID, 7))
	k, err = ParseKey(step)
	if err != nil {
		t.Fatalf("ParseKey: %v", err)
	}
	want = Key{Raw: step, Prefix: PrefixSteps, Kind: KindStep, MonitorID: monitorID, SubjectID: runID, LearnIndex: -1, StepSeq: 7, ContentType: ContentTypeWebP}
	if k != want {
		t.Errorf("got = %+v, want %+v", k, want)
	}

	state := must(StorageStateKey(monitorID))
	k, err = ParseKey(state)
	if err != nil || k.Kind != KindState || k.MonitorID != monitorID || k.ContentType != ContentTypeJSON {
		t.Errorf("got = %+v, %v", k, err)
	}

	blocks := must(BlocksKey(monitorID, runID))
	if k, _ := ParseKey(blocks); k.ContentType != ContentTypeGzip || k.Kind != KindBlocks {
		t.Errorf("got = %+v", k)
	}
}

func TestParseKeyRejectsMalformedAndOldKeys(t *testing.T) {
	for _, raw := range []string{
		"",
		"screenshots/" + monitorID + "/" + runID + ".png",
		"diffs/" + monitorID + "/" + runID + ".png",
		"captures/" + monitorID + "/" + runID + "/shot.jpg",
		"captures/" + monitorID + "/" + runID + "/learn-3.png",
		"captures/" + monitorID + "/" + runID + "/shot.png/extra",
		"captures/8DEA949D-D40B-49F6-8F9A-9E31F891EB4E/" + runID + "/shot.png",
		"../captures/" + monitorID + "/" + runID + "/shot.png",
		"changes/" + monitorID + "/" + runID + ".json",
		"changes/" + monitorID + "/" + runID + "-other.png",
		"state/" + monitorID + ".json.gz",
		"state/" + monitorID + "/" + runID + ".json",
		"steps/" + monitorID + "/" + runID + "/0.png",
		"steps/" + monitorID + "/" + runID + "/-1.webp",
		"steps/" + monitorID + "/" + runID + "/07.webp",
		"steps/" + monitorID + "/" + runID + "/1.5.webp",
		"steps/" + monitorID + "/" + runID + "/x.webp",
		"steps/" + monitorID + "/" + runID + "/.webp",
		"steps/" + monitorID + "/" + runID + "/1234567890.webp",
		"steps/" + monitorID + "/3.webp",
		"steps/" + monitorID + "/" + runID + "/3.webp/extra",
		"steps/8DEA949D-D40B-49F6-8F9A-9E31F891EB4E/" + runID + "/3.webp",
		"steps/" + monitorID + "/run-7/3.webp",
	} {
		if _, err := ParseKey(raw); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("ParseKey(%q) = %v, want ErrInvalidKey", raw, err)
		}
	}
}

func TestMonitorPrefix(t *testing.T) {
	cases := map[Prefix]string{
		PrefixCaptures: "captures/" + monitorID + "/",
		PrefixChanges:  "changes/" + monitorID + "/",
		PrefixState:    "state/" + monitorID,
		PrefixSteps:    "steps/" + monitorID + "/",
	}
	for p, want := range cases {
		got, err := MonitorPrefix(p, monitorID)
		if err != nil || got != want {
			t.Errorf("MonitorPrefix(%s) = %q, %v; want %q", p, got, err, want)
		}
	}
	if _, err := MonitorPrefix(Prefix("screenshots"), monitorID); !errors.Is(err, ErrInvalidKey) {
		t.Errorf("got = %v, want ErrInvalidKey", err)
	}
	if _, err := MonitorPrefix(PrefixCaptures, "nope"); !errors.Is(err, ErrInvalidKey) {
		t.Errorf("got = %v, want ErrInvalidKey", err)
	}
}

func TestContentTypeForKey(t *testing.T) {
	cases := map[string]string{
		must(CaptureShotKey(monitorID, runID, "webp")): ContentTypeWebP,
		must(ChangeDiffKey(monitorID, runID)):          ContentTypePNG,
		must(BlocksKey(monitorID, runID)):              ContentTypeGzip,
		must(StorageStateKey(monitorID)):               ContentTypeJSON,
		must(StepShotKey(monitorID, runID, 4)):         ContentTypeWebP,
		"a/b/c.bin":                                    "application/octet-stream",
	}
	for key, want := range cases {
		if got := ContentTypeForKey(key); got != want {
			t.Errorf("ContentTypeForKey(%q) = %v, want %v", key, got, want)
		}
	}
}
