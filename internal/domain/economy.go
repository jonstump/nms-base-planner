package domain

import "fmt"

// Base-economy data carried alongside the recipe graph.
//
// Governing: ADR-0001 (two-tier NMS data ingestion), SPEC-0004 REQ "Schema
// Extension and Load Compatibility"
//
// ADR-0001 originally planned these as hand-curated Tier 2 constants. The
// 2026-08-18 confirmation found four of the five extractable, so they belong
// to the machine-generated tier and live here. Only biodome crop-slot count
// remains curated.
//
// The shapes below mirror the source data rather than a convenient
// abstraction of it: rates are per-network because a part participates in
// several, class scaling hangs off hotspots because that is where the game
// puts it, and yields keep both bounds because collapsing a range to a point
// discards the best/worst case the planner exists to show.

// Network is a link-grid network a rate applies to.
type Network string

const (
	NetworkPower       Network = "power"
	NetworkResources   Network = "resources"
	NetworkPlantGrowth Network = "plant_growth"
	NetworkByteBeat    Network = "byte_beat"
	// Fuel and Portals appear once and three times respectively in the
	// source. They carry no planner meaning today, but the vocabulary
	// mirrors GcLinkNetworkTypes rather than a filtered subset of it, so
	// that a part using one is emitted rather than rejected.
	NetworkFuel    Network = "fuel"
	NetworkPortals Network = "portals"
)

var validNetworks = map[Network]bool{
	NetworkPower: true, NetworkResources: true,
	NetworkPlantGrowth: true, NetworkByteBeat: true,
	NetworkFuel: true, NetworkPortals: true,
}

// Valid reports whether n is a known network.
func (n Network) Valid() bool { return validNetworks[n] }

// Flow is a rate on one network, with the buffer that accumulates it.
// A positive Rate produces, a negative Rate consumes.
type Flow struct {
	Network Network `json:"network"`
	Rate    int64   `json:"rate"`
	Storage int64   `json:"storage,omitempty"`
}

// Dependency is a part's requirement on another network — typically a power
// draw that gates the part's primary rate.
type Dependency struct {
	Network Network `json:"network"`
	Rate    int64   `json:"rate"`
	// Effect is the source's DependentEffect, e.g. "EnablesRate". Carried
	// verbatim rather than interpreted, because the planner needs to know
	// whether an unpowered part produces nothing or merely produces less.
	Effect string `json:"effect,omitempty"`
}

// Part is one buildable's economic behaviour.
type Part struct {
	ID           string       `json:"id"`
	Name         string       `json:"name,omitempty"`
	Primary      Flow         `json:"primary"`
	Dependencies []Dependency `json:"dependencies,omitempty"`
	// Hotspot names the hotspot category this part's rate scales with, if
	// any. The class lives on the hotspot, never on the part.
	Hotspot string `json:"hotspot,omitempty"`
}

// ClassValues holds one value per C/B/A/S class.
type ClassValues struct {
	C float64 `json:"c"`
	B float64 `json:"b"`
	A float64 `json:"a"`
	S float64 `json:"s"`
}

// Hotspot carries the class scaling for one hotspot category.
//
// Classes are ranges a hotspot falls into, not multipliers attached to a
// device. Searching the parts table for per-class variants finds nothing
// precisely because the game models it this way.
type Hotspot struct {
	Category   string      `json:"category"`
	Strengths  ClassValues `json:"strengths"`
	Weightings ClassValues `json:"weightings"`
}

// Range is an inclusive minimum and maximum. Both bounds are kept even when
// equal, so a later widening in the game data is a visible change rather
// than a silent one.
type Range struct {
	Min int64 `json:"min"`
	Max int64 `json:"max"`
}

// Crop is one farmable plant's yield and growth time.
type Crop struct {
	// ID is the buildable plant's ID, e.g. SNOWPLANT.
	ID string `json:"id"`
	// Substance is the item ID the plant yields, e.g. PLANT_SNOW.
	Substance string `json:"substance"`
	Yield     Range  `json:"yield"`
	// GrowthSeconds is time to maturity.
	GrowthSeconds int64 `json:"growth_seconds"`
}

// Refining is refiner throughput, which is difficulty-dependent.
type Refining struct {
	ProductsPerCycle   int64 `json:"products_per_cycle"`
	SubstancesPerCycle int64 `json:"substances_per_cycle"`
	// Survival variants. The design's open question of whether the planner
	// should choose is settled by carrying both and letting it.
	ProductsPerCycleSurvival   int64 `json:"products_per_cycle_survival"`
	SubstancesPerCycleSurvival int64 `json:"substances_per_cycle_survival"`
}

// Search records how a value was located when it was found by searching
// rather than read from a known field.
//
// Governing: SPEC-0004 REQ "Search Boundaries Are Recorded" — this exists
// because this project has three recorded instances of a bounded search
// being reported as a general result. Recording where we looked makes the
// boundary of a negative result visible to the next reader.
type Search struct {
	// Value names what was being derived, e.g. "crop substance".
	Value string `json:"value"`
	// Searched lists the sources consulted, in the order consulted.
	Searched []string `json:"searched"`
	// Note records what the search concluded, including anything it did
	// not cover.
	Note string `json:"note,omitempty"`
}

// Economy is the base-economy half of the artifact.
type Economy struct {
	Parts    []Part    `json:"parts,omitempty"`
	Hotspots []Hotspot `json:"hotspots,omitempty"`
	Crops    []Crop    `json:"crops,omitempty"`
	Refining *Refining `json:"refining,omitempty"`

	// Searches records the derivation of values the normalizer had to hunt
	// for. Sorted by Value.
	//
	// Governing: SPEC-0004 REQ "Search Boundaries Are Recorded"
	Searches []Search `json:"searches,omitempty"`
}

// validate checks the economy section's internal consistency. Item
// references are checked by the caller, which owns the item index.
func (e *Economy) validate(knownItem func(string) bool) error {
	seenPart := make(map[string]bool, len(e.Parts))
	for _, p := range e.Parts {
		if p.ID == "" {
			return fmt.Errorf("%w: part with empty id", ErrInvalidArtifact)
		}
		if seenPart[p.ID] {
			return fmt.Errorf("%w: duplicate part id %q", ErrInvalidArtifact, p.ID)
		}
		seenPart[p.ID] = true
		if !p.Primary.Network.Valid() {
			return fmt.Errorf("%w: part %q primary network %q is not a known network", ErrInvalidArtifact, p.ID, p.Primary.Network)
		}
		for _, d := range p.Dependencies {
			if !d.Network.Valid() {
				return fmt.Errorf("%w: part %q dependency network %q is not a known network", ErrInvalidArtifact, p.ID, d.Network)
			}
		}
	}

	seenCat := make(map[string]bool, len(e.Hotspots))
	for _, h := range e.Hotspots {
		if h.Category == "" {
			return fmt.Errorf("%w: hotspot with empty category", ErrInvalidArtifact)
		}
		if seenCat[h.Category] {
			return fmt.Errorf("%w: duplicate hotspot category %q", ErrInvalidArtifact, h.Category)
		}
		seenCat[h.Category] = true
	}

	// A part naming a hotspot must name one the artifact carries, or the
	// planner cannot scale its rate.
	for _, p := range e.Parts {
		if p.Hotspot != "" && !seenCat[p.Hotspot] {
			return fmt.Errorf("%w: part %q references hotspot %q, which is not in this artifact", ErrInvalidArtifact, p.ID, p.Hotspot)
		}
	}

	seenSearch := make(map[string]bool, len(e.Searches))
	for _, s := range e.Searches {
		if s.Value == "" {
			return fmt.Errorf("%w: search record with empty value", ErrInvalidArtifact)
		}
		// Value is what sortArtifact orders Searches by, so it has to be
		// unique or the emitted order falls back to however the normalizer
		// happened to append them — the map-iteration order REQ
		// "Deterministic Output" forbids. Rejecting rather than tiebreaking:
		// unlike the game tables, these records are ours, so two searches
		// deriving one value is an authoring mistake — either a duplicate to
		// merge or two derivations wanting distinguishable names.
		if seenSearch[s.Value] {
			return fmt.Errorf("%w: duplicate search record for %q", ErrInvalidArtifact, s.Value)
		}
		seenSearch[s.Value] = true
		if len(s.Searched) == 0 {
			// A search record that names no sources records nothing; it
			// would read as diligence while carrying none.
			return fmt.Errorf("%w: search record %q lists no sources searched", ErrInvalidArtifact, s.Value)
		}
	}

	seenCrop := make(map[string]bool, len(e.Crops))
	for _, c := range e.Crops {
		if c.ID == "" {
			return fmt.Errorf("%w: crop with empty id", ErrInvalidArtifact)
		}
		if seenCrop[c.ID] {
			return fmt.Errorf("%w: duplicate crop id %q", ErrInvalidArtifact, c.ID)
		}
		seenCrop[c.ID] = true
		if !knownItem(c.Substance) {
			return fmt.Errorf("%w: crop %q yields %q: %w", ErrInvalidArtifact, c.ID, c.Substance, ErrUnknownItem)
		}
		if c.Yield.Min < 0 || c.Yield.Max < c.Yield.Min {
			return fmt.Errorf("%w: crop %q yield range [%d, %d] is not ordered and non-negative", ErrInvalidArtifact, c.ID, c.Yield.Min, c.Yield.Max)
		}
		if c.GrowthSeconds < 0 {
			return fmt.Errorf("%w: crop %q growth time is negative: %d", ErrInvalidArtifact, c.ID, c.GrowthSeconds)
		}
	}
	return nil
}
