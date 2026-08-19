package domain

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

// Method is the vocabulary a node can resolve to.
//
// Governing: SPEC-0001 REQ "Method Resolution" — "Each node MUST resolve to
// exactly one method from the set craft, refine, raw, cook. The engine MUST
// NOT define, accept, or produce a buy method — this is a build planner, not
// a shopping list."
type Method string

const (
	MethodCraft  Method = "craft"
	MethodRefine Method = "refine"
	MethodRaw    Method = "raw"
	MethodCook   Method = "cook"
)

// validMethods is the whole vocabulary. Note the deliberate absence of "buy".
var validMethods = map[Method]bool{
	MethodCraft:  true,
	MethodRefine: true,
	MethodRaw:    true,
	MethodCook:   true,
}

// Valid reports whether m is part of the method vocabulary.
func (m Method) Valid() bool { return validMethods[m] }

// Item is one node identity in the Tier 1 artifact.
type Item struct {
	ID   string `json:"id"`
	Name string `json:"name"`

	// RawObtainable marks an item that can be gathered directly. An item may
	// be both raw-obtainable and have recipes; resolving it to raw terminates
	// expansion regardless.
	RawObtainable bool `json:"raw_obtainable"`

	// DefaultMethod is the method used when the plan does not select one.
	DefaultMethod Method `json:"default_method"`

	// Verified records whether this item's data was confirmed in-game. The
	// zero value of a *bool is nil, which we read as verified; only an
	// explicit `"verified": false` marks an item unverified, so the common
	// case needs no field.
	Verified *bool `json:"verified,omitempty"`
}

// IsVerified reports the item's provenance, defaulting to verified when the
// artifact says nothing.
func (i Item) IsVerified() bool { return i.Verified == nil || *i.Verified }

// Input is one edge of a recipe, in per-unit-of-output quantity.
type Input struct {
	Item     string `json:"item"`
	Quantity int64  `json:"quantity"`
}

// Recipe produces one unit of Output by Method from Inputs.
type Recipe struct {
	Output   string  `json:"output"`
	Method   Method  `json:"method"`
	Inputs   []Input `json:"inputs"`
	Verified *bool   `json:"verified,omitempty"`
}

// IsVerified reports the recipe's provenance, defaulting to verified.
func (r Recipe) IsVerified() bool { return r.Verified == nil || *r.Verified }

// CurrentSchemaVersion is the schema every artifact this package writes or
// accepts must declare.
//
// Governing: SPEC-0004 REQ "Schema Extension and Load Compatibility" — the
// schema, the producer and the loader move together, so a version bump is
// how an artifact from the wrong side of a change is rejected rather than
// silently half-read.
//
// 1: items and recipes only.
// 2: adds provenance and the base-economy section.
const CurrentSchemaVersion = 2

// Provenance records the inputs a generated artifact was derived from.
//
// Deliberately carries no generation timestamp: SPEC-0004 REQ "Deterministic
// Output" requires two runs over one install to be byte-identical, and a
// clock reading would defeat that for no benefit the game version does not
// already provide.
type Provenance struct {
	// Archives names the .pak files read, in sorted order.
	Archives []string `json:"archives"`
	// MBINCompiler is the decompiler version that produced the .MXML input.
	MBINCompiler string `json:"mbincompiler"`
}

// Tier1 is the extracted recipe graph.
//
// Governing: ADR-0001 (two-tier ingestion) — Tier 1 is machine-extracted and
// regenerated per game version; it is never hand-edited in production.
type Tier1 struct {
	SchemaVersion int    `json:"schema_version"`
	GameVersion   string `json:"game_version"`
	Extracted     bool   `json:"extracted"`
	Source        string `json:"source"`
	Note          string `json:"note"`

	// Provenance records what produced a generated artifact. Absent on
	// hand-authored fixtures, which carry Extracted false instead.
	//
	// Governing: SPEC-0004 REQ "Source Provenance and Version Stamping"
	Provenance *Provenance `json:"provenance,omitempty"`

	Items   []Item   `json:"items"`
	Recipes []Recipe `json:"recipes"`

	// Economy is the base-economy half of the artifact. Optional so that
	// recipe-only fixtures remain valid.
	//
	// Governing: SPEC-0004 REQ "Base Economy Data"
	Economy *Economy `json:"economy,omitempty"`

	// Derived indexes, built by Validate.
	itemsByID    map[string]Item
	recipesByOut map[string]map[Method]Recipe
	legalMethods map[string][]Method
}

// LoadTier1 reads and validates a Tier 1 artifact.
func LoadTier1(r io.Reader) (*Tier1, error) {
	var t Tier1
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&t); err != nil {
		return nil, fmt.Errorf("%w: decoding: %w", ErrInvalidArtifact, err)
	}
	if err := t.Validate(); err != nil {
		return nil, err
	}
	return &t, nil
}

// Validate checks structural integrity and builds the lookup indexes.
func (t *Tier1) Validate() error {
	if t.SchemaVersion != CurrentSchemaVersion {
		// Governing: SPEC-0004 REQ "Schema Extension and Load Compatibility"
		// — an artifact from the other side of a schema change is refused
		// outright rather than half-read, since the fields it is missing (or
		// carrying) are exactly the ones a partial read would get wrong.
		return fmt.Errorf("%w: schema_version %d, want %d", ErrInvalidArtifact, t.SchemaVersion, CurrentSchemaVersion)
	}
	if t.GameVersion == "" {
		// Governing: SPEC-0001 REQ "Dependency Graph Resolution" — fixtures
		// asserting exact node counts or leaf totals must name the game
		// version they were captured against, so a failure is attributable
		// to changed game data rather than to an engine regression.
		return fmt.Errorf("%w: game_version is required", ErrInvalidArtifact)
	}

	t.itemsByID = make(map[string]Item, len(t.Items))
	for _, it := range t.Items {
		if it.ID == "" {
			return fmt.Errorf("%w: item with empty id", ErrInvalidArtifact)
		}
		if _, dup := t.itemsByID[it.ID]; dup {
			return fmt.Errorf("%w: duplicate item id %q", ErrInvalidArtifact, it.ID)
		}
		if !it.DefaultMethod.Valid() {
			return fmt.Errorf("%w: item %q: %w: %q", ErrInvalidArtifact, it.ID, ErrIllegalMethod, it.DefaultMethod)
		}
		t.itemsByID[it.ID] = it
	}

	t.recipesByOut = make(map[string]map[Method]Recipe)
	for _, rc := range t.Recipes {
		if _, ok := t.itemsByID[rc.Output]; !ok {
			return fmt.Errorf("%w: recipe output %q: %w", ErrInvalidArtifact, rc.Output, ErrUnknownItem)
		}
		if !rc.Method.Valid() {
			return fmt.Errorf("%w: recipe for %q: %w: %q", ErrInvalidArtifact, rc.Output, ErrIllegalMethod, rc.Method)
		}
		if rc.Method == MethodRaw {
			return fmt.Errorf("%w: recipe for %q declares method raw, which is terminal by definition", ErrInvalidArtifact, rc.Output)
		}
		if len(rc.Inputs) == 0 {
			return fmt.Errorf("%w: recipe for %q has no inputs", ErrInvalidArtifact, rc.Output)
		}
		for _, in := range rc.Inputs {
			if _, ok := t.itemsByID[in.Item]; !ok {
				return fmt.Errorf("%w: recipe for %q input %q: %w", ErrInvalidArtifact, rc.Output, in.Item, ErrUnknownItem)
			}
			if in.Quantity <= 0 {
				return fmt.Errorf("%w: recipe for %q input %q: quantity must be positive, got %d", ErrInvalidArtifact, rc.Output, in.Item, in.Quantity)
			}
		}
		byMethod, ok := t.recipesByOut[rc.Output]
		if !ok {
			byMethod = make(map[Method]Recipe)
			t.recipesByOut[rc.Output] = byMethod
		}
		if _, dup := byMethod[rc.Method]; dup {
			return fmt.Errorf("%w: duplicate %s recipe for %q", ErrInvalidArtifact, rc.Method, rc.Output)
		}
		byMethod[rc.Method] = rc
	}

	// An item's default method must actually be available to it.
	for _, it := range t.Items {
		if !t.methodAvailable(it, it.DefaultMethod) {
			return fmt.Errorf("%w: item %q default method %q: %w", ErrInvalidArtifact, it.ID, it.DefaultMethod, ErrIllegalMethod)
		}
	}

	if t.Economy != nil {
		// Governing: SPEC-0004 REQ "Base Economy Data" — validated after the
		// item index is built, since crop yields reference item IDs.
		if err := t.Economy.validate(func(id string) bool {
			_, ok := t.itemsByID[id]
			return ok
		}); err != nil {
			return err
		}
	}

	t.legalMethods = make(map[string][]Method, len(t.Items))
	for _, it := range t.Items {
		var ms []Method
		if it.RawObtainable {
			ms = append(ms, MethodRaw)
		}
		for m := range t.recipesByOut[it.ID] {
			ms = append(ms, m)
		}
		// Sorted so output ordering never depends on map iteration.
		// Governing: SPEC-0001 REQ "Determinism".
		sort.Slice(ms, func(a, b int) bool { return ms[a] < ms[b] })
		t.legalMethods[it.ID] = ms
	}
	return nil
}

func (t *Tier1) methodAvailable(it Item, m Method) bool {
	if m == MethodRaw {
		return it.RawObtainable
	}
	_, ok := t.recipesByOut[it.ID][m]
	return ok
}

// Item looks up an item by ID.
func (t *Tier1) Item(id string) (Item, bool) {
	it, ok := t.itemsByID[id]
	return it, ok
}

// LegalMethods reports the methods available to an item, sorted.
//
// Governing: SPEC-0001 REQ "Method Resolution" — "The engine MUST report which
// methods are legal for a given node so the view can render unavailable
// options as inert rather than hiding them."
func (t *Tier1) LegalMethods(id string) []Method {
	ms := t.legalMethods[id]
	out := make([]Method, len(ms))
	copy(out, ms)
	return out
}

// Recipe returns the recipe producing id by method m.
func (t *Tier1) Recipe(id string, m Method) (Recipe, bool) {
	rc, ok := t.recipesByOut[id][m]
	return rc, ok
}
