package bridge

import (
	"fmt"

	"github.com/jonstump/nms-base-planner/internal/domain"
)

// Stages 2 and 3 on the wire: what a plan builds at each base, and what it
// costs in power.
//
// Governing: ADR-0003 (Go domain, thin adapter), SPEC-0002 REQ "Boundary
// Surface", REQ "Exact Quantity Encoding", REQ "Result Envelope",
// REQ "Determinism Across the Boundary"
//
// Every rule stage 1 established holds here unchanged, and one of them is
// load-bearing in a way it was not before. Stages 2 and 3 round: plants,
// biodomes, extractors, depots, fauna, processors, batteries and the
// additional-generator fix are all counts that round up at a physical
// boundary. SPEC-0001 enumerates those boundaries and the domain owns every
// one of them, so this file reads already-rounded int64s and renders them.
// It performs no arithmetic at all — not even the subtraction that turns
// generation and draw into a balance, which is why PowerBudget.Balance()
// and .Deficit() are called rather than computed here.

// Site is one base's configuration. It crosses inbound as part of a rollup
// request and outbound on each base's build, so a caller can read back the
// configuration a result was computed under.
type Site struct {
	ExtractorClass string   `json:"extractorClass"`
	FillSeconds    Quantity `json:"fillSeconds"`
}

// Curated is the Tier 2 constant set on the wire.
//
// Governing: SPEC-0001 design.md "Tier 2 constants injected, never
// hardcoded" — the engine refuses to default any of these, so they cross
// with the request rather than living in the module.
//
// Every scalar is a Quantity for the same reason node totals are: a count
// that crosses as a JSON number has left the exactness contract, and a
// uniform rule is checkable where a per-field judgement is not.
type Curated struct {
	BiodomeCropSlots   Quantity `json:"biodomeCropSlots"`
	FaunaYieldPerCycle Quantity `json:"faunaYieldPerCycle"`
	FaunaCycleSeconds  Quantity `json:"faunaCycleSeconds"`
	StepsPerProcessor  Quantity `json:"stepsPerProcessor"`
	DepotThreshold     Quantity `json:"depotThreshold"`
	ProcessSeconds     Quantity `json:"processSeconds"`
	PanelsPerBattery   Quantity `json:"panelsPerBattery"`

	// FaunaProducts and ResourceHotspots are classification rather than
	// scalars — which leaves come from creatures, and which hotspot
	// category each extracted resource sits on.
	FaunaProducts    []string          `json:"faunaProducts,omitempty"`
	ResourceHotspots map[string]string `json:"resourceHotspots,omitempty"`
}

// Byproduct declares that one producer's output covers another item's
// demand at the same base.
type Byproduct struct {
	Item string `json:"item"`
	From string `json:"from"`
}

// KitchenStepRequest names one processing step the plan calls for.
type KitchenStepRequest struct {
	ItemID   string   `json:"itemId"`
	Recipe   string   `json:"recipe"`
	Quantity Quantity `json:"quantity"`
}

// RollupRequest is stage 2's input.
//
// It carries the plan rather than a resolved graph: REQ "Boundary Surface"
// requires one call to perform one complete stage, and a caller obliged to
// hand back a graph it received would be assembling the stage out of two
// crossings.
type RollupRequest struct {
	Plan        Plan                            `json:"plan"`
	Assignments map[string]string               `json:"assignments,omitempty"`
	Sites       map[string]Site                 `json:"sites,omitempty"`
	Byproducts  map[string][]Byproduct          `json:"byproducts,omitempty"`
	Kitchen     map[string][]KitchenStepRequest `json:"kitchen,omitempty"`
	Constants   Curated                         `json:"constants"`
}

// PowerGeneration is one base's generation setup.
//
// Electromagnetic generators and solar panels are independent counts rather
// than a choice between two modes, because the domain models them that way:
// a base may run both, and PowerConfig carries all three values at once.
type PowerGeneration struct {
	EMGenerators Quantity `json:"emGenerators,omitempty"`
	EMClass      string   `json:"emClass,omitempty"`
	SolarPanels  Quantity `json:"solarPanels,omitempty"`
}

// PowerUnit is a count of one buildable drawing power at a base.
type PowerUnit struct {
	PartID string   `json:"partId"`
	Count  Quantity `json:"count"`
}

// PowerRequest is stage 3's input.
//
// It carries no plan. The domain's power stage takes counts rather than
// producer rows, so it costs a base sketched by hand exactly as it costs
// one a rollup produced, and requiring a plan here would invent a coupling
// the engine does not have.
type PowerRequest struct {
	// Sources, not "generation": the response's generation field is a
	// quantity, and one word meaning a configuration inbound and a figure
	// outbound is a needless thing for a consumer to hold in mind.
	Sources map[string]PowerGeneration `json:"sources,omitempty"`
	Draws   map[string][]PowerUnit     `json:"draws,omitempty"`

	// Unverified names the bases whose contributing figures are not
	// verified. A list rather than a map to bool: the set is what is meant,
	// and a map with false values would encode a distinction that is not one.
	Unverified []string `json:"unverified,omitempty"`

	Constants Curated `json:"constants"`
}

// Demand is one leaf's requirement on the wire.
type Demand struct {
	ItemID   string   `json:"itemId"`
	Name     string   `json:"name"`
	Total    Quantity `json:"total"`
	Verified bool     `json:"verified"`
}

// YieldRange is a crop's per-plant yield range.
//
// Both bounds cross. The domain sizes plant counts on the pessimistic
// bound, and a view given only that number could not show why.
type YieldRange struct {
	Min Quantity `json:"min"`
	Max Quantity `json:"max"`
}

// FarmRow is one crop at one base.
type FarmRow struct {
	ItemID        string     `json:"itemId"`
	Name          string     `json:"name"`
	Required      Quantity   `json:"required"`
	Plants        Quantity   `json:"plants"`
	Biodomes      Quantity   `json:"biodomes"`
	YieldPerPlant YieldRange `json:"yieldPerPlant"`
	GrowthSeconds Quantity   `json:"growthSeconds"`
}

// ExtractorRow is one extracted resource at one base.
type ExtractorRow struct {
	ItemID   string   `json:"itemId"`
	Name     string   `json:"name"`
	Class    string   `json:"class"`
	Required Quantity `json:"required"`
	// ExtractorCount is qualified where Plants and Depots are not, because
	// the unqualified name is already the section holding this row: a
	// consumer reading bases[0].extractors[0].extractors twice in one path
	// has to work out which is the array.
	ExtractorCount Quantity `json:"extractorCount"`
	Depots         Quantity `json:"depots"`

	// RatePerSecond is one extractor's output at the site's class, and
	// FillSeconds how long the built extractors actually take — at most the
	// configured duration, and usually less because the count rounded up.
	RatePerSecond Quantity `json:"ratePerSecond"`
	FillSeconds   Quantity `json:"fillSeconds"`
}

// RanchRow is one fauna product at one base.
type RanchRow struct {
	ItemID       string   `json:"itemId"`
	Name         string   `json:"name"`
	Required     Quantity `json:"required"`
	Fauna        Quantity `json:"fauna"`
	CycleSeconds Quantity `json:"cycleSeconds"`
}

// KitchenInput is one ingredient of a processing step.
type KitchenInput struct {
	ItemID    string   `json:"itemId"`
	PerOutput Quantity `json:"perOutput"`
}

// KitchenStep is one nutrient processor step.
type KitchenStep struct {
	ItemID         string         `json:"itemId"`
	Name           string         `json:"name"`
	Recipe         string         `json:"recipe"`
	Required       Quantity       `json:"required"`
	ProcessSeconds Quantity       `json:"processSeconds"`
	Final          bool           `json:"final"`
	Inputs         []KitchenInput `json:"inputs,omitempty"`
}

// NoBuildRow is an item a byproduct at the same base already covers.
//
// Carried explicitly rather than omitted: a demand met without construction
// is a planning result, and an absent row is indistinguishable from an
// overlooked requirement.
type NoBuildRow struct {
	ItemID   string   `json:"itemId"`
	Name     string   `json:"name"`
	From     string   `json:"from"`
	Required Quantity `json:"required"`
}

// BaseBuild is one base's construction instructions.
type BaseBuild struct {
	Base string `json:"base"`
	Site Site   `json:"site"`

	Farms      []FarmRow      `json:"farms,omitempty"`
	Extractors []ExtractorRow `json:"extractors,omitempty"`
	Ranches    []RanchRow     `json:"ranches,omitempty"`
	Kitchen    []KitchenStep  `json:"kitchen,omitempty"`

	// NutrientProcessors and PelletFeeders are per base, not per row.
	NutrientProcessors Quantity `json:"nutrientProcessors"`
	PelletFeeders      Quantity `json:"pelletFeeders"`

	NoBuild []NoBuildRow `json:"noBuild,omitempty"`
}

// Build is stage 2's output.
type Build struct {
	Bases []BaseBuild `json:"bases"`

	// Unassigned are the leaves the plan places nowhere. The producer stage
	// skips them — there is no site to build them at — but the grouping
	// keeps them so this can report them rather than losing them silently.
	Unassigned []Demand `json:"unassigned,omitempty"`
}

// PowerBudget is one base's power position.
type PowerBudget struct {
	Base string `json:"base"`

	Generation Quantity `json:"generation"`
	Draw       Quantity `json:"draw"`

	// Balance is generation minus draw and may be negative; Deficit is the
	// shortfall as a positive figure, or zero. Both are the domain's own
	// values — the adapter does not subtract.
	Balance   Quantity `json:"balance"`
	Deficit   Quantity `json:"deficit"`
	InDeficit bool     `json:"inDeficit"`

	PerGenerator Quantity `json:"perGenerator"`
	Batteries    Quantity `json:"batteries"`

	// AdditionalGenerators is how many more electromagnetic generators at
	// this base's class would clear a deficit, and FixUnsized reports that
	// a deficit exists but no class is configured to size the fix with.
	//
	// A deficit is therefore always visible even when it cannot be costed,
	// which is the distinction the domain makes deliberately.
	AdditionalGenerators Quantity `json:"additionalGenerators"`
	FixUnsized           bool     `json:"fixUnsized"`

	Verified bool `json:"verified"`
}

// Power is stage 3's output.
type Power struct {
	Bases []PowerBudget `json:"bases"`
}

// quantityToInt reads an inbound Quantity as a whole number.
//
// An absent field decodes as zero rather than as an error, because absence
// is the caller declining to configure something and the domain refuses
// unsupplied constants itself, naming which one. Rejecting "" here would
// replace that specific message with a generic parse failure.
func quantityToInt(q Quantity, what string) (int64, error) {
	if q == "" {
		return 0, nil
	}
	r, ok := q.Rat()
	if !ok {
		return 0, fmt.Errorf("%w: %s %q is not a number", ErrMalformedInput, what, q)
	}
	if !r.IsInt() || !r.Num().IsInt64() {
		return 0, fmt.Errorf("%w: %s %q is not a whole number", ErrMalformedInput, what, q)
	}
	return r.Num().Int64(), nil
}

// DecodeCurated turns the wire constant set into the domain's.
//
// Governing: SPEC-0002 REQ "Error Handling Standards" — "Decoding failures
// MUST name what could not be decoded and MUST NOT attempt computation."
//
// Values are not checked for being positive here. The domain validates the
// set as a whole and names the offending constant, and duplicating that
// check would give two places for the rule to drift.
func DecodeCurated(c Curated) (domain.Curated, error) {
	out := domain.Curated{}
	for _, f := range []struct {
		name string
		src  Quantity
		dst  *int64
	}{
		{"biodomeCropSlots", c.BiodomeCropSlots, &out.BiodomeCropSlots},
		{"faunaYieldPerCycle", c.FaunaYieldPerCycle, &out.FaunaYieldPerCycle},
		{"faunaCycleSeconds", c.FaunaCycleSeconds, &out.FaunaCycleSeconds},
		{"stepsPerProcessor", c.StepsPerProcessor, &out.StepsPerProcessor},
		{"depotThreshold", c.DepotThreshold, &out.DepotThreshold},
		{"processSeconds", c.ProcessSeconds, &out.ProcessSeconds},
		{"panelsPerBattery", c.PanelsPerBattery, &out.PanelsPerBattery},
	} {
		v, err := quantityToInt(f.src, "curated constant "+f.name)
		if err != nil {
			return domain.Curated{}, err
		}
		*f.dst = v
	}
	if len(c.FaunaProducts) > 0 {
		out.FaunaProducts = make(map[string]bool, len(c.FaunaProducts))
		for _, item := range c.FaunaProducts {
			out.FaunaProducts[item] = true
		}
	}
	if len(c.ResourceHotspots) > 0 {
		out.ResourceHotspots = make(map[string]string, len(c.ResourceHotspots))
		for item, category := range c.ResourceHotspots {
			out.ResourceHotspots[item] = category
		}
	}
	return out, nil
}

// DecodeRollupInput turns a rollup request's assignments and sites into the
// grouping stage's input.
func DecodeRollupInput(req RollupRequest) (domain.RollupInput, error) {
	out := domain.RollupInput{}
	if len(req.Assignments) > 0 {
		out.Assignments = make(map[string]domain.BaseID, len(req.Assignments))
		for item, base := range req.Assignments {
			out.Assignments[item] = domain.BaseID(base)
		}
	}
	if len(req.Sites) > 0 {
		out.Sites = make(map[domain.BaseID]domain.SiteConfig, len(req.Sites))
		for base, site := range req.Sites {
			fill, err := quantityToInt(site.FillSeconds, "fill duration for base "+base)
			if err != nil {
				return domain.RollupInput{}, err
			}
			out.Sites[domain.BaseID(base)] = domain.SiteConfig{
				ExtractorClass: domain.HotspotClass(site.ExtractorClass),
				FillSeconds:    fill,
			}
		}
	}
	return out, nil
}

// DecodeProducerInput turns a rollup request's byproducts and kitchen steps
// into the producer stage's input.
func DecodeProducerInput(req RollupRequest) (domain.ProducerInput, error) {
	out := domain.ProducerInput{}
	if len(req.Byproducts) > 0 {
		out.Byproducts = make(map[domain.BaseID][]domain.ByproductSource, len(req.Byproducts))
		for base, sources := range req.Byproducts {
			list := make([]domain.ByproductSource, 0, len(sources))
			for _, s := range sources {
				list = append(list, domain.ByproductSource{Item: s.Item, From: s.From})
			}
			out.Byproducts[domain.BaseID(base)] = list
		}
	}
	if len(req.Kitchen) > 0 {
		out.Kitchen = make(map[domain.BaseID][]domain.KitchenStepInput, len(req.Kitchen))
		for base, steps := range req.Kitchen {
			list := make([]domain.KitchenStepInput, 0, len(steps))
			for _, s := range steps {
				qty, err := quantityToInt(s.Quantity, "kitchen step quantity for "+s.ItemID)
				if err != nil {
					return domain.ProducerInput{}, err
				}
				list = append(list, domain.KitchenStepInput{
					ItemID:   s.ItemID,
					Recipe:   s.Recipe,
					Quantity: qty,
				})
			}
			out.Kitchen[domain.BaseID(base)] = list
		}
	}
	return out, nil
}

// DecodePowerInput turns a power request into the power stage's input.
func DecodePowerInput(req PowerRequest) (domain.PowerInput, error) {
	out := domain.PowerInput{}
	if len(req.Sources) > 0 {
		out.Config = make(map[domain.BaseID]domain.PowerConfig, len(req.Sources))
		for base, gen := range req.Sources {
			ems, err := quantityToInt(gen.EMGenerators, "generator count for base "+base)
			if err != nil {
				return domain.PowerInput{}, err
			}
			panels, err := quantityToInt(gen.SolarPanels, "panel count for base "+base)
			if err != nil {
				return domain.PowerInput{}, err
			}
			out.Config[domain.BaseID(base)] = domain.PowerConfig{
				EMGenerators: ems,
				EMClass:      domain.HotspotClass(gen.EMClass),
				SolarPanels:  panels,
			}
		}
	}
	if len(req.Draws) > 0 {
		out.Draws = make(map[domain.BaseID][]domain.PowerUnit, len(req.Draws))
		for base, units := range req.Draws {
			list := make([]domain.PowerUnit, 0, len(units))
			for _, u := range units {
				count, err := quantityToInt(u.Count, "draw count for "+u.PartID+" at base "+base)
				if err != nil {
					return domain.PowerInput{}, err
				}
				list = append(list, domain.PowerUnit{PartID: u.PartID, Count: count})
			}
			out.Draws[domain.BaseID(base)] = list
		}
	}
	if len(req.Unverified) > 0 {
		out.Unverified = make(map[domain.BaseID]bool, len(req.Unverified))
		for _, base := range req.Unverified {
			out.Unverified[domain.BaseID(base)] = true
		}
	}
	return out, nil
}

// EncodeBuild renders stage 2's output for the boundary.
//
// Governing: SPEC-0002 REQ "Exact Quantity Encoding", REQ "Determinism
// Across the Boundary"
//
// Order is the domain's throughout — bases sorted by ID, rows sorted within
// each base — and nothing here re-sorts, for the same reason EncodeGraph
// does not: an order re-derived in the adapter is a second place for it to
// drift from the engine's.
func EncodeBuild(b *domain.Build, g *domain.Grouping) (*Build, error) {
	if b == nil {
		return nil, fmt.Errorf("encoding build: nil build")
	}
	out := &Build{Bases: make([]BaseBuild, 0, len(b.Bases))}
	for _, base := range b.Bases {
		out.Bases = append(out.Bases, encodeBaseBuild(base))
	}
	if g != nil {
		if unassigned, ok := g.Unassigned(); ok {
			out.Unassigned = make([]Demand, 0, len(unassigned.Demands))
			for _, d := range unassigned.Demands {
				out.Unassigned = append(out.Unassigned, Demand{
					ItemID:   d.ItemID,
					Name:     d.Name,
					Total:    QuantityOf(d.Total()),
					Verified: d.Verified,
				})
			}
		}
	}
	return out, nil
}

func encodeBaseBuild(b domain.BaseBuild) BaseBuild {
	out := BaseBuild{
		Base: string(b.Base),
		Site: Site{
			ExtractorClass: string(b.Site.ExtractorClass),
			FillSeconds:    QuantityOfInt(b.Site.FillSeconds),
		},
		NutrientProcessors: QuantityOfInt(b.NutrientProcessors),
		PelletFeeders:      QuantityOfInt(b.PelletFeeders),
	}
	for _, r := range b.Farms {
		out.Farms = append(out.Farms, FarmRow{
			ItemID:   r.ItemID,
			Name:     r.Name,
			Required: QuantityOf(r.Required()),
			Plants:   QuantityOfInt(r.Plants),
			Biodomes: QuantityOfInt(r.Biodomes),
			YieldPerPlant: YieldRange{
				Min: QuantityOfInt(r.YieldPerPlant.Min),
				Max: QuantityOfInt(r.YieldPerPlant.Max),
			},
			GrowthSeconds: QuantityOfInt(r.GrowthSeconds),
		})
	}
	for _, r := range b.Extractors {
		out.Extractors = append(out.Extractors, ExtractorRow{
			ItemID:         r.ItemID,
			Name:           r.Name,
			Class:          string(r.Class),
			Required:       QuantityOf(r.Required()),
			ExtractorCount: QuantityOfInt(r.Extractors),
			Depots:         QuantityOfInt(r.Depots),
			RatePerSecond:  QuantityOf(r.RatePerSecond()),
			FillSeconds:    QuantityOf(r.FillSeconds()),
		})
	}
	for _, r := range b.Ranches {
		out.Ranches = append(out.Ranches, RanchRow{
			ItemID:       r.ItemID,
			Name:         r.Name,
			Required:     QuantityOf(r.Required()),
			Fauna:        QuantityOfInt(r.Fauna),
			CycleSeconds: QuantityOfInt(r.CycleSeconds),
		})
	}
	for _, s := range b.Kitchen {
		step := KitchenStep{
			ItemID:         s.ItemID,
			Name:           s.Name,
			Recipe:         s.Recipe,
			Required:       QuantityOf(s.Required()),
			ProcessSeconds: QuantityOfInt(s.ProcessSeconds),
			Final:          s.Final,
		}
		for _, i := range s.Inputs {
			step.Inputs = append(step.Inputs, KitchenInput{
				ItemID:    i.ItemID,
				PerOutput: QuantityOf(i.PerOutput()),
			})
		}
		out.Kitchen = append(out.Kitchen, step)
	}
	for _, n := range b.NoBuild {
		out.NoBuild = append(out.NoBuild, NoBuildRow{
			ItemID:   n.ItemID,
			Name:     n.Name,
			From:     n.From,
			Required: QuantityOf(n.Required()),
		})
	}
	return out
}

// EncodePower renders stage 3's output for the boundary.
//
// Governing: SPEC-0002 REQ "Exact Quantity Encoding", REQ "Determinism
// Across the Boundary"
//
// Balance and Deficit are read from the domain rather than derived from the
// generation and draw beside them. Recomputing either here would be
// arithmetic in the adapter, and would give the boundary its own opinion
// about a figure the engine already reports.
func EncodePower(budgets []domain.PowerBudget) (*Power, error) {
	out := &Power{Bases: make([]PowerBudget, 0, len(budgets))}
	for _, b := range budgets {
		out.Bases = append(out.Bases, PowerBudget{
			Base:                 string(b.Base),
			Generation:           QuantityOf(b.Generation()),
			Draw:                 QuantityOf(b.Draw()),
			Balance:              QuantityOf(b.Balance()),
			Deficit:              QuantityOf(b.Deficit()),
			InDeficit:            b.InDeficit(),
			PerGenerator:         QuantityOf(b.PerGenerator()),
			Batteries:            QuantityOfInt(b.Batteries),
			AdditionalGenerators: QuantityOfInt(b.AdditionalGenerators),
			FixUnsized:           b.FixUnsized,
			Verified:             b.Verified,
		})
	}
	return out, nil
}
