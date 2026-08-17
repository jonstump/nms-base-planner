package domain

import (
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"strings"
	"testing"
)

// The fixture's recorded game version. Asserted so a failure reads as "data
// changed" rather than "engine broke".
//
// Governing: SPEC-0001 REQ "Dependency Graph Resolution" — "Fixtures asserting
// exact node counts or exact leaf totals MUST name the game version of the
// Tier 1 artifact they were captured against".
const fixtureGameVersion = "community-2026-08"

func loadFixture(t *testing.T) *Tier1 {
	t.Helper()
	f, err := os.Open("testdata/stasis-device.tier1.json")
	if err != nil {
		t.Fatalf("opening fixture: %v", err)
	}
	defer f.Close()
	a1, err := LoadTier1(f)
	if err != nil {
		t.Fatalf("loading fixture: %v", err)
	}
	return a1
}

func resolveStasis(t *testing.T, qty int64, methods map[string]Method) *ResolvedGraph {
	t.Helper()
	g, err := Resolve(loadFixture(t), PlanInput{Target: "sd", Quantity: qty, Methods: methods})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	return g
}

func totalOf(t *testing.T, g *ResolvedGraph, id string) int64 {
	t.Helper()
	n, ok := g.Node(id)
	if !ok {
		t.Fatalf("node %q missing from graph", id)
	}
	v, exact := n.TotalInt()
	if !exact {
		t.Fatalf("node %q total %s is not an exact integer", id, n.Total().RatString())
	}
	return v
}

// Governing: SPEC-0001 REQ "Dependency Graph Resolution" —
// Scenario "Fixture game version is asserted".
func TestFixtureGameVersionIsPinned(t *testing.T) {
	a1 := loadFixture(t)
	if a1.GameVersion != fixtureGameVersion {
		t.Fatalf("fixture game version = %q, want %q — the Tier 1 data changed; re-verify the expected totals below before updating this constant", a1.GameVersion, fixtureGameVersion)
	}
	if a1.Extracted {
		t.Error("fixture claims extracted:true, but it is community-sourced; the extraction spike has not run")
	}
}

// Governing: SPEC-0001 REQ "Dependency Graph Resolution" —
// Scenario "Resolving the Stasis Device tree".
func TestResolveStasisDeviceTree(t *testing.T) {
	g := resolveStasis(t, 1, nil)

	if got := len(g.Nodes); got != 34 {
		t.Errorf("node count = %d, want 34", got)
	}
	for _, branch := range []string{"qp", "cry", "iri"} {
		if _, ok := g.Node(branch); !ok {
			t.Errorf("branch root %q missing", branch)
		}
	}
	if g.GameVersion != fixtureGameVersion {
		t.Errorf("graph game version = %q, want %q", g.GameVersion, fixtureGameVersion)
	}
	// Terminals first, target last — the tab order the canvas handoff wants.
	if last := g.Nodes[len(g.Nodes)-1]; last.ItemID != "sd" {
		t.Errorf("last node = %q, want target sd", last.ItemID)
	}
	if first := g.Nodes[0]; !first.Terminal {
		t.Errorf("first node %q is not terminal", first.ItemID)
	}
}

// Governing: SPEC-0001 REQ "Quantity Propagation and Aggregation" —
// Scenarios "Shared inputs aggregate" and "Gas totals at quantity 1".
func TestStasisDeviceLeafTotals(t *testing.T) {
	g := resolveStasis(t, 1, nil)

	want := map[string]int64{
		"fc": 300, "sol": 200, "cf": 100, "sb": 200, "gr": 400, "fae": 50,
		"sul": 500, "cc": 300, "nit": 500, "rad": 500,
		"par": 50, "pho": 50, "dio": 50, "ion": 150,
	}
	for id, exp := range want {
		if got := totalOf(t, g, id); got != exp {
			t.Errorf("%s total = %d, want %d", id, got, exp)
		}
	}

	// The intermediates the aggregation actually turns on: each gas product
	// is needed twice, which is what makes Condensed Carbon 6 x 50 = 300.
	for _, id := range []string{"ec", "ns", "tc"} {
		if got := totalOf(t, g, id); got != 2 {
			t.Errorf("%s total = %d, want 2", id, got)
		}
	}
	if got := totalOf(t, g, "gla"); got != 5 {
		t.Errorf("gla total = %d, want 5", got)
	}
}

// Governing: SPEC-0001 REQ "Quantity Propagation and Aggregation" —
// Scenario "Linear scaling".
func TestLinearScaling(t *testing.T) {
	one := resolveStasis(t, 1, nil)
	ten := resolveStasis(t, 10, nil)

	for _, leaf := range one.Leaves() {
		got := totalOf(t, ten, leaf.ItemID)
		want := totalOf(t, one, leaf.ItemID) * 10
		if got != want {
			t.Errorf("%s at qty 10 = %d, want %d (10x its value at qty 1)", leaf.ItemID, got, want)
		}
	}
}

// Governing: SPEC-0001 REQ "Exact Arithmetic and Rounding Discipline" —
// Scenario "No intermediate rounding". Frost Crystal reaches its total
// through Glass, six graph levels below the target.
func TestNoIntermediateRounding(t *testing.T) {
	g := resolveStasis(t, 3, nil)

	// 3 devices -> 3 Living Glass -> 15 Glass -> 15 x 40 = 600 Frost Crystal
	// via the Glass branch, plus 3 x 100 via Heat Capacitor = 900.
	if got := totalOf(t, g, "fc"); got != 900 {
		t.Errorf("fc total = %d, want 900", got)
	}
	n, _ := g.Node("fc")
	if !n.Total().IsInt() {
		t.Errorf("fc total %s is not exact", n.Total().RatString())
	}
	// Every total in the graph must be an exact integer at this stage.
	for _, node := range g.Nodes {
		if _, exact := node.TotalInt(); !exact {
			t.Errorf("%s total %s is not an exact integer", node.ItemID, node.Total().RatString())
		}
	}
}

// Governing: SPEC-0001 REQ "Dependency Graph Resolution" —
// Scenario "Terminal nodes are not expanded".
func TestTerminalNodesAreNotExpanded(t *testing.T) {
	g := resolveStasis(t, 1, nil)
	for _, n := range g.Nodes {
		if n.Terminal && len(n.Children) > 0 {
			t.Errorf("terminal node %q has %d children", n.ItemID, len(n.Children))
		}
		if n.Terminal && n.Method != MethodRaw {
			t.Errorf("terminal node %q method = %q, want raw", n.ItemID, n.Method)
		}
	}

	// The scenario's real bite: Condensed Carbon is mineable *and* refinable
	// from Carbon. Resolved to raw it must not expand, even though the
	// artifact holds a recipe that could produce it.
	cc, ok := g.Node("cc")
	if !ok {
		t.Fatal("cc missing from graph")
	}
	if !cc.Terminal || len(cc.Children) != 0 {
		t.Errorf("cc terminal = %v with %d children, want terminal with none", cc.Terminal, len(cc.Children))
	}
	if _, hasRecipe := loadFixture(t).Recipe("cc", MethodRefine); !hasRecipe {
		t.Fatal("fixture no longer holds a cc refine recipe, so this scenario is not being exercised")
	}
	if got, want := cc.LegalMethods, []Method{MethodRaw, MethodRefine}; !equalMethods(got, want) {
		t.Errorf("cc legal methods = %v, want %v", got, want)
	}
	if _, reached := g.Node("car"); reached {
		t.Error("Carbon was expanded into the graph; cc resolved to raw must terminate there")
	}

	// Switching it off raw does expand it, which is what makes the
	// non-expansion above meaningful rather than incidental.
	expanded := resolveStasis(t, 1, map[string]Method{"cc": MethodRefine})
	if _, reached := expanded.Node("car"); !reached {
		t.Error("Carbon missing after switching cc to refine")
	}
	// 300 Condensed Carbon at 2 Carbon each.
	if got := totalOf(t, expanded, "car"); got != 600 {
		t.Errorf("car total = %d, want 600", got)
	}
}

// An item that is not raw-obtainable cannot be pinned to raw.
func TestRawRequiresRawObtainable(t *testing.T) {
	_, err := Resolve(loadFixture(t), PlanInput{
		Target: "sd", Quantity: 1,
		Methods: map[string]Method{"gla": MethodRaw},
	})
	if !errors.Is(err, ErrIllegalMethod) {
		t.Fatalf("error = %v, want ErrIllegalMethod", err)
	}
}

// Governing: SPEC-0001 REQ "Dependency Graph Resolution" —
// Scenario "Unknown target".
func TestUnknownTarget(t *testing.T) {
	_, err := Resolve(loadFixture(t), PlanInput{Target: "prod999", Quantity: 1})
	if !errors.Is(err, ErrUnknownItem) {
		t.Fatalf("error = %v, want ErrUnknownItem", err)
	}
	if !strings.Contains(err.Error(), "prod999") {
		t.Errorf("error %q does not identify the missing ID", err)
	}
}

// Governing: SPEC-0001 REQ "Method Resolution" —
// Scenario "Method change alters expansion".
func TestMethodChangeAltersExpansion(t *testing.T) {
	base := resolveStasis(t, 1, nil)
	refined := resolveStasis(t, 1, map[string]Method{"ec": MethodRefine})

	// Crafting Enriched Carbon takes 250 Sulphurine + 50 Condensed Carbon per
	// unit; refining takes 300 Sulphurine and drops the carbon entirely.
	if got, want := totalOf(t, base, "sul"), int64(500); got != want {
		t.Errorf("baseline sul = %d, want %d", got, want)
	}
	if got, want := totalOf(t, refined, "sul"), int64(600); got != want {
		t.Errorf("refined sul = %d, want %d", got, want)
	}
	// Condensed Carbon loses Enriched Carbon's 2 x 50 contribution.
	if got, want := totalOf(t, refined, "cc"), int64(200); got != want {
		t.Errorf("refined cc = %d, want %d", got, want)
	}

	ec, _ := refined.Node("ec")
	if len(ec.Children) != 1 || ec.Children[0].To != "sul" {
		t.Errorf("refined ec children = %+v, want a single sul edge", ec.Children)
	}
}

// Governing: SPEC-0001 REQ "Method Resolution" —
// Scenario "Illegal method rejected".
func TestIllegalMethodRejected(t *testing.T) {
	// Heat Capacitor has only a craft recipe and is not raw-obtainable.
	_, err := Resolve(loadFixture(t), PlanInput{
		Target: "sd", Quantity: 1,
		Methods: map[string]Method{"hc": MethodRefine},
	})
	if !errors.Is(err, ErrIllegalMethod) {
		t.Fatalf("error = %v, want ErrIllegalMethod", err)
	}
	if !strings.Contains(err.Error(), "Heat Capacitor") {
		t.Errorf("error %q does not name the node", err)
	}
}

// Governing: SPEC-0001 REQ "Method Resolution" —
// Scenario "No buy method exists".
func TestNoBuyMethod(t *testing.T) {
	if Method("buy").Valid() {
		t.Fatal(`Method("buy") reports valid; "buy" must not be part of the vocabulary`)
	}
	_, err := Resolve(loadFixture(t), PlanInput{
		Target: "sd", Quantity: 1,
		Methods: map[string]Method{"gla": Method("buy")},
	})
	if !errors.Is(err, ErrIllegalMethod) {
		t.Fatalf("error = %v, want ErrIllegalMethod", err)
	}
	if !strings.Contains(err.Error(), "vocabulary") {
		t.Errorf("error %q does not explain that the method is outside the vocabulary", err)
	}
}

// Governing: SPEC-0001 REQ "Method Resolution" — legal methods are reported so
// the view can render unavailable options as inert rather than hiding them.
func TestLegalMethodsReported(t *testing.T) {
	g := resolveStasis(t, 1, nil)

	gla, _ := g.Node("gla")
	if got, want := gla.LegalMethods, []Method{MethodCraft, MethodRefine}; !equalMethods(got, want) {
		t.Errorf("gla legal methods = %v, want %v", got, want)
	}
	hc, _ := g.Node("hc")
	if got, want := hc.LegalMethods, []Method{MethodCraft}; !equalMethods(got, want) {
		t.Errorf("hc legal methods = %v, want %v", got, want)
	}
	fc, _ := g.Node("fc")
	if got, want := fc.LegalMethods, []Method{MethodRaw}; !equalMethods(got, want) {
		t.Errorf("fc legal methods = %v, want %v", got, want)
	}
}

func equalMethods(a, b []Method) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Governing: SPEC-0001 REQ "Cycle Detection" —
// Scenario "Cyclic method selection".
func TestCycleDetection(t *testing.T) {
	// A deliberately cyclic artifact: refining A yields B and refining B
	// yields A, which is a shape the real refining data is capable of.
	const cyclic = `{
	  "schema_version": 1, "game_version": "test-cycle",
	  "items": [
	    {"id":"a","name":"Alpha","default_method":"refine"},
	    {"id":"b","name":"Beta","default_method":"refine"}
	  ],
	  "recipes": [
	    {"output":"a","method":"refine","inputs":[{"item":"b","quantity":1}]},
	    {"output":"b","method":"refine","inputs":[{"item":"a","quantity":1}]}
	  ]
	}`
	a1, err := LoadTier1(strings.NewReader(cyclic))
	if err != nil {
		t.Fatalf("loading cyclic artifact: %v", err)
	}
	g, err := Resolve(a1, PlanInput{Target: "a", Quantity: 1})
	if !errors.Is(err, ErrCycleDetected) {
		t.Fatalf("error = %v, want ErrCycleDetected", err)
	}
	if g != nil {
		t.Error("a graph was returned alongside a cycle error; must be nil")
	}
	for _, id := range []string{"a", "b"} {
		if !strings.Contains(err.Error(), id) {
			t.Errorf("error %q does not list participating node %q", err, id)
		}
	}
}

// Governing: SPEC-0001 REQ "Provenance Propagation" —
// Scenario "Unverified input taints derived total".
func TestProvenanceTaint(t *testing.T) {
	g := resolveStasis(t, 1, nil)

	// Glass and Hot Ice are the fixture's unverified nodes (refiner-variant
	// ratios differ between community sources). Taint flows the same
	// direction as quantity: down, from a node to everything derived below it.
	unverified := map[string]bool{
		"gla": true, "fc": true, // Glass taints Frost Crystal
		"hi": true, "ns": true, "ec": true, // Hot Ice taints its inputs
		"nit": true, "sul": true, "cc": true, // ...and theirs
	}
	for _, n := range g.Nodes {
		want := !unverified[n.ItemID]
		if n.Verified != want {
			t.Errorf("%s (%s) verified = %v, want %v", n.ItemID, n.Name, n.Verified, want)
		}
	}

	// Radon arrives only through Thermic Condensate, which is untainted.
	if rad, _ := g.Node("rad"); !rad.Verified {
		t.Error("rad should be verified: its only path avoids both unverified nodes")
	}
}

// Governing: SPEC-0001 REQ "Determinism" —
// Scenarios "Repeated computation is stable" and "Stable ordering".
func TestDeterminism(t *testing.T) {
	type wire struct {
		ID       string   `json:"id"`
		Method   Method   `json:"method"`
		Total    string   `json:"total"`
		Verified bool     `json:"verified"`
		Children []Edge   `json:"children"`
		Legal    []Method `json:"legal"`
	}
	serialize := func(g *ResolvedGraph) string {
		out := make([]wire, 0, len(g.Nodes))
		for _, n := range g.Nodes {
			out = append(out, wire{n.ItemID, n.Method, n.Total().RatString(), n.Verified, n.Children, n.LegalMethods})
		}
		b, err := json.Marshal(out)
		if err != nil {
			t.Fatalf("marshalling: %v", err)
		}
		return string(b)
	}

	first := serialize(resolveStasis(t, 4, nil))
	for i := 0; i < 25; i++ {
		if got := serialize(resolveStasis(t, 4, nil)); got != first {
			t.Fatalf("run %d differs from the first run; map iteration is leaking into output ordering", i+2)
		}
	}
}

// Governing: SPEC-0001 REQ "Error Handling Standards" —
// Scenarios "Errors carry the resolution path" and "No partial results on
// failure".
func TestErrorCarriesResolutionPath(t *testing.T) {
	// Break a node several levels down: Cryo-Pump gains an input that does
	// not exist. Structural validation catches it at load, so build the
	// artifact past validation and confirm the walk reports the path.
	a1 := loadFixture(t)
	a1.recipesByOut["cp"][MethodCraft] = Recipe{
		Output: "cp", Method: MethodCraft,
		Inputs: []Input{{Item: "prod999", Quantity: 1}},
	}

	g, err := Resolve(a1, PlanInput{Target: "sd", Quantity: 1})
	if err == nil {
		t.Fatal("expected an error")
	}
	if g != nil {
		t.Error("a graph was returned alongside an error; must be nil")
	}
	if !errors.Is(err, ErrUnknownItem) {
		t.Errorf("error = %v, want ErrUnknownItem", err)
	}
	for _, want := range []string{"resolving Stasis Device", "Cryogenic Chamber", "Cryo-Pump", "prod999"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q is missing %q from the resolution path", err, want)
		}
	}
}

// Governing: SPEC-0001 REQ "Error Handling Standards" — the sentinel set is
// distinguishable by callers.
func TestSentinelsAreDistinct(t *testing.T) {
	all := []error{ErrUnknownItem, ErrIllegalMethod, ErrCycleDetected, ErrMissingConstant, ErrInvalidArtifact}
	for i, a := range all {
		for j, b := range all {
			if i != j && errors.Is(a, b) {
				t.Errorf("sentinel %v matches %v; callers cannot distinguish them", a, b)
			}
		}
	}
}

func TestTier1ValidationRejectsMissingGameVersion(t *testing.T) {
	const noVersion = `{
	  "schema_version": 1,
	  "items": [{"id":"a","name":"Alpha","raw_obtainable":true,"default_method":"raw"}],
	  "recipes": []
	}`
	_, err := LoadTier1(strings.NewReader(noVersion))
	if !errors.Is(err, ErrInvalidArtifact) {
		t.Fatalf("error = %v, want ErrInvalidArtifact", err)
	}
	if !strings.Contains(err.Error(), "game_version") {
		t.Errorf("error %q does not name the missing field", err)
	}
}

func TestQuantityMustBePositive(t *testing.T) {
	for _, q := range []int64{0, -1} {
		if _, err := Resolve(loadFixture(t), PlanInput{Target: "sd", Quantity: q}); err == nil {
			t.Errorf("quantity %d was accepted", q)
		}
	}
}

// Exact rational arithmetic is available for the non-integer multipliers
// stages 2 and 3 introduce, and does not drift the way binary floats do.
//
// Governing: SPEC-0001 REQ "Exact Arithmetic and Rounding Discipline".
func TestRationalArithmeticIsExact(t *testing.T) {
	// The float trap the design calls out: 0.1 summed ten times is not 1.
	var f float64
	for i := 0; i < 10; i++ {
		f += 0.1
	}
	if f == 1.0 {
		t.Skip("float arithmetic is exact on this platform; the rational check below is moot")
	}

	r := new(big.Rat)
	tenth := big.NewRat(1, 10)
	for i := 0; i < 10; i++ {
		r.Add(r, tenth)
	}
	if r.Cmp(big.NewRat(1, 1)) != 0 {
		t.Errorf("rational sum = %s, want 1", r.RatString())
	}
}
