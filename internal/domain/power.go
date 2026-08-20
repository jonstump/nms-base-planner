package domain

import (
	"fmt"
	"math/big"
	"sort"
)

// Stage 2's power half: what a base generates, what it draws, and what to
// build when the second exceeds the first.
//
// Governing: SPEC-0001 REQ "Power Computation", REQ "Exact Arithmetic and
// Rounding Discipline", REQ "Provenance Propagation"
//
// Draw is a pure function of what is built and what each part draws, so this
// stage takes counts rather than producer rows. That keeps it independent of
// the producer stage's row shapes — the same numbers whether they came from
// a rollup or from a caller sketching a base by hand.

// PowerUnit is a count of one buildable at a base.
type PowerUnit struct {
	PartID string
	Count  int64
}

// PowerConfig is a base's generation setup.
type PowerConfig struct {
	// EMGenerators sit on a power hotspot and take its class; SolarPanels
	// are classless and need batteries for the night.
	//
	// Governing: SPEC-0001 REQ "Power Computation" — "Generation MUST
	// support two source types."
	EMGenerators int64
	EMClass      HotspotClass
	SolarPanels  int64
}

// PowerBudget is one base's power position.
type PowerBudget struct {
	Base BaseID

	// Batteries are required for solar night coverage, at the configured
	// ratio, rounded up.
	Batteries int64

	// AdditionalGenerators is how many more electromagnetic generators at
	// the base's class would clear a deficit — zero when there is none.
	//
	// Reported rather than left to the view so a deficit presents as an
	// action rather than a warning.
	// Governing: SPEC-0001 REQ "Power Computation" — Scenario "Deficit
	// reports the fix".
	AdditionalGenerators int64

	// FixUnsized is true when the base is in deficit but no generator class
	// is configured, so the fix has no size. The deficit is still reported
	// — a base you cannot yet cost is not a base you should be unable to
	// see.
	FixUnsized bool

	// Verified is false when any contributing figure is.
	// Governing: SPEC-0001 REQ "Provenance Propagation".
	Verified bool

	generation *big.Rat
	draw       *big.Rat
	perEM      *big.Rat
}

// Generation is the base's total output, exact.
func (b PowerBudget) Generation() *big.Rat { return new(big.Rat).Set(b.generation) }

// Draw is the base's total consumption, exact and positive.
func (b PowerBudget) Draw() *big.Rat { return new(big.Rat).Set(b.draw) }

// Balance is generation minus draw: positive is surplus, negative deficit.
func (b PowerBudget) Balance() *big.Rat { return new(big.Rat).Sub(b.generation, b.draw) }

// Deficit is how much the base is short, or zero when it is not.
func (b PowerBudget) Deficit() *big.Rat {
	balance := b.Balance()
	if balance.Sign() >= 0 {
		return new(big.Rat)
	}
	return balance.Neg(balance)
}

// InDeficit reports whether draw exceeds generation.
func (b PowerBudget) InDeficit() bool { return b.Balance().Sign() < 0 }

// PerGenerator is one electromagnetic generator's output at the base's class.
func (b PowerBudget) PerGenerator() *big.Rat { return new(big.Rat).Set(b.perEM) }

// PowerInput is the power stage's per-base input.
type PowerInput struct {
	// Config is each base's generation setup.
	Config map[BaseID]PowerConfig

	// Draws are the buildables at each base that consume power, as counts
	// by part ID. Each part's draw comes from the artifact.
	Draws map[BaseID][]PowerUnit

	// Unverified marks bases whose contributing figures are not verified,
	// so the budget carries the taint forward.
	Unverified map[BaseID]bool
}

// ComputePower produces each base's power budget.
//
// Governing: SPEC-0001 REQ "Power Computation"
func ComputePower(c *Constants, in PowerInput) ([]PowerBudget, error) {
	if c == nil {
		return nil, fmt.Errorf("%w: power computation needs constants", ErrInvalidArtifact)
	}

	bases := map[BaseID]bool{}
	for base := range in.Config {
		bases[base] = true
	}
	for base := range in.Draws {
		bases[base] = true
	}

	out := make([]PowerBudget, 0, len(bases))
	for base := range bases {
		budget, err := powerFor(base, c, in)
		if err != nil {
			return nil, err
		}
		out = append(out, budget)
	}
	// Governing: SPEC-0001 REQ "Determinism".
	sort.Slice(out, func(i, j int) bool { return out[i].Base < out[j].Base })
	return out, nil
}

func powerFor(base BaseID, c *Constants, in PowerInput) (PowerBudget, error) {
	cfg := in.Config[base]
	budget := PowerBudget{
		Base:       base,
		Verified:   !in.Unverified[base],
		generation: new(big.Rat),
		draw:       new(big.Rat),
		perEM:      new(big.Rat),
	}

	// Electromagnetic generation: the generator's own rate scaled by its
	// hotspot's class strength.
	//
	// Governing: ADR-0001 — "A part declares a base Rate and a
	// DependsOnHotspots category; the hotspot carries the class." Both
	// factors are read, the same way Constants.ExtractorRate reads them for
	// U_EXTRACTOR_S and the solar branch below reads U_SOLAR_S's rate.
	//
	// U_GENERATOR_S carries rate 1 in NMS 5.97, so dropping the factor would
	// agree with this for every value the game currently ships — which is
	// exactly why it is read rather than assumed. A rate of 1 that is
	// multiplied in documents itself; a rate of 1 that is ignored is
	// indistinguishable from a rate nobody checked.
	if cfg.EMGenerators > 0 {
		gen, err := c.Part(PartGenerator)
		if err != nil {
			return PowerBudget{}, fmt.Errorf("base %q: %w", base, err)
		}
		if gen.Primary.Rate <= 0 {
			return PowerBudget{}, fmt.Errorf("%w: %s states no output", ErrInvalidArtifact, PartGenerator)
		}
		strength, err := c.ClassStrength("Power", cfg.EMClass)
		if err != nil {
			return PowerBudget{}, fmt.Errorf("base %q: %w", base, err)
		}
		perEM := new(big.Rat).Mul(new(big.Rat).SetInt64(gen.Primary.Rate), strength)
		budget.perEM = perEM
		budget.generation.Add(budget.generation,
			new(big.Rat).Mul(perEM, new(big.Rat).SetInt64(cfg.EMGenerators)))
	}

	// Solar is classless, and needs batteries to cover the night.
	if cfg.SolarPanels > 0 {
		panel, err := c.Part(PartSolar)
		if err != nil {
			return PowerBudget{}, fmt.Errorf("base %q: %w", base, err)
		}
		if panel.Primary.Rate <= 0 {
			return PowerBudget{}, fmt.Errorf("%w: %s states no output", ErrInvalidArtifact, PartSolar)
		}
		budget.generation.Add(budget.generation,
			new(big.Rat).Mul(new(big.Rat).SetInt64(panel.Primary.Rate), new(big.Rat).SetInt64(cfg.SolarPanels)))

		perBattery := c.Curated().PanelsPerBattery
		if perBattery <= 0 {
			return PowerBudget{}, fmt.Errorf("%w: panels per battery is %d; it must be supplied",
				ErrInvalidArtifact, perBattery)
		}
		budget.Batteries = ceilRat(big.NewRat(cfg.SolarPanels, perBattery))
	}

	// Draw: every part's power dependency, times how many are built.
	//
	// A part's own primary rate counts too when it is negative on the power
	// network — a biodome consumes directly rather than through a
	// dependency, and reading only dependencies would miss it.
	for _, unit := range in.Draws[base] {
		if unit.Count <= 0 {
			continue
		}
		part, err := c.Part(unit.PartID)
		if err != nil {
			return PowerBudget{}, fmt.Errorf("base %q: %w", base, err)
		}
		per := new(big.Rat)
		if part.Primary.Network == NetworkPower && part.Primary.Rate < 0 {
			per.Add(per, new(big.Rat).SetInt64(-part.Primary.Rate))
		}
		for _, dep := range part.Dependencies {
			if dep.Network == NetworkPower && dep.Rate < 0 {
				per.Add(per, new(big.Rat).SetInt64(-dep.Rate))
			}
		}
		budget.draw.Add(budget.draw, new(big.Rat).Mul(per, new(big.Rat).SetInt64(unit.Count)))
	}

	// The fix, when there is a deficit: how many more generators at this
	// base's class would clear it.
	if budget.InDeficit() {
		perEM := budget.perEM
		if perEM.Sign() <= 0 {
			// No generators built yet, so size the fix against the class
			// the caller configured — what building the first one there
			// would produce.
			if !cfg.EMClass.Valid() {
				// No class either. The deficit is real and reportable; the
				// fix simply has no size until a class is chosen, and
				// saying so beats refusing to compute the base at all.
				budget.FixUnsized = true
				return budget, nil
			}
			resolved, err := c.ClassStrength("Power", cfg.EMClass)
			if err != nil {
				return PowerBudget{}, fmt.Errorf("base %q: %w", base, err)
			}
			perEM = resolved
			budget.perEM = resolved
		}
		budget.AdditionalGenerators = ceilRat(new(big.Rat).Quo(budget.Deficit(), perEM))
	}
	return budget, nil
}
