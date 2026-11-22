package changerecord

import (
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/decide"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
)

// BuildInput is everything a Change Record is built from.
type BuildInput struct {
	ChangeID string
	Monitor  monitor.Config
	From     RunRef
	To       RunRef
	Verdict  decide.Verdict
	// Step is the evidence for From → To.
	Step diff.Evidence
	// Summary, Items, Ignored and Agent are the agent's answer. Items cite
	// Step's text ops and regions by index; Build runs them through Guard.
	// All are zero when the agent was not asked.
	Summary string
	Items   []Item
	Ignored []Ignored
	Agent   *AgentVerdict
	// Cumulative is the evidence from the last notified Capture, when that
	// is not From; CumulativeFrom describes that Capture.
	Cumulative     *diff.Evidence
	CumulativeFrom RunRef
	DiffImageKey   string
	CropKey        string
	Now            time.Time
}

// Build assembles the Change Record. An empty Summary stays empty: the
// render package owns the sentence built from evidence, and the caller
// fills it in.
func Build(in BuildInput) Record {
	r := Record{
		Version: Version,
		ID:      in.ChangeID,
		Monitor: MonitorRef{
			ID:           in.Monitor.ID,
			Name:         in.Monitor.Name,
			URL:          in.Monitor.URL,
			Instructions: in.Monitor.EffectiveInstructions(),
		},
		From:         in.From,
		To:           in.To,
		Status:       in.Verdict.Status,
		Summary:      in.Summary,
		Items:        []Item{},
		Ignored:      in.Ignored,
		Why:          in.Verdict.Why,
		SuppressedBy: in.Verdict.SuppressedBy,
		Magnitude:    MagnitudeOf(in.Step),
		Agent:        in.Agent,
		Sections:     sectionRefs(in.Monitor.WatchPlan),
		CreatedAt:    in.Now.UTC(),
	}
	if r.Ignored == nil {
		r.Ignored = []Ignored{}
	}
	if r.Why == nil {
		r.Why = []decide.Why{}
	}
	if r.SuppressedBy == nil {
		r.SuppressedBy = []string{}
	}

	var ops []diff.TextOp
	var regions []diff.Region
	if in.Step.Text != nil {
		r.Text = TextSectionOf(in.Step.Text)
		ops = r.Text.Ops
	}
	if v := in.Step.Visual; v != nil {
		regions = v.Regions
		if regions == nil {
			regions = []diff.Region{}
		}
		r.Visual = &VisualSection{
			Regions:    regions,
			Shift:      v.Shift,
			AreaRatio:  v.AreaRatio,
			SizeBefore: v.SizeBefore,
			SizeAfter:  v.SizeAfter,
			DiffImage:  in.DiffImageKey,
			Crop:       in.CropKey,
		}
	}
	r.Items = Guard(in.Items, ops, regions)

	if in.Cumulative != nil && in.Cumulative.Text != nil {
		r.Cumulative = &Cumulative{
			From:      in.CumulativeFrom,
			Text:      TextSectionOf(in.Cumulative.Text),
			Magnitude: MagnitudeOf(*in.Cumulative),
		}
	}
	return r
}

// MagnitudeOf merges the magnitudes of both Comparators.
func MagnitudeOf(ev diff.Evidence) Magnitude {
	var m Magnitude
	if t := ev.Text; t != nil {
		m.WordsAdded = t.Magnitude.WordsAdded
		m.WordsRemoved = t.Magnitude.WordsRemoved
		m.BlocksChanged = t.Magnitude.BlocksChanged
		m.Moves = t.Magnitude.Moves
		m.ChangeRatio = t.Magnitude.ChangeRatio
		m.NetAdded = t.Magnitude.NetAdded
		m.NetRemoved = t.Magnitude.NetRemoved
	}
	if v := ev.Visual; v != nil {
		m.AreaRatio = v.AreaRatio
	}
	return m
}

// TextSectionOf turns text evidence into the record's text section.
func TextSectionOf(t *diff.TextEvidence) *TextSection {
	ops := t.Ops
	if ops == nil {
		ops = []diff.TextOp{}
	}
	masked := t.Masked
	if masked == nil {
		masked = []string{}
	}
	return &TextSection{Ops: ops, IgnoredCount: t.IgnoredCount, Masked: masked}
}

func sectionRefs(plan *monitor.WatchPlan) []SectionRef {
	out := []SectionRef{}
	if plan == nil {
		return out
	}
	for _, s := range plan.Sections {
		out = append(out, SectionRef{ID: s.ID, Name: s.Name, How: string(s.How)})
	}
	return out
}
