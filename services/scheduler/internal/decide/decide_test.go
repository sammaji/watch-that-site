package decide

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

var (
	identical = diff.Evidence{Text: &diff.TextEvidence{}, Visual: &diff.VisualEvidence{}}
	textDiff  = diff.Evidence{Text: &diff.TextEvidence{Ops: []diff.TextOp{{Op: diff.OpModify, Path: "/html/body/p"}}}}
	lookDiff  = diff.Evidence{
		Text:   &diff.TextEvidence{},
		Visual: &diff.VisualEvidence{Regions: []diff.Region{{Box: geom.Rect{0, 0, 10, 10}, Kind: diff.RegionChanged, Pixels: 100}}},
	}
	ignoredOnly = diff.Evidence{Text: &diff.TextEvidence{Ops: []diff.TextOp{{Op: diff.OpIgnored, Path: "/html/body/aside"}}, IgnoredCount: 1}}
	shiftOnly   = diff.Evidence{Text: &diff.TextEvidence{}, Visual: &diff.VisualEvidence{Shift: &diff.Shift{FromY: 100, DY: 48}}}

	relevant    = &Answer{Relevant: true}
	notRelevant = &Answer{}
	unavailable = &Answer{Unavailable: true}
)

func TestNeedsAgent(t *testing.T) {
	require.False(t, NeedsAgent(identical))
	require.False(t, NeedsAgent(diff.Evidence{}), "no Comparator ran")
	require.False(t, NeedsAgent(ignoredOnly), "ignored Sections never reach the model")
	require.False(t, NeedsAgent(shiftOnly))
	require.True(t, NeedsAgent(textDiff))
	require.True(t, NeedsAgent(lookDiff))
}

func TestDecide(t *testing.T) {
	cases := []struct {
		name       string
		in         Input
		status     Status
		suppressed []string
		// why lists the kind:reason of every Why, in order.
		why      []string
		confirms bool
		drops    bool
	}{
		{name: "identical", in: Input{Evidence: identical}, status: StatusNone},
		{name: "identical, confirm on", in: Input{Evidence: identical, ConfirmChanges: true}, status: StatusNone},
		{name: "content only moved", in: Input{Evidence: shiftOnly}, status: StatusNone, why: []string{"note:shift_only"}},
		{name: "only ignored Sections differ", in: Input{Evidence: ignoredOnly},
			status: StatusNoise, suppressed: []string{ReasonIgnoredSection}, why: []string{"suppressed:ignored_section"}},

		{name: "relevant", in: Input{Evidence: textDiff, Agent: relevant},
			status: StatusChange, why: []string{"agent:"}},
		{name: "relevant, visual only", in: Input{Evidence: lookDiff, Agent: relevant},
			status: StatusChange, why: []string{"agent:"}},
		{name: "not relevant", in: Input{Evidence: textDiff, Agent: notRelevant},
			status: StatusNoise, suppressed: []string{ReasonNotRelevant}, why: []string{"suppressed:not_relevant"}},
		{name: "agent unavailable fails open", in: Input{Evidence: textDiff, Agent: unavailable},
			status: StatusChange, why: []string{"note:agent_unavailable"}},
		{name: "no answer at all fails open", in: Input{Evidence: textDiff},
			status: StatusChange, why: []string{"note:agent_unavailable"}},

		{name: "relevant, confirm on: seen once", in: Input{Evidence: textDiff, Agent: relevant, ConfirmChanges: true},
			status: StatusPending, why: []string{"agent:", "persistence:persistence"}},
		{name: "unavailable, confirm on: still waits", in: Input{Evidence: textDiff, Agent: unavailable, ConfirmChanges: true},
			status: StatusPending, why: []string{"note:agent_unavailable", "persistence:persistence"}},
		{name: "not relevant, confirm on", in: Input{Evidence: textDiff, Agent: notRelevant, ConfirmChanges: true},
			status: StatusNoise, suppressed: []string{ReasonNotRelevant}, why: []string{"suppressed:not_relevant"}},

		{name: "pending confirmed", in: Input{Evidence: textDiff, Agent: relevant, ConfirmChanges: true, Pending: true},
			status: StatusChange, why: []string{"agent:", "persistence:persistence"}, confirms: true},
		{name: "pending confirmed after the setting was switched off", in: Input{Evidence: textDiff, Agent: relevant, Pending: true},
			status: StatusChange, why: []string{"agent:", "persistence:persistence"}, confirms: true},
		{name: "pending, difference gone", in: Input{Evidence: identical, ConfirmChanges: true, Pending: true},
			status: StatusNoise, suppressed: []string{ReasonDidNotPersist}, why: []string{"suppressed:did_not_persist"}, drops: true},
		{name: "pending, only ignored Sections left", in: Input{Evidence: ignoredOnly, ConfirmChanges: true, Pending: true},
			status: StatusNoise, suppressed: []string{ReasonDidNotPersist}, why: []string{"suppressed:did_not_persist"}, drops: true},
		{name: "pending, now not relevant", in: Input{Evidence: textDiff, Agent: notRelevant, ConfirmChanges: true, Pending: true},
			status: StatusNoise, suppressed: []string{ReasonNotRelevant}, why: []string{"suppressed:not_relevant"}, drops: true},
		{name: "pending, agent unavailable on the confirm Run", in: Input{Evidence: textDiff, Agent: unavailable, ConfirmChanges: true, Pending: true},
			status: StatusChange, why: []string{"note:agent_unavailable", "persistence:persistence"}, confirms: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := Decide(tc.in)
			require.Equal(t, tc.status, v.Status)
			if tc.suppressed == nil {
				tc.suppressed = []string{}
			}
			require.Equal(t, tc.suppressed, v.SuppressedBy)
			why := []string{}
			for _, w := range v.Why {
				require.NotEmpty(t, w.Detail)
				why = append(why, w.Kind+":"+w.Reason)
			}
			if tc.why == nil {
				tc.why = []string{}
			}
			require.Equal(t, tc.why, why)
			require.Equal(t, tc.confirms, v.ConfirmsPending)
			require.Equal(t, tc.drops, v.DropsPending)

			// A Change is never recorded without a counted difference.
			if v.Status == StatusChange || v.Status == StatusPending {
				require.Positive(t, tc.in.Evidence.Counted())
			}
			// Suppression always says why.
			if v.Status == StatusNoise {
				require.Len(t, v.SuppressedBy, 1)
			}
		})
	}
}

func TestDecideIsPure(t *testing.T) {
	in := Input{Evidence: textDiff, Agent: relevant, ConfirmChanges: true}
	require.Equal(t, Decide(in), Decide(in))
}
