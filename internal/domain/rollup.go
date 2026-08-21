package domain

import (
	"fmt"
	"math/big"
	"sort"
)

// Stage 2's inputs: which leaves belong to which base, how each site is
// configured, and where every economy constant comes from.
//
// Governing: SPEC-0001 REQ "Leaf Assignment to Bases", ADR-0001 (two-tier
// NMS data ingestion)
//
// This file is the boundary between resolving a graph and rolling it up.
// Stage 1 takes a Tier 1 artifact and a target; it reads no economy
// constant and needs no base assignment. Stage 2 takes stage 1's output and
// everything below.

// BaseID identifies a base within a plan. The empty value is not a base —
// see Unassigned.
type BaseID string

// Unassigned is the group a leaf lands in when the plan does not say where
// it comes from.
//
// It is deliberately a distinct group rather than a default base: SPEC-0001
// requires unassigned leaves be "reported in a distinct unassigned group
// rather than being silently dropped or attributed to a default base",
// because a plan that quietly builds Frost Crystal at whichever base sorted
// first is worse than one that says it does not know.
const Unassigned BaseID = ""

// HotspotClass is the C/B/A/S grade of a hotspot.
//
// The class belongs to the hotspot, never to the device: the game has one
// extractor, not four. Per SPEC-0001 REQ "Producer Rollup" it is configured
// per site, so every extractor row at a base recomputes together.
type HotspotClass string

const (
	ClassC HotspotClass = "C"
	ClassB HotspotClass = "B"
	ClassA HotspotClass = "A"
	ClassS HotspotClass = "S"
)

var validClasses = map[HotspotClass]bool{ClassC: true, ClassB: true, ClassA: true, ClassS: true}

// Valid reports whether c is one of the four grades.
func (c HotspotClass) Valid() bool { return validClasses[c] }

// SiteConfig is the per-base configuration the producer stages read.
type SiteConfig struct {
	// ExtractorClass is the hotspot grade at this base. Per site rather
	// than per row, so changing it recomputes every extractor at the base
	// and nothing anywhere else.
	//
	// Governing: SPEC-0001 REQ "Producer Rollup" — "Extractor class MUST be
	// configured per site, not per row."
	ExtractorClass HotspotClass

	// FillSeconds is how long the plan is willing to wait for an extractor
	// row to produce its requirement. Extractor counts are sized to it.
	//
	// Per site rather than global because it pairs with the class: a base
	// on an S hotspot and one on a C hotspot are rarely given the same
	// patience.
	//
	// Governing: SPEC-0001 REQ "Producer Rollup" — "sized so the required
	// quantity is produced within a configured fill duration".
	FillSeconds int64
}

// Curated holds the economy constants no game table states.
//
// Governing: SPEC-0001 design.md "Tier 2 constants injected, never
// hardcoded"; ADR-0001 (curated tier)
//
// The list is short and getting shorter. SPEC-0004's normalizer now emits
// most of what that design entry called Tier 2 — crop yields and growth
// times, part rates, storage buffers, power draws, hotspot class strengths,
// refiner throughput — and Constants reads those from the artifact rather
// than asking a caller to supply them again. What remains here is what a
// search of the tables did not find.
//
// Every field is required. A zero is refused rather than defaulted,
// because a silently-assumed constant is indistinguishable from a measured
// one once it reaches a number the user reads.
type Curated struct {
	// BiodomeCropSlots is how many plants fit in a biodome. ADR-0001's one
	// surviving curated entry; the community wiki reports 16 and no table
	// searched states it. It may be geometric — snap points in the scene —
	// and therefore extractable after all.
	BiodomeCropSlots int64

	// FaunaYieldPerCycle is how many units one creature yields per
	// collection cycle, and FaunaCycleSeconds how long that cycle is.
	// Neither appears in the reality tables; fauna products are generated
	// from creature data this pipeline does not read.
	FaunaYieldPerCycle int64
	FaunaCycleSeconds  int64

	// StepsPerProcessor is how many nutrient processor steps one processor
	// covers. A planner policy about how hard to work one machine rather
	// than a game constant.
	StepsPerProcessor int64

	// DepotThreshold is the required quantity above which a row reports
	// supply depots. Also a planner policy — the game does not have an
	// opinion about when hoarding starts.
	//
	// PanelsPerBattery is how many solar panels one battery covers for the
	// night. A planner ratio rather than a game constant: the battery's
	// capacity is in the artifact, but how much darkness to plan for is a
	// choice.
	//
	// Governing: SPEC-0001 REQ "Power Computation" — "Solar panels MUST be
	// classless and MUST additionally require batteries at a configured
	// ratio for night coverage."
	PanelsPerBattery int64

	// Depot *capacity* is not here: it is U_SILO_S's storage buffer, which
	// the artifact carries. See Constants.DepotCapacity.
	DepotThreshold int64

	// ProcessSeconds is how long one nutrient processor step takes.
	// Economy.Refining states throughput per cycle but not the cycle's
	// duration, so this is supplied.
	ProcessSeconds int64

	// FaunaProducts and ResourceHotspots are classification rather than
	// scalars: which leaf items come from creatures, and which hotspot
	// category each extracted resource sits on.
	//
	// Neither is in the tables. Crops classify themselves — Economy.Crops
	// names the substance each plant yields — but nothing says Wild Milk
	// comes from a creature or that Sulphurine is a Gas hotspot rather
	// than a Mineral one. Supplied rather than guessed from the item's
	// name, which is the kind of inference that has cost this project
	// before.
	FaunaProducts    map[string]bool
	ResourceHotspots map[string]string
}

// validate refuses a partially-specified constant set.
func (c Curated) validate() error {
	for _, f := range []struct {
		name string
		v    int64
	}{
		{"biodome crop slots", c.BiodomeCropSlots},
		{"fauna yield per cycle", c.FaunaYieldPerCycle},
		{"fauna cycle seconds", c.FaunaCycleSeconds},
		{"steps per processor", c.StepsPerProcessor},
		{"depot threshold", c.DepotThreshold},
		{"process seconds", c.ProcessSeconds},
		{"panels per battery", c.PanelsPerBattery},
	} {
		if f.v <= 0 {
			return fmt.Errorf("%w: curated constant %q is %d; it must be supplied, not defaulted",
				ErrMissingConstant, f.name, f.v)
		}
	}
	return nil
}

// Part IDs the rollup reads by name. Named here rather than inline so the
// set of buildables this engine depends on is enumerable, and so a game
// update that renames one fails in a single place.
const (
	PartExtractorMineral = "U_EXTRACTOR_S"
	PartExtractorGas     = "U_GASEXTRACTOR"
	PartSupplyDepot      = "U_SILO_S"
	PartBattery          = "U_BATTERY_S"
	PartGenerator        = "U_GENERATOR_S"
	PartSolar            = "U_SOLAR_S"
	PartBiodome          = "BIOROOM"
	PartRanch            = "CREATURE_FARM"
	PartFeeder           = "CREATURE_FEED"
)

// Constants answers "where does this number come from" for every value the
// producer and power stages need.
//
// Governing: SPEC-0001 design.md "Tier 2 constants injected, never
// hardcoded"
//
// Nothing is hardcoded: each accessor either reads the artifact's Economy
// section or returns a curated value the caller supplied. An accessor whose
// source is missing returns an error naming what it wanted, so a thinner
// artifact fails loudly instead of rolling up against zeros.
type Constants struct {
	economy *Economy
	curated Curated

	crops map[string]Crop
	parts map[string]Part
	spots map[string]Hotspot
}

// NewConstants indexes an artifact's economy section against the curated
// values, refusing an artifact that carries none.
func NewConstants(t *Tier1, curated Curated) (*Constants, error) {
	if t == nil || t.Economy == nil {
		return nil, fmt.Errorf("%w: the artifact carries no economy section; "+
			"regenerate it with cmd/nmstier1", ErrInvalidArtifact)
	}
	if err := curated.validate(); err != nil {
		return nil, err
	}

	c := &Constants{
		economy: t.Economy,
		curated: curated,
		crops:   make(map[string]Crop, len(t.Economy.Crops)),
		parts:   make(map[string]Part, len(t.Economy.Parts)),
		spots:   make(map[string]Hotspot, len(t.Economy.Hotspots)),
	}
	// Crops are indexed by what they yield rather than by the plant's own
	// ID, because a rollup starts from a leaf item the graph named.
	for _, crop := range t.Economy.Crops {
		c.crops[crop.Substance] = crop
	}
	for _, p := range t.Economy.Parts {
		c.parts[p.ID] = p
	}
	for _, h := range t.Economy.Hotspots {
		c.spots[h.Category] = h
	}
	return c, nil
}

// Curated returns the caller-supplied constants.
func (c *Constants) Curated() Curated { return c.curated }

// ProcessSeconds is one nutrient processor step's duration.
func (c *Constants) ProcessSeconds() int64 { return c.curated.ProcessSeconds }

// IsFauna reports whether an item comes from a creature rather than a plant
// or a hotspot.
func (c *Constants) IsFauna(itemID string) bool { return c.curated.FaunaProducts[itemID] }

// ExtractorRate is one extractor's output for a resource at a class, as an
// exact rational.
//
// Governing: SPEC-0001 REQ "Producer Rollup", REQ "Exact Arithmetic and
// Rounding Discipline"
//
// The base rate comes from the extractor part the resource's hotspot
// category implies, scaled by that category's class strength. Both halves
// read from the artifact; only the item-to-category mapping is curated,
// because nothing in the tables states it.
//
// The unit is whatever the part's Rate is denominated in, and the artifact
// does not say. U_EXTRACTOR_S carries rate 100 against storage 360000,
// which fills in 3,600 of those units — an hour if the rate is per second.
// Callers therefore supply SiteConfig.FillSeconds in the same unit; the
// arithmetic is consistent either way, and the plan's absolute times are
// only as right as that reading. Worth confirming in game before any
// duration is shown to a user.
func (c *Constants) ExtractorRate(itemID string, class HotspotClass) (*big.Rat, error) {
	category, ok := c.curated.ResourceHotspots[itemID]
	if !ok {
		return nil, fmt.Errorf("%w: no hotspot category is configured for %q, so no extractor can be sized for it",
			ErrMissingConstant, itemID)
	}
	part := PartExtractorMineral
	if category == "Gas" {
		part = PartExtractorGas
	}
	p, err := c.Part(part)
	if err != nil {
		return nil, err
	}
	if p.Primary.Rate <= 0 {
		return nil, fmt.Errorf("%w: %s states no extraction rate", ErrMissingConstant, part)
	}
	strength, err := c.ClassStrength(category, class)
	if err != nil {
		return nil, err
	}
	return new(big.Rat).Mul(new(big.Rat).SetInt64(p.Primary.Rate), strength), nil
}

// CropFor returns the crop that yields the given item.
func (c *Constants) CropFor(itemID string) (Crop, error) {
	crop, ok := c.crops[itemID]
	if !ok {
		return Crop{}, fmt.Errorf("%w: no crop in the artifact yields %q", ErrUnknownItem, itemID)
	}
	return crop, nil
}

// IsCrop reports whether a farmable plant yields the given item.
func (c *Constants) IsCrop(itemID string) bool {
	_, ok := c.crops[itemID]
	return ok
}

// Part returns a buildable's economy record.
func (c *Constants) Part(id string) (Part, error) {
	p, ok := c.parts[id]
	if !ok {
		return Part{}, fmt.Errorf("%w: the artifact carries no part %q", ErrUnknownItem, id)
	}
	return p, nil
}

// DepotCapacity is one supply depot's storage buffer.
//
// Read from the artifact rather than curated: the design entry lists depot
// capacity among the hand-curated constants, but U_SILO_S states it. The
// *threshold* — when a plan should start reporting depots at all — is the
// part with no source, and that one is curated.
func (c *Constants) DepotCapacity() (int64, error) {
	p, err := c.Part(PartSupplyDepot)
	if err != nil {
		return 0, err
	}
	if p.Primary.Storage <= 0 {
		return 0, fmt.Errorf("%w: %s states no storage buffer", ErrMissingConstant, PartSupplyDepot)
	}
	return p.Primary.Storage, nil
}

// BatteryCapacity is one battery's stored charge.
//
// Also read rather than curated, for the same reason: U_BATTERY_S states it.
func (c *Constants) BatteryCapacity() (int64, error) {
	p, err := c.Part(PartBattery)
	if err != nil {
		return 0, err
	}
	if p.Primary.Storage <= 0 {
		return 0, fmt.Errorf("%w: %s states no storage buffer", ErrMissingConstant, PartBattery)
	}
	return p.Primary.Storage, nil
}

// ClassStrength is a hotspot category's output multiplier at a class, as an
// exact rational.
//
// Governing: SPEC-0001 REQ "Exact Arithmetic and Rounding Discipline" —
// "Multipliers that are not integers ... MUST be applied as exact rational
// arithmetic."
//
// The conversion from the stored float64 is exact for every value NMS 5.97
// carries (1, 1.5, 2, 2.5 for resources; 150, 220, 250, 300 for power — all
// binary-exact). The exposure is upstream rather than here: ClassValues is
// float64 in the schema, so a source value that is not binary-representable
// would already have been rounded at decode. No such value exists today;
// worth revisiting if one appears.
func (c *Constants) ClassStrength(category string, class HotspotClass) (*big.Rat, error) {
	if !class.Valid() {
		return nil, fmt.Errorf("%w: %q is not a hotspot class (C, B, A, S)", ErrInvalidArtifact, class)
	}
	h, ok := c.spots[category]
	if !ok {
		return nil, fmt.Errorf("%w: the artifact carries no %q hotspot", ErrUnknownItem, category)
	}
	var v float64
	switch class {
	case ClassC:
		v = h.Strengths.C
	case ClassB:
		v = h.Strengths.B
	case ClassA:
		v = h.Strengths.A
	case ClassS:
		v = h.Strengths.S
	}
	r := new(big.Rat).SetFloat64(v)
	if r == nil {
		return nil, fmt.Errorf("%w: %s class %s strength is not a finite number", ErrInvalidArtifact, category, class)
	}
	if r.Sign() <= 0 {
		return nil, fmt.Errorf("%w: %s class %s strength is %v", ErrInvalidArtifact, category, class, v)
	}
	return r, nil
}

// RollupInput is stage 2's input, alongside stage 1's resolved graph.
type RollupInput struct {
	// Assignments maps a leaf item ID to the base that produces it. A leaf
	// absent from the map is unassigned, which is a reported state rather
	// than an error.
	Assignments map[string]BaseID

	// Sites configures each base. A base named in Assignments but absent
	// here is refused rather than defaulted: an extractor class picked for
	// the caller is a number they never chose showing up in their plan.
	Sites map[BaseID]SiteConfig
}

// LeafDemand is one leaf item's requirement at a base.
type LeafDemand struct {
	ItemID string
	Name   string

	// Verified carries stage 1's provenance forward, so a base row derived
	// from unverified data stays marked as such.
	Verified bool

	total *big.Rat
}

// Total returns the required quantity as an exact rational.
func (d LeafDemand) Total() *big.Rat { return new(big.Rat).Set(d.total) }

// TotalInt returns the requirement as an int64, reporting whether that was
// exact.
func (d LeafDemand) TotalInt() (int64, bool) {
	if !d.total.IsInt() || !d.total.Num().IsInt64() {
		return 0, false
	}
	return d.total.Num().Int64(), true
}

// BaseGroup is one base's assigned leaves.
type BaseGroup struct {
	// Base is the base ID, or Unassigned for the group of leaves the plan
	// does not place.
	Base BaseID

	// Site is the base's configuration. Zero for the unassigned group,
	// which has no site.
	Site SiteConfig

	// Demands are the leaves assigned here, sorted by item ID.
	Demands []LeafDemand
}

// IsUnassigned reports whether this is the group for unplaced leaves.
func (g BaseGroup) IsUnassigned() bool { return g.Base == Unassigned }

// Grouping is stage 2's first output: stage 1's leaf totals, grouped by base.
type Grouping struct {
	// Groups are the bases with assigned leaves, sorted by base ID, with
	// the unassigned group last if it has anything in it.
	Groups []BaseGroup

	byBase map[BaseID]*BaseGroup
}

// Group returns a base's group.
func (g *Grouping) Group(base BaseID) (BaseGroup, bool) {
	b, ok := g.byBase[base]
	if !ok {
		return BaseGroup{}, false
	}
	return *b, true
}

// Unassigned returns the group of leaves with no base, and whether any exist.
func (g *Grouping) Unassigned() (BaseGroup, bool) { return g.Group(Unassigned) }

// GroupLeaves groups a resolved graph's leaf totals by assigned base.
//
// Governing: SPEC-0001 REQ "Leaf Assignment to Bases"
//
// Only leaves are grouped. An intermediate node is something the plan makes
// rather than something a base produces, so it has no place in a producer
// rollup — it reaches the rollup through the leaf totals it drove.
//
// Reassignment needs no special handling: this is a pure function of the
// graph and the assignment, so moving a leaf and re-running recomputes both
// the base it left and the one it joined.
func GroupLeaves(g *ResolvedGraph, in RollupInput) (*Grouping, error) {
	if g == nil {
		return nil, fmt.Errorf("%w: nil resolved graph", ErrInvalidArtifact)
	}

	// Every base named in an assignment must be configured. Checked before
	// grouping so the error names the omission rather than surfacing later
	// as an extractor sized at class "".
	for item, base := range in.Assignments {
		if base == Unassigned {
			return nil, fmt.Errorf("%w: %q is assigned to the empty base id; omit it to leave it unassigned",
				ErrInvalidArtifact, item)
		}
		site, ok := in.Sites[base]
		if !ok {
			return nil, fmt.Errorf("%w: base %q has no site configuration", ErrInvalidArtifact, base)
		}
		if !site.ExtractorClass.Valid() {
			return nil, fmt.Errorf("%w: base %q extractor class %q is not one of C, B, A, S",
				ErrInvalidArtifact, base, site.ExtractorClass)
		}
	}

	out := &Grouping{byBase: map[BaseID]*BaseGroup{}}
	for _, n := range g.Leaves() {
		base, assigned := in.Assignments[n.ItemID]
		if !assigned {
			base = Unassigned
		}
		group, ok := out.byBase[base]
		if !ok {
			group = &BaseGroup{Base: base, Site: in.Sites[base]}
			out.byBase[base] = group
		}
		group.Demands = append(group.Demands, LeafDemand{
			ItemID:   n.ItemID,
			Name:     n.Name,
			Verified: n.Verified,
			total:    n.Total(),
		})
	}

	// An assignment naming an item the graph does not reach as a leaf is a
	// stale plan, not a silent no-op. Reported so a leaf that stopped being
	// a leaf — because a method changed and it now expands — is visible.
	reached := map[string]bool{}
	for _, n := range g.Leaves() {
		reached[n.ItemID] = true
	}
	var stale []string
	for item := range in.Assignments {
		if !reached[item] {
			stale = append(stale, item)
		}
	}
	if len(stale) > 0 {
		sort.Strings(stale)
		return nil, fmt.Errorf("%w: assigned to a base but not a leaf of this graph: %v",
			ErrUnknownItem, stale)
	}

	// Sorted so output ordering never depends on map iteration, with the
	// unassigned group last because it is a remainder rather than a base.
	// Governing: SPEC-0001 REQ "Determinism".
	for _, group := range out.byBase {
		sort.Slice(group.Demands, func(i, j int) bool {
			return group.Demands[i].ItemID < group.Demands[j].ItemID
		})
		out.Groups = append(out.Groups, *group)
	}
	sort.Slice(out.Groups, func(i, j int) bool {
		a, b := out.Groups[i], out.Groups[j]
		if a.IsUnassigned() != b.IsUnassigned() {
			return b.IsUnassigned()
		}
		return a.Base < b.Base
	})
	return out, nil
}
