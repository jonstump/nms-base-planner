package domain

import (
	"fmt"
	"math/big"
	"sort"
)

// Stage 2's producer half: each base's assigned leaf totals become concrete
// construction instructions.
//
// Governing: SPEC-0001 REQ "Producer Rollup", REQ "Exact Arithmetic and
// Rounding Discipline"
//
// Three of this requirement's scenarios exist because the obvious
// implementation gets them wrong, and each has its own test: feeders are per
// base rather than per row, nutrient processors are ceil(total steps / steps
// per processor) rather than the sum of per-row ceilings, and extractor
// class is a property of the site.
//
// Every quantity below stays a big.Rat until the moment it becomes a thing
// you build. Rounding happens only at the boundaries SPEC-0001 enumerates —
// plants, biodomes, extractors, depots, fauna, processors — and always up,
// because half a biodome is not a biodome.

// ProducerType is the kind of thing a row tells you to build.
type ProducerType string

const (
	ProducerFarm      ProducerType = "farm"
	ProducerExtractor ProducerType = "extractor"
	ProducerRanch     ProducerType = "ranch"
	ProducerKitchen   ProducerType = "kitchen"
)

// FarmRow is one crop at one base.
type FarmRow struct {
	ItemID string
	Name   string

	// Plants and Biodomes are counts you build, each rounded up.
	Plants   int64
	Biodomes int64

	// YieldPerPlant is the source's range. Plants are sized on the
	// pessimistic bound: a plan that assumes the best case under-builds,
	// and the failure is a farm that never fills the order.
	YieldPerPlant Range

	// GrowthSeconds is time to maturity, from the artifact.
	GrowthSeconds int64

	required *big.Rat
}

// Required returns the row's requirement as an exact rational.
func (r FarmRow) Required() *big.Rat { return new(big.Rat).Set(r.required) }

// ExtractorRow is one extracted resource at one base.
type ExtractorRow struct {
	ItemID string
	Name   string

	// Class is the site's, not the row's.
	// Governing: SPEC-0001 REQ "Producer Rollup" — "Extractor class MUST be
	// configured per site, not per row."
	Class HotspotClass

	// Extractors is the count sized so the requirement is produced within
	// the site's configured fill duration.
	Extractors int64

	// Depots is ceil(required / depot capacity) above the configured
	// threshold, and zero below it.
	Depots int64

	required *big.Rat
	rate     *big.Rat
	fill     *big.Rat
}

// Required returns the row's requirement.
func (r ExtractorRow) Required() *big.Rat { return new(big.Rat).Set(r.required) }

// RatePerSecond is one extractor's output at the site's class.
func (r ExtractorRow) RatePerSecond() *big.Rat { return new(big.Rat).Set(r.rate) }

// FillSeconds is how long the built extractors actually take to produce the
// requirement — the resulting fill time, not the target.
//
// It is at most the configured duration, and usually less, because the count
// was rounded up.
func (r ExtractorRow) FillSeconds() *big.Rat { return new(big.Rat).Set(r.fill) }

// RanchRow is one fauna product at one base.
type RanchRow struct {
	ItemID string
	Name   string

	// Fauna is the creature count required to yield the requirement within
	// one collection cycle.
	Fauna int64

	// CycleSeconds is that cycle's duration.
	CycleSeconds int64

	required *big.Rat
}

// Required returns the row's requirement.
func (r RanchRow) Required() *big.Rat { return new(big.Rat).Set(r.required) }

// KitchenStep is one nutrient processor step.
type KitchenStep struct {
	// ItemID is what the step produces, Recipe the route it takes.
	ItemID string
	Name   string
	Recipe string

	// Inputs are the step's ingredients, sorted by item ID.
	Inputs []KitchenInput

	// ProcessSeconds is the step's duration.
	ProcessSeconds int64

	// Final marks the step that produces the plan target; every other step
	// is intermediate.
	//
	// Governing: SPEC-0001 REQ "Producer Rollup" — Scenario "Final kitchen
	// step is distinguished".
	Final bool

	required *big.Rat
}

// Required returns how many units this step must produce.
func (s KitchenStep) Required() *big.Rat { return new(big.Rat).Set(s.required) }

// KitchenInput is one ingredient of a step, with its ratio to the output.
type KitchenInput struct {
	ItemID string

	perOutput *big.Rat
}

// PerOutput is how many of this input one unit of the step's output costs —
// the input-to-output ratio, exact.
func (i KitchenInput) PerOutput() *big.Rat { return new(big.Rat).Set(i.perOutput) }

// NoBuild is an item whose demand another producer at the same base already
// satisfies.
//
// Governing: SPEC-0001 REQ "Producer Rollup" — "Items whose demand is
// satisfied by a byproduct of another producer at the same base MUST be
// reported as requiring no construction, and MUST NOT contribute a producer
// count or a power draw."
type NoBuild struct {
	ItemID string
	Name   string
	// From names the producer whose byproduct covers it.
	From string

	required *big.Rat
}

// Required returns the demand the byproduct covers.
func (b NoBuild) Required() *big.Rat { return new(big.Rat).Set(b.required) }

// BaseBuild is one base's construction instructions.
type BaseBuild struct {
	Base BaseID
	Site SiteConfig

	Farms      []FarmRow
	Extractors []ExtractorRow
	Ranches    []RanchRow
	Kitchen    []KitchenStep

	// NutrientProcessors is per base, computed as ceil(total steps / steps
	// per processor) — never the sum of per-row counts, which is larger
	// whenever a base carries more than one step.
	NutrientProcessors int64

	// PelletFeeders is per base: one feeder serves every fed fauna product
	// there, so this is 0 or 1 however many ranch rows exist.
	PelletFeeders int64

	// NoBuild are items a byproduct at this base already covers.
	NoBuild []NoBuild
}

// Build is stage 2's producer output.
type Build struct {
	Bases []BaseBuild

	byBase map[BaseID]*BaseBuild
}

// Base returns one base's instructions.
func (b *Build) Base(id BaseID) (BaseBuild, bool) {
	v, ok := b.byBase[id]
	if !ok {
		return BaseBuild{}, false
	}
	return *v, true
}

// ByproductSource names a producer whose output covers another item's demand
// at the same base.
//
// Modelled as a rollup-stage offset rather than a graph edge, so the
// dependency graph stays a pure structure and the accounting lives where it
// belongs.
type ByproductSource struct {
	// Item is the demand that is covered; From names what covers it.
	Item string
	From string
}

// ProducerInput is what the producer stage needs beyond the grouping.
type ProducerInput struct {
	// Byproducts declares, per base, which items another producer there
	// already yields.
	Byproducts map[BaseID][]ByproductSource

	// Kitchen names the steps a base's nutrient processor runs, in the
	// order the plan wants them. Empty for bases that cook nothing.
	Kitchen map[BaseID][]KitchenStepInput
}

// KitchenStepInput names one processing step the plan calls for.
type KitchenStepInput struct {
	// ItemID is the step's output and Recipe the route; Quantity is how
	// many units the step must produce.
	ItemID   string
	Recipe   string
	Quantity int64
}

// RollupProducers turns each base's grouped leaf demands into construction
// instructions.
//
// Governing: SPEC-0001 REQ "Producer Rollup"
//
// The unassigned group is skipped: it is a list of things the plan has not
// placed, and there is no site to build them at. It stays visible in the
// Grouping so the caller can report it.
func RollupProducers(g *Grouping, t *Tier1, c *Constants, in ProducerInput) (*Build, error) {
	if g == nil || c == nil {
		return nil, fmt.Errorf("%w: producer rollup needs a grouping and constants", ErrInvalidArtifact)
	}

	out := &Build{byBase: map[BaseID]*BaseBuild{}}
	for _, group := range g.Groups {
		if group.IsUnassigned() {
			continue
		}
		build, err := rollupBase(group, t, c, in)
		if err != nil {
			return nil, err
		}
		out.byBase[group.Base] = build
	}

	for _, b := range out.byBase {
		out.Bases = append(out.Bases, *b)
	}
	// Governing: SPEC-0001 REQ "Determinism".
	sort.Slice(out.Bases, func(i, j int) bool { return out.Bases[i].Base < out.Bases[j].Base })
	return out, nil
}

func rollupBase(group BaseGroup, t *Tier1, c *Constants, in ProducerInput) (*BaseBuild, error) {
	build := &BaseBuild{Base: group.Base, Site: group.Site}

	// Byproducts first: an item another producer here already yields
	// contributes no row at all, so it never reaches the sizing below.
	covered := map[string]string{}
	for _, b := range in.Byproducts[group.Base] {
		covered[b.Item] = b.From
	}

	for _, demand := range group.Demands {
		if from, ok := covered[demand.ItemID]; ok {
			build.NoBuild = append(build.NoBuild, NoBuild{
				ItemID: demand.ItemID, Name: demand.Name, From: from,
				required: demand.Total(),
			})
			continue
		}

		switch {
		case c.IsCrop(demand.ItemID):
			row, err := farmRow(demand, c)
			if err != nil {
				return nil, err
			}
			build.Farms = append(build.Farms, row)

		case c.IsFauna(demand.ItemID):
			build.Ranches = append(build.Ranches, ranchRow(demand, c))

		default:
			row, err := extractorRow(demand, group.Site, c)
			if err != nil {
				return nil, err
			}
			build.Extractors = append(build.Extractors, row)
		}
	}

	// One feeder serves every fed fauna product at the base.
	// Governing: SPEC-0001 REQ "Producer Rollup" — Scenario "Feeder is
	// reported once per base".
	if len(build.Ranches) > 0 {
		build.PelletFeeders = 1
	}

	steps, err := kitchenSteps(in.Kitchen[group.Base], t, c)
	if err != nil {
		return nil, err
	}
	build.Kitchen = steps
	// ceil(total steps / steps per processor), computed once from the
	// total. Summing per-row ceilings would report one processor per step.
	// Governing: SPEC-0001 REQ "Producer Rollup" — Scenario "Kitchen rollup
	// sizes processors per base".
	if n := int64(len(steps)); n > 0 {
		build.NutrientProcessors = ceilRat(big.NewRat(n, c.Curated().StepsPerProcessor))
	}

	sortRows(build)
	return build, nil
}

// farmRow sizes plants and biodomes for a crop.
//
// Governing: SPEC-0001 REQ "Producer Rollup" — Scenario "Farm rollup", and
// REQ "Exact Arithmetic and Rounding Discipline" — Scenarios "Plants round
// up" and "Domes round up from plants".
func farmRow(d LeafDemand, c *Constants) (FarmRow, error) {
	crop, err := c.CropFor(d.ItemID)
	if err != nil {
		return FarmRow{}, err
	}
	// The pessimistic bound: a plan sized on the best case under-builds,
	// and the failure mode is a farm that never fills the order.
	perPlant := crop.Yield.Min
	if perPlant <= 0 {
		return FarmRow{}, fmt.Errorf("%w: crop %q yields %d per plant", ErrInvalidArtifact, crop.ID, perPlant)
	}

	plants := ceilRat(new(big.Rat).Quo(d.Total(), new(big.Rat).SetInt64(perPlant)))
	// Domes round up from *plants*, not from the requirement — rounding
	// twice is the point, because you cannot put 7.8 plants in a dome
	// either.
	domes := ceilRat(big.NewRat(plants, c.Curated().BiodomeCropSlots))

	return FarmRow{
		ItemID: d.ItemID, Name: d.Name,
		Plants: plants, Biodomes: domes,
		YieldPerPlant: crop.Yield,
		GrowthSeconds: crop.GrowthSeconds,
		required:      d.Total(),
	}, nil
}

// extractorRow sizes extractors and depots for a resource.
//
// Governing: SPEC-0001 REQ "Producer Rollup" — Scenarios "Extractor sized to
// fill duration", "Supply depots sized above the threshold" and "No depots
// below the threshold".
func extractorRow(d LeafDemand, site SiteConfig, c *Constants) (ExtractorRow, error) {
	rate, err := c.ExtractorRate(d.ItemID, site.ExtractorClass)
	if err != nil {
		return ExtractorRow{}, err
	}
	if site.FillSeconds <= 0 {
		return ExtractorRow{}, fmt.Errorf("%w: site fill duration is %d seconds; it must be configured",
			ErrInvalidArtifact, site.FillSeconds)
	}

	// One extractor produces rate × duration over the window.
	perExtractor := new(big.Rat).Mul(rate, new(big.Rat).SetInt64(site.FillSeconds))
	count := ceilRat(new(big.Rat).Quo(d.Total(), perExtractor))

	// The resulting fill time, which is shorter than the target whenever
	// the count rounded up — the number the plan actually reports.
	fill := new(big.Rat).Quo(d.Total(), new(big.Rat).Mul(rate, new(big.Rat).SetInt64(count)))

	row := ExtractorRow{
		ItemID: d.ItemID, Name: d.Name,
		Class: site.ExtractorClass, Extractors: count,
		required: d.Total(), rate: rate, fill: fill,
	}

	// Depots only above the threshold; below it the row reports none.
	threshold := new(big.Rat).SetInt64(c.Curated().DepotThreshold)
	if d.Total().Cmp(threshold) > 0 {
		capacity, err := c.DepotCapacity()
		if err != nil {
			return ExtractorRow{}, err
		}
		row.Depots = ceilRat(new(big.Rat).Quo(d.Total(), new(big.Rat).SetInt64(capacity)))
	}
	return row, nil
}

// ranchRow sizes fauna for a product.
//
// Governing: SPEC-0001 REQ "Producer Rollup" — Scenario "Ranch rollup".
func ranchRow(d LeafDemand, c *Constants) RanchRow {
	curated := c.Curated()
	fauna := ceilRat(new(big.Rat).Quo(d.Total(), new(big.Rat).SetInt64(curated.FaunaYieldPerCycle)))
	return RanchRow{
		ItemID: d.ItemID, Name: d.Name,
		Fauna: fauna, CycleSeconds: curated.FaunaCycleSeconds,
		required: d.Total(),
	}
}

// kitchenSteps builds the processing steps for a base.
//
// Governing: SPEC-0001 REQ "Producer Rollup" — Scenarios "Kitchen rollup
// sizes processors per base" and "Final kitchen step is distinguished".
func kitchenSteps(inputs []KitchenStepInput, t *Tier1, c *Constants) ([]KitchenStep, error) {
	if len(inputs) == 0 {
		return nil, nil
	}
	if t == nil {
		return nil, fmt.Errorf("%w: kitchen steps need the artifact's recipes", ErrInvalidArtifact)
	}

	out := make([]KitchenStep, 0, len(inputs))
	for i, step := range inputs {
		if step.Quantity <= 0 {
			return nil, fmt.Errorf("%w: kitchen step %q quantity is %d", ErrInvalidArtifact, step.ItemID, step.Quantity)
		}
		item, ok := t.Item(step.ItemID)
		if !ok {
			return nil, fmt.Errorf("%w: kitchen step produces %q", ErrUnknownItem, step.ItemID)
		}
		recipe, ok := t.Recipe(step.ItemID, MethodCook, step.Recipe)
		if !ok {
			return nil, fmt.Errorf("%w: %s has no cook recipe %q", ErrIllegalMethod, item.Name, step.Recipe)
		}

		s := KitchenStep{
			ItemID: step.ItemID, Name: item.Name, Recipe: recipe.ID,
			ProcessSeconds: c.ProcessSeconds(),
			required:       new(big.Rat).SetInt64(step.Quantity),
			// The last step named is the one producing the plan target;
			// everything before it is intermediate.
			Final: i == len(inputs)-1,
		}
		// The ratio is per unit of output, so a recipe yielding more than
		// one divides through — exactly, never as a float.
		yield := new(big.Rat).SetInt64(recipe.Producing())
		for _, ing := range recipe.Inputs {
			s.Inputs = append(s.Inputs, KitchenInput{
				ItemID:    ing.Item,
				perOutput: new(big.Rat).Quo(new(big.Rat).SetInt64(ing.Quantity), yield),
			})
		}
		sort.Slice(s.Inputs, func(a, b int) bool { return s.Inputs[a].ItemID < s.Inputs[b].ItemID })
		out = append(out, s)
	}
	return out, nil
}

// sortRows imposes a stable order on every row collection.
// Governing: SPEC-0001 REQ "Determinism".
func sortRows(b *BaseBuild) {
	sort.Slice(b.Farms, func(i, j int) bool { return b.Farms[i].ItemID < b.Farms[j].ItemID })
	sort.Slice(b.Extractors, func(i, j int) bool { return b.Extractors[i].ItemID < b.Extractors[j].ItemID })
	sort.Slice(b.Ranches, func(i, j int) bool { return b.Ranches[i].ItemID < b.Ranches[j].ItemID })
	sort.Slice(b.NoBuild, func(i, j int) bool { return b.NoBuild[i].ItemID < b.NoBuild[j].ItemID })
	// Kitchen steps keep their given order: it is the sequence the plan
	// cooks in, and the final step is identified by position.
}

// ceilRat rounds a rational up to the next whole unit.
//
// Governing: SPEC-0001 REQ "Exact Arithmetic and Rounding Discipline" —
// "Rounding MUST occur only at stated physical boundaries, and MUST round
// up, because partial physical units cannot be built."
//
// Integer division on the numerator and denominator, so no float is
// involved at the one place the engine is allowed to lose precision.
func ceilRat(r *big.Rat) int64 {
	q, m := new(big.Int).QuoRem(r.Num(), r.Denom(), new(big.Int))
	if m.Sign() > 0 {
		q.Add(q, big.NewInt(1))
	}
	return q.Int64()
}
