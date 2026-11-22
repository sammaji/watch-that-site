package capture

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// testdata/capture-v3.json is written from the Capture type in
// packages/types/src/protocol.ts: every top-level field present, a Macro
// result included. Decode rejects unknown fields, so a field added on one
// side only fails here.
func TestGoldenCaptureDecodesStrictly(t *testing.T) {
	raw, err := os.ReadFile("testdata/capture-v3.json")
	require.NoError(t, err)

	c, err := Decode(raw)
	require.NoError(t, err)
	require.Equal(t, Version, c.Version)
	require.True(t, c.Valid())
	require.Len(t, c.Blocks, 5)
	require.NotNil(t, c.Screenshot)
	require.Len(t, c.Masks, 1)
	require.NotEmpty(t, c.Meta.EnvVersion)

	require.NotNil(t, c.Macro)
	require.Equal(t, MacroRepaired, c.Macro.Status)
	require.Nil(t, c.Macro.FailedStep)
	require.Equal(t, 1840, c.Macro.InputTokens)
	require.Equal(t, "9a4e1d7c-62f8-4a0b-8a3e-6c1f2b7d9e02", *c.Macro.Effective())
}

// minimal is the smallest valid v3 body, with the given extra fields.
func minimal(extra string) []byte {
	return []byte(`{"version":3,"run_id":"r","monitor_id":"m","status":"ok","invalid_reason":null,"error":null,
		"blocks":[],"truncated":false,"screenshot":null,"masks":[],
		"meta":{"http_status":200,"final_url":"","title":"","stable":true,"env_version":"e","timings_ms":{"load":0,"settle":0,"total":0}},
		"macro":null` + extra + `}`)
}

func TestDecodeAcceptsACaptureWithoutAMacro(t *testing.T) {
	c, err := Decode(minimal(""))
	require.NoError(t, err)
	require.Nil(t, c.Macro)
	require.Nil(t, c.Macro.Effective())
}

func TestDecodeRejectsUnknownFields(t *testing.T) {
	_, err := Decode(minimal(`,"extra":1`))
	require.Error(t, err)

	// Fields of Capture v2 that v3 dropped are unknown now.
	for _, old := range []string{`,"data":null`, `,"learning":null`} {
		_, err := Decode(minimal(old))
		require.Error(t, err, old)
	}
	// So are unknown fields inside the Macro result.
	_, err = Decode([]byte(strings.Replace(string(minimal("")), `"macro":null`,
		`"macro":{"macro_id":"x","status":"ok","failed_step":null,"repaired_macro_id":null,"input_tokens":0,"output_tokens":0,"steps":[]}`, 1)))
	require.Error(t, err)
}

func TestDecodeRejectsOtherVersions(t *testing.T) {
	_, err := Decode([]byte(strings.Replace(string(minimal("")), `"version":3`, `"version":2`, 1)))
	require.ErrorContains(t, err, "version")
}

func TestValidateInvalidReasons(t *testing.T) {
	c := Capture{Version: Version, RunID: "r", MonitorID: "m", Status: StatusInvalid}
	require.Error(t, c.Validate(), "an invalid Capture needs a reason")

	for _, reason := range []string{ReasonHTTPStatus, ReasonChallenge, ReasonEmpty, ReasonBlankScreenshot, ReasonCrossDomain, ReasonMacroFailed} {
		c.InvalidReason = &reason
		require.NoError(t, c.Validate(), reason)
	}
	// scope_missing went away with Scopes; partial is the scheduler's own.
	for _, reason := range []string{"scope_missing", ReasonPartial} {
		c.InvalidReason = &reason
		require.Error(t, c.Validate(), reason)
	}
}

func TestValidateMacroResult(t *testing.T) {
	c := Capture{Version: Version, RunID: "r", MonitorID: "m", Status: StatusOK}
	c.Macro = &MacroResult{MacroID: "x", Status: "skipped"}
	require.Error(t, c.Validate())
	c.Macro = &MacroResult{Status: MacroOK}
	require.Error(t, c.Validate())
	c.Macro = &MacroResult{MacroID: "x", Status: MacroFailed}
	require.NoError(t, c.Validate())
	require.Equal(t, "x", *c.Macro.Effective())
}

func TestSimHashIsStableAndClose(t *testing.T) {
	a := SimHash("the quick brown fox jumps over the lazy dog today")
	b := SimHash("the quick brown fox jumps over the lazy dog today")
	c := SimHash("the quick brown fox jumps over the lazy cat today")
	require.Equal(t, a, b)
	require.Less(t, Hamming(a, c), 32)
}
