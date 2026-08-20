// Package bridge encodes domain values for the boundary the view consumes.
//
// Governing: ADR-0003 (Go domain, thin adapter), SPEC-0002 REQ "Result
// Envelope", REQ "Exact Quantity Encoding", REQ "Recipe Selection Crossing",
// REQ "Determinism Across the Boundary"
//
// ADR-0003 splits the application into a domain package that imports no
// syscall/js and a thin adapter that is the only code permitted to touch
// js.Value. This package is the encoding half of that adapter, and it is
// deliberately free of syscall/js too: everything here is testable under
// plain `go test` with no WASM build, and the js-facing shim is a later
// story that marshals what this produces.
//
// The one rule that shapes every type below: a quantity never becomes a
// JSON number. JavaScript's number type cannot hold 2^53 exactly, and the
// engine's whole exactness commitment would be spent one step before the
// value a user reads.
package bridge

import (
	"encoding/json"
	"fmt"
	"math/big"

	"github.com/jonstump/nms-base-planner/internal/domain"
)

// ContractVersion is the boundary contract this package implements.
//
// Governing: SPEC-0002 REQ "Contract Versioning" — "The version MUST change
// whenever the envelope shape, the encoding of quantities, or the sentinel
// code set changes." The consuming view checks it and refuses a mismatch
// rather than parsing an unexpected shape.
const ContractVersion = "1.0.0"

// Quantity is an exact quantity on the wire.
//
// Governing: SPEC-0002 REQ "Exact Quantity Encoding" — "Every quantity
// crossing the boundary MUST be encoded as a decimal string, never as a
// JavaScript number ... Where a total is not an exact integer, it MUST be
// encoded as an exact decimal or rational string that round-trips without
// loss."
//
// Integral values render as decimal digits ("300"); a fractional value
// renders as a rational ("5/2"). Both round-trip exactly. The alternative
// for the fractional case — a fixed number of decimal places — has to
// choose a precision, and any choice truncates some value the engine
// computed exactly.
type Quantity string

// QuantityOf renders an exact rational.
//
// big.Rat.RatString is the only formatter used: it emits "a/b", or just "a"
// when the denominator is one, and it is lossless in both cases.
// FloatString rounds to a fixed number of places, and Float64 is a
// conversion this package must not make.
func QuantityOf(r *big.Rat) Quantity {
	if r == nil {
		return "0"
	}
	return Quantity(r.RatString())
}

// QuantityOfInt renders an integer quantity.
func QuantityOfInt(v int64) Quantity { return Quantity(new(big.Int).SetInt64(v).String()) }

// Rat parses a Quantity back to an exact rational, which is what makes
// "round-trips without loss" checkable rather than asserted.
func (q Quantity) Rat() (*big.Rat, bool) {
	r, ok := new(big.Rat).SetString(string(q))
	return r, ok
}

// Envelope is what every entry point returns.
//
// Governing: SPEC-0002 REQ "Result Envelope" — "a single envelope carrying
// an explicit success flag, exactly one of a result payload or an error
// payload, and the contract version."
//
// Data and Error are pointers so that exactly one is present on the wire. A
// failure marshals with no data key at all rather than with an empty object:
// the requirement's scenario says "carries no result payload — not an empty
// one", and a zero-valued struct that renders as {} reads to a consumer as
// a successful call that produced nothing.
type Envelope struct {
	OK              bool           `json:"ok"`
	ContractVersion string         `json:"contractVersion"`
	Data            *ResultPayload `json:"data,omitempty"`
	Error           *ErrorPayload  `json:"error,omitempty"`
}

// ResultPayload is the success half.
type ResultPayload struct {
	Graph *Graph `json:"graph,omitempty"`
}

// ErrorPayload is the failure half.
//
// Code is a stable machine-readable identifier; the sentinel mapping that
// fills it is #44's story, and until then everything crosses as
// CodeUnclassified. Message carries the domain's prose, including the
// wrapped resolution path, with no contractual guarantee of format.
type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// CodeUnclassified is the code reserved for a failure matching no known
// sentinel. SPEC-0002 REQ "Sentinel Error Preservation" requires the
// reserved code exist so an unmatched error is never silently mapped onto
// an unrelated sentinel; the rest of the code set arrives with #44.
const CodeUnclassified = "UNCLASSIFIED"

// Success builds an envelope carrying a payload and no error.
func Success(data ResultPayload) Envelope {
	return Envelope{OK: true, ContractVersion: ContractVersion, Data: &data}
}

// Failure builds an envelope carrying an error and no payload.
func Failure(code, message string) Envelope {
	if code == "" {
		code = CodeUnclassified
	}
	return Envelope{
		OK:              false,
		ContractVersion: ContractVersion,
		Error:           &ErrorPayload{Code: code, Message: message},
	}
}

// Plan is the plan state crossing in both directions.
//
// Governing: SPEC-0002 REQ "Recipe Selection Crossing"
//
// Methods and Recipes are omitempty because absence is meaningful: a node
// on its default records nothing. ADR-0002 puts plan state in the URL hash,
// so a payload that grows with graph size rather than with user intent
// makes the hash grow with it.
type Plan struct {
	Target   string            `json:"target"`
	Quantity Quantity          `json:"quantity"`
	Methods  map[string]string `json:"methods,omitempty"`
	Recipes  map[string]string `json:"recipes,omitempty"`
}

// Node is one resolved node on the wire.
type Node struct {
	ItemID string   `json:"itemId"`
	Name   string   `json:"name"`
	Total  Quantity `json:"total"`

	Method       string   `json:"method"`
	LegalMethods []string `json:"legalMethods"`

	// Recipe and LegalRecipes let the view offer alternatives without
	// reading the artifact, which it has no access to.
	// Governing: SPEC-0002 REQ "Recipe Selection Crossing"
	Recipe       string   `json:"recipe,omitempty"`
	LegalRecipes []string `json:"legalRecipes,omitempty"`

	// Yield is how many units one application of the recipe makes, and
	// Applications how many applications the total needs — the latter
	// exact and unrounded, per SPEC-0001's rounding discipline.
	Yield        Quantity `json:"yield,omitempty"`
	Applications Quantity `json:"applications,omitempty"`

	Terminal bool `json:"terminal"`
	Verified bool `json:"verified"`

	Children []Edge `json:"children,omitempty"`
}

// Edge is one dependency on the wire.
type Edge struct {
	To      string   `json:"to"`
	PerUnit Quantity `json:"perUnit"`
	Yield   Quantity `json:"yield"`
}

// Graph is a resolved graph on the wire.
type Graph struct {
	Target      string   `json:"target"`
	Quantity    Quantity `json:"quantity"`
	GameVersion string   `json:"gameVersion"`

	// Nodes preserve the domain's order: terminals first, target last.
	// Governing: SPEC-0002 REQ "Determinism Across the Boundary".
	Nodes []Node `json:"nodes"`
}

// EncodeGraph renders a resolved graph for the boundary.
//
// Governing: SPEC-0002 REQ "Exact Quantity Encoding", REQ "Determinism
// Across the Boundary"
//
// Order is the domain's, unchanged — the adapter does not re-sort, because
// the tab order the view renders is a domain decision (SPEC-0001 REQ
// "Determinism") and re-deriving it here would be a second place for it to
// drift.
func EncodeGraph(g *domain.ResolvedGraph) (*Graph, error) {
	if g == nil {
		return nil, fmt.Errorf("encoding graph: nil resolved graph")
	}
	out := &Graph{
		Target:      g.Target,
		Quantity:    QuantityOfInt(g.Quantity),
		GameVersion: g.GameVersion,
		Nodes:       make([]Node, 0, len(g.Nodes)),
	}
	for _, n := range g.Nodes {
		out.Nodes = append(out.Nodes, encodeNode(n))
	}
	return out, nil
}

func encodeNode(n *domain.Node) Node {
	out := Node{
		ItemID: n.ItemID,
		Name:   n.Name,
		// Total() is an exact rational and stays one all the way to the
		// string. TotalInt is deliberately not consulted: it reports
		// whether the value happens to fit an int64, and a value that does
		// not must still cross exactly rather than as a substitute.
		Total:        QuantityOf(n.Total()),
		Method:       string(n.Method),
		Recipe:       n.Recipe,
		LegalRecipes: n.LegalRecipes,
		Terminal:     n.Terminal,
		Verified:     n.Verified,
	}
	for _, m := range n.LegalMethods {
		out.LegalMethods = append(out.LegalMethods, string(m))
	}
	if n.Yield > 0 {
		out.Yield = QuantityOfInt(n.Yield)
	}
	if a := n.Applications(); a != nil {
		out.Applications = QuantityOf(a)
	}
	for _, e := range n.Children {
		out.Children = append(out.Children, Edge{
			To:      e.To,
			PerUnit: QuantityOfInt(e.PerUnit),
			Yield:   QuantityOfInt(e.Yield),
		})
	}
	return out
}

// EncodePlan renders a plan input for the boundary, recording only
// deliberate choices.
//
// Governing: SPEC-0002 REQ "Recipe Selection Crossing" — "WHEN a plan in
// which every node uses its default recipe is encoded THEN the payload
// contains no recipe selections."
func EncodePlan(in domain.PlanInput) Plan {
	out := Plan{Target: in.Target, Quantity: QuantityOfInt(in.Quantity)}
	if len(in.Methods) > 0 {
		out.Methods = make(map[string]string, len(in.Methods))
		for item, m := range in.Methods {
			out.Methods[item] = string(m)
		}
	}
	if len(in.Recipes) > 0 {
		out.Recipes = make(map[string]string, len(in.Recipes))
		for item, r := range in.Recipes {
			out.Recipes[item] = r
		}
	}
	return out
}

// DecodePlan turns a wire plan back into a domain input.
func DecodePlan(p Plan) (domain.PlanInput, error) {
	qty, ok := p.Quantity.Rat()
	if !ok || !qty.IsInt() || !qty.Num().IsInt64() {
		return domain.PlanInput{}, fmt.Errorf("decoding plan: quantity %q is not a whole number", p.Quantity)
	}
	out := domain.PlanInput{Target: p.Target, Quantity: qty.Num().Int64()}
	if len(p.Methods) > 0 {
		out.Methods = make(map[string]domain.Method, len(p.Methods))
		for item, m := range p.Methods {
			out.Methods[item] = domain.Method(m)
		}
	}
	if len(p.Recipes) > 0 {
		out.Recipes = make(map[string]string, len(p.Recipes))
		for item, r := range p.Recipes {
			out.Recipes[item] = r
		}
	}
	return out, nil
}

// Marshal renders an envelope as the bytes that cross the boundary.
//
// Governing: SPEC-0002 REQ "Determinism Across the Boundary" — "the same
// plan input is resolved and encoded twice ... the two encoded outputs are
// byte-identical."
//
// Struct field order is fixed by the types, node order is the domain's, and
// the only maps are the plan's selections, which encoding/json emits with
// sorted keys. Determinism therefore falls out rather than being imposed.
func Marshal(e Envelope) ([]byte, error) {
	blob, err := json.Marshal(e)
	if err != nil {
		return nil, fmt.Errorf("marshalling envelope: %w", err)
	}
	return blob, nil
}
