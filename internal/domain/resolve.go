package domain

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// PlanInput is the immutable input to stage 1.
//
// Governing: SPEC-0001 design.md "Pure function pipeline over an immutable
// plan input" — no internal mutable state persists between calls, so
// determinism falls out for free and the WASM boundary marshals one value in
// and one value out.
type PlanInput struct {
	// Target is the item ID being planned.
	Target string

	// Quantity is how many of Target are wanted. Must be positive.
	Quantity int64

	// Methods overrides the per-item default method. Items absent from the
	// map use their Tier 1 default.
	Methods map[string]Method

	// Recipes overrides the per-item recipe, keyed by item ID and holding a
	// recipe ID. Items absent from the map use the engine's default choice.
	//
	// Absence is meaningful: SPEC-0001 REQ "Recipe Selection" requires that a
	// node using its default be representable without recording a selection,
	// so that plan state — and the URL hash it serializes into — carries only
	// deliberate overrides.
	//
	// Governing: SPEC-0001 REQ "Recipe Selection"
	Recipes map[string]string
}

// Edge is one resolved dependency, carrying the per-unit-of-parent quantity.
type Edge struct {
	// From is the consuming (parent) item ID.
	From string
	// To is the consumed (child) item ID.
	To string
	// PerUnit is how many To the recipe consumes per application.
	PerUnit int64

	// Yield is how many From one application produces. Per unit of From the
	// requirement is therefore PerUnit/Yield, which is rational — 1 Crystal
	// Sulphide yields 50 Sodium Nitrate, so a unit of Sodium Nitrate costs
	// one fiftieth of a Crystal Sulphide.
	//
	// Kept as a separate integer rather than folded into PerUnit so the edge
	// still reports what the recipe literally says, and so the division
	// happens once, exactly, in propagate.
	//
	// Governing: SPEC-0001 REQ "Exact Arithmetic and Rounding Discipline"
	Yield int64
}

// Node is one item in the resolved graph, with its aggregated total.
type Node struct {
	ItemID string
	Name   string

	// Method is the single resolved method for this node.
	Method Method

	// LegalMethods lists every method available to this item, sorted, so the
	// view can render unavailable options as inert rather than hiding them.
	LegalMethods []Method

	// Recipe is the id of the single recipe this node resolved to. Empty for
	// terminal nodes, which expand through no recipe.
	//
	// Governing: SPEC-0001 REQ "Recipe Selection"
	Recipe string

	// LegalRecipes lists every recipe id available for this node's chosen
	// method, sorted, so the view can offer the alternatives rather than
	// presenting one route as though it were the only one.
	LegalRecipes []string

	// Yield is how many units one application of the resolved recipe
	// produces. Zero for terminal nodes, which apply no recipe.
	//
	// Governing: ADR-0005 (explicit yields)
	Yield int64

	// Terminal reports that expansion stopped here (method raw).
	Terminal bool

	// Children are the edges to this node's inputs, sorted by child item ID.
	// Empty for terminal nodes.
	Children []Edge

	// Verified is false when this node's total is derived from anything
	// marked unverified in the Tier 1 artifact — the node itself, its
	// resolved recipe, or any ancestor.
	//
	// Governing: SPEC-0001 REQ "Provenance Propagation".
	Verified bool

	total *big.Rat
}

// Total returns the aggregated required quantity as an exact rational.
//
// Governing: SPEC-0001 REQ "Exact Arithmetic and Rounding Discipline" — "The
// engine MUST NOT accumulate binary floating-point error across the graph."
func (n *Node) Total() *big.Rat { return new(big.Rat).Set(n.total) }

// TotalInt returns the total as an int64, reporting whether that conversion
// was exact. It is inexact both when the total is fractional and when it is
// integral but outside int64 range — big.Rat.IsInt only reports a denominator
// of 1, and big.Int.Int64 is undefined out of range, so checking IsInt alone
// would return a wrapped (possibly negative) value flagged as exact.
//
// Governing: SPEC-0001 REQ "Exact Arithmetic and Rounding Discipline",
// REQ "Error Handling Standards" — a silently wrong count is the failure this
// bool exists to prevent.
func (n *Node) TotalInt() (int64, bool) {
	if !n.total.IsInt() || !n.total.Num().IsInt64() {
		return 0, false
	}
	return n.total.Num().Int64(), true
}

// Applications returns how many times this node's recipe must be applied to
// meet its total, as an exact rational. Nil for a terminal node.
//
// Deliberately unrounded: SPEC-0001 REQ "Exact Arithmetic and Rounding
// Discipline" enumerates the boundaries at which rounding up is allowed, and
// a recipe application is not one of them. A caller wanting whole batches
// rounds this value itself, once, at the point it reports them.
func (n *Node) Applications() *big.Rat {
	if n.Terminal || n.Yield == 0 {
		return nil
	}
	return new(big.Rat).Quo(n.total, new(big.Rat).SetInt64(n.Yield))
}

// ResolvedGraph is stage 1's output.
type ResolvedGraph struct {
	// Target is the planned item ID.
	Target string
	// Quantity is the planned target quantity.
	Quantity int64
	// GameVersion is copied from the Tier 1 artifact, so a fixture failure is
	// attributable to changed game data rather than to an engine regression.
	GameVersion string

	// Nodes are in topological order: terminals first, target last. This is
	// the tab order the tree canvas handoff specifies.
	Nodes []*Node

	byID map[string]*Node
}

// Node looks up a resolved node by item ID.
func (g *ResolvedGraph) Node(id string) (*Node, bool) {
	n, ok := g.byID[id]
	return n, ok
}

// Leaves returns the terminal nodes, in graph order.
func (g *ResolvedGraph) Leaves() []*Node {
	var out []*Node
	for _, n := range g.Nodes {
		if n.Terminal {
			out = append(out, n)
		}
	}
	return out
}

// dfsState tracks node colour for cycle detection.
type dfsState uint8

const (
	unvisited dfsState = iota
	inProgress
	done
)

// Resolve runs stage 1: it resolves target and quantity into a directed
// acyclic graph, propagates quantities down it, and aggregates shared demand.
//
// It returns no partial graph alongside an error.
//
// Governing: SPEC-0001 REQ "Dependency Graph Resolution", REQ "Method
// Resolution", REQ "Quantity Propagation and Aggregation", REQ "Cycle
// Detection", REQ "Provenance Propagation", REQ "Determinism".
func Resolve(t *Tier1, in PlanInput) (*ResolvedGraph, error) {
	if t == nil {
		return nil, fmt.Errorf("%w: nil tier 1 artifact", ErrInvalidArtifact)
	}
	if in.Quantity <= 0 {
		return nil, fmt.Errorf("resolving %s: quantity must be positive, got %d", in.Target, in.Quantity)
	}
	targetItem, ok := t.Item(in.Target)
	if !ok {
		return nil, fmt.Errorf("resolving %s: %w: %q", in.Target, ErrUnknownItem, in.Target)
	}

	r := &resolver{t: t, in: in, state: map[string]dfsState{}, nodes: map[string]*Node{}, costs: map[string]*big.Rat{}}
	if err := r.walk(in.Target, nil); err != nil {
		return nil, fmt.Errorf("resolving %s: %w", targetItem.Name, err)
	}

	g := &ResolvedGraph{
		Target:      in.Target,
		Quantity:    in.Quantity,
		GameVersion: t.GameVersion,
		byID:        r.nodes,
	}
	// r.order is DFS post-order: every node appears after all of its
	// descendants, so terminals come first and the target comes last.
	g.Nodes = make([]*Node, 0, len(r.order))
	for _, id := range r.order {
		g.Nodes = append(g.Nodes, r.nodes[id])
	}

	r.propagate(g)
	return g, nil
}

type resolver struct {
	// costs memoizes rawCost per item: nil means known-unresolvable.
	costs map[string]*big.Rat

	t     *Tier1
	in    PlanInput
	state map[string]dfsState
	nodes map[string]*Node
	order []string
}

// method resolves the single method for an item, validating it against the
// vocabulary and against what the artifact actually offers.
func (r *resolver) method(it Item) (Method, error) {
	m, overridden := r.in.Methods[it.ID]
	if !overridden {
		return it.DefaultMethod, nil
	}
	if !m.Valid() {
		// Catches "buy" specifically: it is not part of the vocabulary.
		return "", fmt.Errorf("%w: %q is not part of the method vocabulary (craft, refine, raw, cook)", ErrIllegalMethod, m)
	}
	if !r.t.methodAvailable(it, m) {
		return "", fmt.Errorf("%w: %s has no %s recipe", ErrIllegalMethod, it.Name, m)
	}
	return m, nil
}

// walk performs the depth-first traversal, detecting cycles and building the
// node and edge structure. Quantities are not computed here.
func (r *resolver) walk(id string, path []string) error {
	switch r.state[id] {
	case inProgress:
		return fmt.Errorf("%w: %s", ErrCycleDetected, r.cyclePath(path, id))
	case done:
		return nil
	}

	it, ok := r.t.Item(id)
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownItem, id)
	}

	m, err := r.method(it)
	if err != nil {
		return err
	}

	r.state[id] = inProgress

	n := &Node{
		ItemID:       id,
		Name:         it.Name,
		Method:       m,
		LegalMethods: r.t.LegalMethods(id),
		Terminal:     m == MethodRaw,
		Verified:     it.IsVerified(),
		total:        new(big.Rat),
	}

	if !n.Terminal {
		rc, err := r.selectRecipe(it, m)
		if err != nil {
			return err
		}
		n.Recipe = rc.ID
		n.Yield = rc.Producing()
		n.LegalRecipes = r.t.LegalRecipes(id, m)
		if !rc.IsVerified() {
			n.Verified = false
		}

		// Sorted so traversal order — and therefore the emitted node order —
		// never depends on artifact ordering or map iteration.
		// Governing: SPEC-0001 REQ "Determinism".
		inputs := make([]Input, len(rc.Inputs))
		copy(inputs, rc.Inputs)
		sort.Slice(inputs, func(a, b int) bool { return inputs[a].Item < inputs[b].Item })

		child := append(append([]string{}, path...), id)
		for _, input := range inputs {
			n.Children = append(n.Children, Edge{From: id, To: input.Item, PerUnit: input.Quantity, Yield: rc.Producing()})
			if err := r.walk(input.Item, child); err != nil {
				if len(path) == 0 {
					// The target's own frame; Resolve supplies the
					// "resolving <target>" head, so naming it again here
					// would double it.
					return err
				}
				return fmt.Errorf("expanding %s: %w", it.Name, err)
			}
		}
	}

	r.state[id] = done
	r.nodes[id] = n
	r.order = append(r.order, id)
	return nil
}

// cyclePath renders the participating node IDs, from the first occurrence of
// the repeated node through to its recurrence.
func (r *resolver) cyclePath(path []string, repeated string) string {
	start := 0
	for i, id := range path {
		if id == repeated {
			start = i
			break
		}
	}
	cycle := append(append([]string{}, path[start:]...), repeated)
	return strings.Join(cycle, " -> ")
}

// propagate walks the graph parents-first, multiplying each edge's per-unit
// quantity by its parent's running total and accumulating shared demand.
// Provenance taints along the same direction, since a total derived through
// an unverified node is itself unverified.
//
// Governing: SPEC-0001 REQ "Quantity Propagation and Aggregation",
// REQ "Provenance Propagation".
func (r *resolver) propagate(g *ResolvedGraph) {
	target := g.byID[g.Target]
	target.total.SetInt64(g.Quantity)

	// g.Nodes is terminals-first; reverse it to get parents before children.
	for i := len(g.Nodes) - 1; i >= 0; i-- {
		parent := g.Nodes[i]
		for _, e := range parent.Children {
			child := g.byID[e.To]

			// PerUnit is per application of the parent's recipe; Yield is how
			// many parents one application makes. Dividing here rather than
			// pre-folding keeps the whole chain exact — 1/50 of a Crystal
			// Sulphide stays 1/50, not 0.02.
			// Governing: SPEC-0001 REQ "Exact Arithmetic and Rounding
			// Discipline".
			contribution := new(big.Rat).Mul(parent.total, big.NewRat(e.PerUnit, e.Yield))
			child.total.Add(child.total, contribution)

			// Over-flagging is the honest direction: any unverified
			// contributor taints every figure derived from it.
			if !parent.Verified {
				child.Verified = false
			}
		}
	}
}
