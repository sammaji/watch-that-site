// Package decide turns what a Run found into its verdict. It is a pure
// function: no database, network or clock. What counts as a Change is the
// agent's call; what is left here is the bookkeeping around it: nothing
// differed, only ignored Sections differed, a Change waiting to be confirmed,
// a difference that did not persist.
package decide

import "github.com/sammaji/watchthatsite/services/scheduler/internal/diff"

// Status is a verdict's outcome.
type Status string

const (
	// StatusNone: nothing the Monitor watches differs. No Change row.
	StatusNone Status = "none"
	// StatusNoise: a difference was recorded but nobody is told.
	StatusNoise Status = "noise"
	// StatusPending: a Change seen once on a Monitor that confirms Changes
	// on the next Run before alerting.
	StatusPending Status = "pending"
	// StatusChange: Reactions fire.
	StatusChange Status = "change"
)

// Reasons, stored in changes.suppressed_by and in Why.Reason.
const (
	// ReasonNotRelevant: the agent found nothing that matches the Monitor's
	// instructions.
	ReasonNotRelevant = "not_relevant"
	// ReasonDidNotPersist: a pending Change was gone by the confirm Run.
	ReasonDidNotPersist = "did_not_persist"
	// ReasonIgnoredSection: only parts of the page the Watch Plan does not
	// watch as text differed.
	ReasonIgnoredSection = "ignored_section"
	// NotePersistence marks the two lines about confirming a Change.
	NotePersistence = "persistence"
	// NoteAgentUnavailable: the agent could not be asked, so the difference
	// was sent as it is.
	NoteAgentUnavailable = "agent_unavailable"
	// NoteShiftOnly: content moved on the screenshot and nothing else
	// changed.
	NoteShiftOnly = "shift_only"
)

// Why kinds.
const (
	WhyAgent       = "agent"
	WhySuppressed  = "suppressed"
	WhyPersistence = "persistence"
	WhyNote        = "note"
)

// Why is one plain-language line about how the verdict was reached.
type Why struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason,omitempty"`
	Detail string `json:"detail"`
}

// Answer is what the agent said about a difference, as far as the verdict
// needs it.
type Answer struct {
	// Relevant: the difference matches what the owner asked to be told about.
	Relevant bool
	// Unavailable: the agent could not be asked. The difference is then
	// treated as relevant, so the product keeps working without a model.
	Unavailable bool
}

// Input is everything Decide needs.
type Input struct {
	// Evidence compares the baseline with this Capture. With a pending
	// Change, the baseline is the Capture the pending Change started from.
	Evidence diff.Evidence
	// Pending is true when a Change is waiting for this Run to confirm it.
	Pending bool
	// ConfirmChanges is the Monitor's setting: re-check a Change on the next
	// Run before alerting.
	ConfirmChanges bool
	// Agent is the agent's answer. It must be set when NeedsAgent(Evidence)
	// and is not read otherwise.
	Agent *Answer
}

// Verdict is Decide's output.
type Verdict struct {
	Status       Status   `json:"status"`
	SuppressedBy []string `json:"suppressed_by"`
	Why          []Why    `json:"why"`
	// ConfirmsPending and DropsPending report what happened to a pending
	// Change.
	ConfirmsPending bool `json:"confirms_pending,omitempty"`
	DropsPending    bool `json:"drops_pending,omitempty"`
}

// NeedsAgent reports whether the evidence holds a difference the agent has to
// judge. Identical Captures, and differences only in ignored Sections, never
// reach the model.
func NeedsAgent(e diff.Evidence) bool { return e.Counted() > 0 }

// Decide turns the evidence, the pending state, the Monitor's confirm
// setting and the agent's answer into a verdict:
//
//   - no counted difference: `noise` (did_not_persist) when a Change was
//     pending, `noise` (ignored_section) when only ignored Sections differ,
//     else `none`;
//   - the agent says it is not relevant: `noise` (not_relevant);
//   - relevant, or the agent was unavailable: `change`, or `pending` first
//     when the Monitor confirms Changes and none is pending yet.
//
// A `change` or `pending` verdict always has Evidence.Counted() > 0, and
// every verdict but a plain `none` carries at least one Why.
func Decide(in Input) Verdict {
	v := Verdict{SuppressedBy: []string{}, Why: []Why{}}

	if !NeedsAgent(in.Evidence) {
		switch {
		case in.Pending:
			v.DropsPending = true
			return suppress(v, ReasonDidNotPersist, "The change was gone by the next check, so no alert was sent.")
		case in.Evidence.Text.HasIgnored():
			return suppress(v, ReasonIgnoredSection, "Only parts of the page this Monitor does not watch changed, so no alert was sent.")
		}
		v.Status = StatusNone
		if vis := in.Evidence.Visual; vis != nil && vis.Shift != nil {
			v.Why = append(v.Why, Why{Kind: WhyNote, Reason: NoteShiftOnly, Detail: "Content moved on the page but nothing else changed."})
		}
		return v
	}

	// Without an answer there is nobody to say the difference is noise.
	answer := Answer{Unavailable: true}
	if in.Agent != nil {
		answer = *in.Agent
	}

	if !answer.Unavailable && !answer.Relevant {
		v.DropsPending = in.Pending
		return suppress(v, ReasonNotRelevant, "The agent compared the two Captures and found nothing that matches this Monitor's instructions, so no alert was sent.")
	}

	if answer.Unavailable {
		v.Why = append(v.Why, Why{Kind: WhyNote, Reason: NoteAgentUnavailable, Detail: "The agent could not be reached, so this difference was sent without its review."})
	} else {
		v.Why = append(v.Why, Why{Kind: WhyAgent, Detail: "The agent found a change that matches this Monitor's instructions."})
	}

	switch {
	case in.Pending:
		v.Status = StatusChange
		v.ConfirmsPending = true
		v.Why = append(v.Why, Why{Kind: WhyPersistence, Reason: NotePersistence, Detail: "Seen on two consecutive checks."})
	case in.ConfirmChanges:
		v.Status = StatusPending
		v.Why = append(v.Why, Why{Kind: WhyPersistence, Reason: NotePersistence, Detail: "Seen once, waiting for the next check to confirm."})
	default:
		v.Status = StatusChange
	}
	return v
}

// suppress turns v into a noise verdict with one suppressed Why.
func suppress(v Verdict, reason, detail string) Verdict {
	v.Status = StatusNoise
	v.SuppressedBy = append(v.SuppressedBy, reason)
	v.Why = append(v.Why, Why{Kind: WhySuppressed, Reason: reason, Detail: detail})
	return v
}
