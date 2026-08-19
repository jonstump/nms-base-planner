package domain

import (
	"fmt"
	"math/big"
)

// Recipe selection.
//
// Governing: ADR-0005 (multiple recipes per output), SPEC-0001 REQ "Recipe
// Selection"
//
// A method no longer identifies a recipe: the artifact carries a list,
// because the game defines many routes to the same item. The engine picks
// one, deterministically, and the plan may override it per item.

// selectRecipe resolves the single recipe a node expands through.
//
// An explicit override wins and is validated. Otherwise the default rule
// applies: the candidate whose expansion resolves to the smallest total of
// raw inputs, ties broken by recipe id so the choice is stable across runs
// and machines.
func (r *resolver) selectRecipe(it Item, m Method) (Recipe, error) {
	candidates := r.t.RecipesFor(it.ID, m)
	if len(candidates) == 0 {
		return Recipe{}, fmt.Errorf("%w: %s has no %s recipe", ErrIllegalMethod, it.Name, m)
	}

	if want, overridden := r.in.Recipes[it.ID]; overridden {
		for _, rc := range candidates {
			if rc.ID == want {
				return rc, nil
			}
		}
		return Recipe{}, fmt.Errorf("%w: %s has no %s recipe %q", ErrIllegalMethod, it.Name, m, want)
	}

	best := candidates[0]
	bestCost, bestOK := r.recipeCost(best, map[string]bool{it.ID: true})
	for _, rc := range candidates[1:] {
		cost, ok := r.recipeCost(rc, map[string]bool{it.ID: true})
		switch {
		case ok && !bestOK:
			// A resolvable candidate always beats an unresolvable one.
			best, bestCost, bestOK = rc, cost, true
		case ok == bestOK && better(cost, bestCost, rc.ID, best.ID):
			best, bestCost = rc, cost
		}
	}
	return best, nil
}

// better reports whether candidate (cost, id) beats incumbent (bestCost,
// bestID). Both costs may be nil, meaning unresolvable; ties fall to the
// lexicographically smaller id so the result never depends on artifact order.
func better(cost, bestCost *big.Rat, id, bestID string) bool {
	if cost == nil || bestCost == nil {
		return id < bestID
	}
	if c := cost.Cmp(bestCost); c != 0 {
		return c < 0
	}
	return id < bestID
}

// recipeCost is the total raw-input quantity needed to apply this recipe once
// and obtain one unit of its output, as an exact rational.
//
// Returns ok=false when the expansion cannot be resolved — an unknown item,
// or a cycle. An unresolvable candidate is never preferred over a resolvable
// one, which is what keeps a self-referential recipe from being chosen while
// still leaving it selectable if it is somehow the only option.
func (r *resolver) recipeCost(rc Recipe, inProgress map[string]bool) (*big.Rat, bool) {
	total := new(big.Rat)
	for _, in := range rc.Inputs {
		c, ok := r.rawCost(in.Item, inProgress)
		if !ok {
			return nil, false
		}
		total.Add(total, new(big.Rat).Mul(c, new(big.Rat).SetInt64(in.Quantity)))
	}
	// One application yields Producing() units, so the cost of a single unit
	// is the batch cost divided by the yield — exact, never floating point.
	return total.Quo(total, new(big.Rat).SetInt64(rc.Producing())), true
}

// rawCost is the raw-input quantity needed for one unit of an item, memoized.
//
// A raw node costs one of itself. Anything else costs the minimum over its
// available recipes, which is what makes the default rule a genuine
// smallest-raw-total rather than a first-listed heuristic.
func (r *resolver) rawCost(id string, inProgress map[string]bool) (*big.Rat, bool) {
	if c, done := r.costs[id]; done {
		if c == nil {
			return nil, false
		}
		return c, true
	}
	if inProgress[id] {
		// Revisiting an item still being costed is a cycle. Not memoized:
		// the same item may cost fine on a path that does not loop.
		return nil, false
	}

	it, ok := r.t.Item(id)
	if !ok {
		return nil, false
	}
	m, err := r.method(it)
	if err != nil {
		return nil, false
	}
	if m == MethodRaw {
		one := new(big.Rat).SetInt64(1)
		r.costs[id] = one
		return one, true
	}

	inProgress[id] = true
	defer delete(inProgress, id)

	var best *big.Rat
	for _, rc := range r.t.RecipesFor(id, m) {
		c, ok := r.recipeCost(rc, inProgress)
		if !ok {
			continue
		}
		if best == nil || c.Cmp(best) < 0 {
			best = c
		}
	}
	if best == nil {
		// Memoize the failure only when nothing is in progress beneath it,
		// so a cycle-induced miss on one path does not poison another.
		if len(inProgress) == 1 {
			r.costs[id] = nil
		}
		return nil, false
	}
	r.costs[id] = best
	return best, true
}
