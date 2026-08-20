package domain

import (
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"
)

// load builds a Tier1 from a JSON literal, failing the test if it will not
// validate. Selection scenarios need artifacts the Stasis fixture cannot
// express — several recipes for one output and method — so they are written
// inline rather than added to a fixture other tests assert node counts over.
func load(t *testing.T, artifact string) *Tier1 {
	t.Helper()
	a1, err := LoadTier1(strings.NewReader(artifact))
	if err != nil {
		t.Fatalf("loading artifact: %v", err)
	}
	return a1
}

// nitrate is the readable real example from ADR-0005: Sodium Nitrate carries
// 26 refine recipes, among them 2x Sodium -> 1x and 1x Crystal Sulphide ->
// 50x. The 24 filler recipes stand in for the rest of the real list; they
// exist so the list is genuinely long rather than nominally plural.
func nitrate(t *testing.T) *Tier1 {
	t.Helper()
	var recipes []string
	recipes = append(recipes,
		`{"id":"CAT2_SODIUM","output":"CATALYST2","method":"refine","inputs":[{"item":"SODIUM","quantity":2}]}`,
		`{"id":"CAT2_SULPHIDE","output":"CATALYST2","method":"refine","inputs":[{"item":"SULPHIDE","quantity":1}],"yield":50}`,
	)
	var items []string
	items = append(items,
		`{"id":"SODIUM","name":"Sodium","raw_obtainable":true,"default_method":"raw"}`,
		`{"id":"SULPHIDE","name":"Crystal Sulphide","raw_obtainable":true,"default_method":"raw"}`,
		`{"id":"CATALYST2","name":"Sodium Nitrate","default_method":"refine"}`,
	)
	for i := 0; i < 24; i++ {
		items = append(items, fmt.Sprintf(`{"id":"FILL%02d","name":"Filler %d","raw_obtainable":true,"default_method":"raw"}`, i, i))
		// Costlier than both real routes, so their presence cannot change
		// which recipe the default rule picks.
		recipes = append(recipes, fmt.Sprintf(`{"id":"CAT2_FILL%02d","output":"CATALYST2","method":"refine","inputs":[{"item":"FILL%02d","quantity":100}]}`, i, i))
	}
	return load(t, fmt.Sprintf(`{
	  "schema_version": 2, "game_version": "adr-0005",
	  "items": [%s],
	  "recipes": [%s]
	}`, strings.Join(items, ",\n"), strings.Join(recipes, ",\n")))
}

// Governing: SPEC-0001 REQ "Recipe Selection" —
// Scenario "Alternatives are reported, not hidden".
// ADR-0005: CATALYST2 carries 26 refine recipes.
func TestManyRecipesForOneOutputLoad(t *testing.T) {
	a1 := nitrate(t)

	if got := len(a1.RecipesFor("CATALYST2", MethodRefine)); got != 26 {
		t.Fatalf("refine recipes for CATALYST2 = %d, want 26", got)
	}

	legal := a1.LegalRecipes("CATALYST2", MethodRefine)
	if len(legal) != 26 {
		t.Fatalf("legal recipes = %d, want 26", len(legal))
	}
	for i := 1; i < len(legal); i++ {
		if legal[i-1] >= legal[i] {
			t.Fatalf("legal recipes are not sorted: %q before %q", legal[i-1], legal[i])
		}
	}

	// The node reports the whole list, not just the one it took.
	g, err := Resolve(a1, PlanInput{Target: "CATALYST2", Quantity: 1})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	n, _ := g.Node("CATALYST2")
	if len(n.LegalRecipes) != 26 {
		t.Errorf("node legal recipes = %d, want 26", len(n.LegalRecipes))
	}
	if n.Recipe == "" {
		t.Error("node resolved to no recipe")
	}
}

// Governing: SPEC-0001 REQ "Exact Arithmetic and Rounding Discipline" —
// "A recipe producing y units to satisfy a demand of n MUST be applied as
// exact arithmetic over n and y, never as a floating-point division."
func TestYieldAppliesExactly(t *testing.T) {
	a1 := nitrate(t)
	g, err := Resolve(a1, PlanInput{
		Target:   "CATALYST2",
		Quantity: 125,
		Recipes:  map[string]string{"CATALYST2": "CAT2_SULPHIDE"},
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	// 125 Sodium Nitrate at 50 per application: 2.5 applications, each
	// consuming one Crystal Sulphide.
	sul, _ := g.Node("SULPHIDE")
	if got, want := sul.Total().RatString(), "5/2"; got != want {
		t.Errorf("Crystal Sulphide total = %s, want %s", got, want)
	}
	if _, exact := sul.TotalInt(); exact {
		t.Error("a fractional total reported itself as an exact integer")
	}

	nit, _ := g.Node("CATALYST2")
	if got, want := nit.Applications().RatString(), "5/2"; got != want {
		t.Errorf("applications = %s, want %s", got, want)
	}
	if got := ceil(nit.Applications()); got != 3 {
		t.Errorf("whole batches = %d, want 3", got)
	}

	// The demand is met by whole applications, never by 2.5 of them.
	if got := ceil(nit.Applications()) * nit.Yield; got < 125 {
		t.Errorf("3 applications yield %d, which does not meet 125", got)
	}
}

// ceil rounds a rational up using integer division on its numerator and
// denominator — the operation the spec permits at a rounding boundary, and
// the one no float is involved in.
func ceil(r *big.Rat) int64 {
	q, m := new(big.Int).QuoRem(r.Num(), r.Denom(), new(big.Int))
	if m.Sign() > 0 {
		q.Add(q, big.NewInt(1))
	}
	return q.Int64()
}

// Governing: SPEC-0001 REQ "Recipe Selection" —
// Scenario "A node with alternatives selects deterministically".
func TestDefaultRecipeIsTheCheapestInRawTerms(t *testing.T) {
	g, err := Resolve(nitrate(t), PlanInput{Target: "CATALYST2", Quantity: 1})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	n, _ := g.Node("CATALYST2")

	// 1/50 of a Crystal Sulphide beats 2 Sodium and beats all 24 fillers.
	if n.Recipe != "CAT2_SULPHIDE" {
		t.Errorf("default recipe = %q, want CAT2_SULPHIDE", n.Recipe)
	}
	if _, reached := g.Node("SODIUM"); reached {
		t.Error("Sodium was expanded; the Sodium route was not the one selected")
	}
	sul, _ := g.Node("SULPHIDE")
	if got, want := sul.Total().RatString(), "1/50"; got != want {
		t.Errorf("Crystal Sulphide total = %s, want %s", got, want)
	}
}

// Governing: SPEC-0001 REQ "Recipe Selection" — ties broken by a stable
// recipe identifier, so the choice cannot depend on artifact ordering.
func TestTiesBreakOnRecipeID(t *testing.T) {
	// Two routes of identical raw cost. Listed worst-id-first so a
	// first-wins implementation would pick the other one.
	const artifact = `{
	  "schema_version": 2, "game_version": "test-tie",
	  "items": [
	    {"id":"x","name":"X","raw_obtainable":true,"default_method":"raw"},
	    {"id":"y","name":"Y","raw_obtainable":true,"default_method":"raw"},
	    {"id":"z","name":"Z","default_method":"refine"}
	  ],
	  "recipes": [
	    {"id":"z_via_y","output":"z","method":"refine","inputs":[{"item":"y","quantity":3}]},
	    {"id":"z_via_x","output":"z","method":"refine","inputs":[{"item":"x","quantity":3}]}
	  ]
	}`
	g, err := Resolve(load(t, artifact), PlanInput{Target: "z", Quantity: 1})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	n, _ := g.Node("z")
	if n.Recipe != "z_via_x" {
		t.Errorf("tie-broken recipe = %q, want z_via_x (lexicographically smaller id)", n.Recipe)
	}
}

// Governing: SPEC-0001 REQ "Determinism", REQ "Recipe Selection" — "The same
// artifact and the same target MUST select the same default on every run."
func TestDefaultSelectionIsStableAcrossRuns(t *testing.T) {
	a1 := nitrate(t)
	first := map[string]string{}
	for run := 0; run < 25; run++ {
		g, err := Resolve(a1, PlanInput{Target: "CATALYST2", Quantity: 3})
		if err != nil {
			t.Fatalf("run %d: %v", run, err)
		}
		for _, n := range g.Nodes {
			if run == 0 {
				first[n.ItemID] = n.Recipe
				continue
			}
			if n.Recipe != first[n.ItemID] {
				t.Fatalf("run %d selected %q for %s, run 1 selected %q", run+1, n.Recipe, n.ItemID, first[n.ItemID])
			}
		}
	}

	// The same must hold of the fixture, whose every node has exactly one
	// candidate — a stability check that passes vacuously there is not one.
	stasisFirst := map[string]string{}
	for run := 0; run < 5; run++ {
		g := resolveStasis(t, 4, nil)
		for _, n := range g.Nodes {
			if run == 0 {
				stasisFirst[n.ItemID] = n.Recipe
				continue
			}
			if n.Recipe != stasisFirst[n.ItemID] {
				t.Fatalf("stasis run %d selected %q for %s, want %q", run+1, n.Recipe, n.ItemID, stasisFirst[n.ItemID])
			}
		}
	}
}

// Governing: SPEC-0001 REQ "Recipe Selection" —
// Scenario "Recipe change alters expansion".
func TestRecipeOverrideChangesExpansion(t *testing.T) {
	a1 := nitrate(t)
	g, err := Resolve(a1, PlanInput{
		Target:   "CATALYST2",
		Quantity: 100,
		Recipes:  map[string]string{"CATALYST2": "CAT2_SODIUM"},
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	n, _ := g.Node("CATALYST2")
	if n.Recipe != "CAT2_SODIUM" {
		t.Fatalf("recipe = %q, want CAT2_SODIUM", n.Recipe)
	}
	sod, ok := g.Node("SODIUM")
	if !ok {
		t.Fatal("Sodium missing after overriding onto the Sodium route")
	}
	if got, _ := sod.TotalInt(); got != 200 {
		t.Errorf("Sodium total = %d, want 200", got)
	}
	if _, reached := g.Node("SULPHIDE"); reached {
		t.Error("Crystal Sulphide still expanded after the override")
	}
}

// Governing: SPEC-0001 REQ "Recipe Selection" —
// Scenario "An illegal recipe is rejected".
func TestIllegalRecipeIsRejected(t *testing.T) {
	g, err := Resolve(nitrate(t), PlanInput{
		Target:   "CATALYST2",
		Quantity: 1,
		Recipes:  map[string]string{"CATALYST2": "CAT2_NOT_A_RECIPE"},
	})
	if !errors.Is(err, ErrIllegalMethod) {
		t.Fatalf("error = %v, want ErrIllegalMethod", err)
	}
	if g != nil {
		t.Error("a graph was returned alongside an error; must be nil")
	}
	for _, want := range []string{"Sodium Nitrate", "CAT2_NOT_A_RECIPE"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not name %q", err, want)
		}
	}
}

// Governing: SPEC-0001 REQ "Recipe Selection" —
// Scenario "Defaults cost no plan state".
func TestDefaultsCostNoPlanState(t *testing.T) {
	in := PlanInput{Target: "sd", Quantity: 1}
	g, err := Resolve(loadFixture(t), in)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if in.Recipes != nil {
		t.Fatal("resolving mutated the plan input")
	}
	// Every non-terminal node still resolved to a named recipe, so "no
	// selections recorded" is about plan state, not about missing data.
	for _, n := range g.Nodes {
		switch {
		case n.Terminal && n.Recipe != "":
			t.Errorf("terminal node %s carries recipe %q", n.ItemID, n.Recipe)
		case !n.Terminal && n.Recipe == "":
			t.Errorf("node %s resolved to no recipe", n.ItemID)
		}
	}
}

// A self-referential recipe must not be chosen while another route exists.
// The refiner data contains them (ADR-0005), so this is a live condition
// rather than a hypothetical one.
func TestSelfReferentialRecipeIsNotPreferred(t *testing.T) {
	const artifact = `{
	  "schema_version": 2, "game_version": "test-self",
	  "items": [
	    {"id":"raw","name":"Raw","raw_obtainable":true,"default_method":"raw"},
	    {"id":"a","name":"Alpha","default_method":"refine"}
	  ],
	  "recipes": [
	    {"id":"a_self","output":"a","method":"refine","inputs":[{"item":"a","quantity":1}],"yield":2},
	    {"id":"a_raw","output":"a","method":"refine","inputs":[{"item":"raw","quantity":9999}]}
	  ]
	}`
	g, err := Resolve(load(t, artifact), PlanInput{Target: "a", Quantity: 1})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	n, _ := g.Node("a")
	// a_self sorts first by id and is far cheaper on its face, so both the
	// cost rule and the tie-break point at it. Only the cycle guard in
	// rawCost rules it out — without one, costing it does not terminate.
	if n.Recipe != "a_raw" {
		t.Errorf("recipe = %q, want a_raw; the self-referential recipe was preferred", n.Recipe)
	}
}

// Governing: SPEC-0001 REQ "Recipe Selection" — the recipe id is what a plan
// records, so an artifact that leaves it absent or ambiguous is unusable.
func TestRecipeIdentityIsValidated(t *testing.T) {
	const head = `{"schema_version":2,"game_version":"test-ids",
	  "items":[{"id":"x","name":"X","raw_obtainable":true,"default_method":"raw"},
	           {"id":"z","name":"Z","default_method":"refine"}],
	  "recipes":[`
	cases := []struct {
		name    string
		recipes string
		want    string
	}{
		{
			name:    "no id",
			recipes: `{"output":"z","method":"refine","inputs":[{"item":"x","quantity":1}]}`,
			want:    "has no id",
		},
		{
			name: "duplicate id",
			recipes: `{"id":"dup","output":"z","method":"refine","inputs":[{"item":"x","quantity":1}]},
			          {"id":"dup","output":"z","method":"refine","inputs":[{"item":"x","quantity":2}]}`,
			want: `duplicate recipe id "dup"`,
		},
		{
			name:    "negative yield",
			recipes: `{"id":"z_x","output":"z","method":"refine","inputs":[{"item":"x","quantity":1}],"yield":-5}`,
			want:    "yield must be positive",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := LoadTier1(strings.NewReader(head + tc.recipes + "]}"))
			if !errors.Is(err, ErrInvalidArtifact) {
				t.Fatalf("error = %v, want ErrInvalidArtifact", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

// Two recipes for one output and method must load — the condition the old
// schema rejected outright, and the whole reason for ADR-0005.
func TestTwoRecipesForOneOutputAndMethodLoad(t *testing.T) {
	const artifact = `{
	  "schema_version": 2, "game_version": "test-plural",
	  "items": [
	    {"id":"x","name":"X","raw_obtainable":true,"default_method":"raw"},
	    {"id":"z","name":"Z","default_method":"refine"}
	  ],
	  "recipes": [
	    {"id":"z_a","output":"z","method":"refine","inputs":[{"item":"x","quantity":1}]},
	    {"id":"z_b","output":"z","method":"refine","inputs":[{"item":"x","quantity":2}]}
	  ]
	}`
	a1 := load(t, artifact)
	if got := len(a1.RecipesFor("z", MethodRefine)); got != 2 {
		t.Fatalf("recipes = %d, want 2", got)
	}
	if _, ok := a1.Recipe("z", MethodRefine, "z_b"); !ok {
		t.Error("Recipe could not retrieve z_b by id")
	}
	if _, ok := a1.Recipe("z", MethodRefine, "z_missing"); ok {
		t.Error("Recipe returned a value for an id the artifact does not carry")
	}
}
