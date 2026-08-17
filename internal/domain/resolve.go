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
}

// Edge is one resolved dependency, carrying the per-unit-of-parent quantity.
type Edge struct {
	// From is the consuming (parent) item ID.
	From string
	// To is the consumed (child) item ID.
	To string
	// PerUnit is how many To are needed per single unit of From.
	PerUnit int64
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

// TotalInt returns the total as an integer, reporting whether it was exact.
func (n *Node) TotalInt() (int64, bool) {
	if !n.total.IsInt() {
		return 0, false
	}
	return n.total.Num().Int64(), true
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

	r := &resolver{t: t, in: in, state: map[string]dfsState{}, nodes: map[string]*Node{}}
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
		rc, ok := r.t.Recipe(id, m)
		if !ok {
			// Unreachable via method(), which already validated availability.
			return fmt.Errorf("expanding %s: %w: no %s recipe", it.Name, ErrIllegalMethod, m)
		}
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
			n.Children = append(n.Children, Edge{From: id, To: input.Item, PerUnit: input.Quantity})
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

			contribution := new(big.Rat).Mul(parent.total, new(big.Rat).SetInt64(e.PerUnit))
			child.total.Add(child.total, contribution)

			// Over-flagging is the honest direction: any unverified
			// contributor taints every figure derived from it.
			if !parent.Verified {
				child.Verified = false
			}
		}
	}
}
