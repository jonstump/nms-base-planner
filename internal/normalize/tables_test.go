package normalize_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jonstump/nms-base-planner/internal/domain"
	"github.com/jonstump/nms-base-planner/internal/normalize"
)

// The fixtures under testdata/graph are whole rows lifted out of a real
// 6.45.0.1 decompilation — see testdata/graph/gen.go for which rows and why.
// Each seed is there for a property that has to be exercised against real
// data rather than an invented approximation of it: the Stasis Device's
// craft closure, Sodium Nitrate's many refine routes, a cooked product, and
// the one product in the game that crafts twenty-five at a time.
const graphRoot = "testdata/graph"

func graphSources(root string) normalize.Sources {
	return normalize.Sources{
		Products:     filepath.Join(root, "products.MXML"),
		Substances:   filepath.Join(root, "substances.MXML"),
		Recipes:      filepath.Join(root, "recipes.MXML"),
		Localisation: []string{filepath.Join(root, "localisation.MXML")},
	}
}

func buildGraph(t *testing.T) *normalize.Graph {
	t.Helper()
	g, err := normalize.BuildGraph(graphSources(graphRoot))
	if err != nil {
		t.Fatalf("BuildGraph: %v", err)
	}
	return g
}

// graphArtifact assembles the graph into a validated artifact, which is what
// a consumer actually loads.
func graphArtifact(t *testing.T) *domain.Tier1 {
	t.Helper()
	g := buildGraph(t)
	b, err := normalize.NewBuilder("5.97", "6.45.0.1", []string{"NMSARC.Precache.pak"})
	if err != nil {
		t.Fatal(err)
	}
	b.AddItems(g.Items...)
	b.AddRecipes(g.Recipes...)
	b.SetSelfReferentialOmitted(g.SelfReferentialOmitted)
	a1, err := b.Artifact()
	if err != nil {
		t.Fatalf("Artifact: %v", err)
	}
	return a1
}

func itemsByID(g *normalize.Graph) map[string]domain.Item {
	out := make(map[string]domain.Item, len(g.Items))
	for _, it := range g.Items {
		out[it.ID] = it
	}
	return out
}

// SPEC-0004 REQ "Recipe Graph Construction":
// WHEN an artifact is generated
// THEN every recipe input and output resolves to an item in the same artifact.
func TestGraphIsClosed(t *testing.T) {
	g := buildGraph(t)
	known := itemsByID(g)

	if len(g.Items) == 0 || len(g.Recipes) == 0 {
		t.Fatalf("graph is empty: %d items, %d recipes", len(g.Items), len(g.Recipes))
	}
	for _, r := range g.Recipes {
		if _, ok := known[r.Output]; !ok {
			t.Errorf("recipe %q produces %q, which is not an item", r.ID, r.Output)
		}
		for _, in := range r.Inputs {
			if _, ok := known[in.Item]; !ok {
				t.Errorf("recipe %q consumes %q, which is not an item", r.ID, in.Item)
			}
			if in.Quantity <= 0 {
				t.Errorf("recipe %q consumes %d of %q", r.ID, in.Quantity, in.Item)
			}
		}
	}
}

// The graph must survive the artifact's own validation, and the artifact
// must carry the omission count in its provenance.
//
// Governing: SPEC-0004 REQ "Recipe Graph Construction" — "MUST record how
// many it omitted in the artifact's provenance."
func TestGraphAssemblesIntoAValidArtifact(t *testing.T) {
	g := buildGraph(t)
	a1 := graphArtifact(t)

	if a1.Provenance == nil {
		t.Fatal("no provenance recorded")
	}
	if got, want := a1.Provenance.SelfReferentialRecipesOmitted, g.SelfReferentialOmitted; got != want {
		t.Errorf("provenance records %d omitted self-referential recipes, want %d", got, want)
	}
	if g.SelfReferentialOmitted == 0 {
		t.Fatal("the fixture omitted none, so this scenario is not being exercised")
	}

	// And the number survives a round trip, which is the point of recording
	// it: a change between regenerations shows up as a diff.
	blob, err := normalize.Encode(a1)
	if err != nil {
		t.Fatal(err)
	}
	back, err := domain.LoadTier1(strings.NewReader(string(blob)))
	if err != nil {
		t.Fatalf("reloading: %v", err)
	}
	if back.Provenance.SelfReferentialRecipesOmitted != g.SelfReferentialOmitted {
		t.Errorf("count did not survive a round trip: %d", back.Provenance.SelfReferentialRecipesOmitted)
	}
}

// SPEC-0004 REQ "Identifier Policy":
// WHEN the Stasis Device is emitted
// THEN its item ID is ULTRAPROD2, exactly as the product table spells it.
func TestIdentifiersAreGameIDsVerbatim(t *testing.T) {
	g := buildGraph(t)
	byID := itemsByID(g)

	if _, ok := byID["ULTRAPROD2"]; !ok {
		t.Fatal("ULTRAPROD2 missing from the graph")
	}
	// The engine fixture's short codes (fc, sb, sd) illustrate shape, not
	// identifier policy. None of them may appear here.
	for _, short := range []string{"sd", "fc", "sb", "cc", "gla"} {
		if _, ok := byID[short]; ok {
			t.Errorf("short code %q leaked into the generated graph", short)
		}
	}
	for _, it := range g.Items {
		if it.ID != strings.ToUpper(it.ID) && it.ID != strings.ToLower(it.ID) {
			continue // mixed case is the game's own business
		}
		if lower := strings.ToLower(it.ID); it.ID == lower && lower != strings.ToUpper(it.ID) {
			t.Errorf("item %q looks case-folded; game IDs are not rewritten", it.ID)
		}
	}
}

// SPEC-0004 REQ "Display Name Resolution":
// WHEN ULTRAPROD2 is emitted
// THEN its name is "Stasis Device", resolved through UI_ULTRAPROD_2_NAME_L.
func TestNamesComeFromTheLocalisationTables(t *testing.T) {
	g := buildGraph(t)
	byID := itemsByID(g)

	cases := map[string]string{
		"ULTRAPROD2": "Stasis Device",
		"CATALYST2":  "Sodium Nitrate",
		"VENTGEM":    "Crystal Sulphide",
	}
	for id, want := range cases {
		it, ok := byID[id]
		if !ok {
			t.Errorf("%s missing", id)
			continue
		}
		if it.Name != want {
			t.Errorf("%s name = %q, want %q", id, it.Name, want)
		}
	}

	// No name may be a localisation key or an item ID wearing a name's
	// clothes — the failure mode SPEC-0004 forbids falling back to.
	for _, it := range g.Items {
		if it.Name == "" {
			t.Errorf("item %q has an empty name", it.ID)
		}
		if strings.HasPrefix(it.Name, "UI_") || strings.HasSuffix(it.Name, "_NAME_L") {
			t.Errorf("item %q name %q is a localisation key, not a resolved string", it.ID, it.Name)
		}
		if it.Name == it.ID {
			t.Errorf("item %q name fell back to its ID", it.ID)
		}
	}

	// The tables consulted are recorded, so a name that fails to resolve can
	// say where we looked.
	// Governing: SPEC-0004 REQ "Search Boundaries Are Recorded".
	if len(g.LocalisationFiles) == 0 {
		t.Error("no localisation files recorded")
	}
}

// SPEC-0004 REQ "Display Name Resolution":
// WHEN an item's name key is absent from the localisation tables
// THEN generation fails naming the key and the item, and no artifact is
// written.
func TestUnresolvedNameFailsRatherThanLeaking(t *testing.T) {
	root := copyGraphTree(t)
	p := filepath.Join(root, "localisation.MXML")
	blob, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	const key = "UI_ULTRAPROD_2_NAME_L"
	if !strings.Contains(string(blob), key) {
		t.Fatalf("the fixture no longer defines %s, so this case proves nothing", key)
	}
	edited := strings.ReplaceAll(string(blob), key, "UI_SOMETHING_ELSE_NAME_L")
	if err := os.WriteFile(p, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}

	g, err := normalize.BuildGraph(graphSources(root))
	if !errors.Is(err, normalize.ErrLocalisationUnresolved) {
		t.Fatalf("error = %v, want ErrLocalisationUnresolved", err)
	}
	if g != nil {
		t.Error("a graph was returned alongside an error; must be nil")
	}
	for _, want := range []string{key, "ULTRAPROD2"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not name %q", err, want)
		}
	}
}

// The allowlist omits products no English table names. That is only
// defensible while nothing references them, which is asserted rather than
// assumed.
//
// Governing: SPEC-0004 REQ "Display Name Resolution"
func TestKnownUnnamedItemsAreOmittedAndUnreferenced(t *testing.T) {
	g := buildGraph(t)
	byID := itemsByID(g)

	for _, id := range []string{"CHART_BUILDER", "WORLDSMB_SOUL"} {
		if _, ok := byID[id]; ok {
			t.Errorf("%s was emitted; no English table defines its name", id)
		}
	}
	if len(g.UnnamedOmitted) != 2 {
		t.Errorf("omitted %v, want the two the fixture carries", g.UnnamedOmitted)
	}
	// Sorted, so the artifact's record of them is stable across runs.
	for i := 1; i < len(g.UnnamedOmitted); i++ {
		if g.UnnamedOmitted[i-1] >= g.UnnamedOmitted[i] {
			t.Errorf("omitted list is not sorted: %v", g.UnnamedOmitted)
		}
	}
	if normalize.KnownUnnamedCount() != 18 {
		t.Errorf("allowlist holds %d entries, want the 18 verified against NMS 5.97",
			normalize.KnownUnnamedCount())
	}

	// Nothing in the graph names one of them.
	omitted := map[string]bool{}
	for _, id := range g.UnnamedOmitted {
		omitted[id] = true
	}
	for _, r := range g.Recipes {
		if omitted[r.Output] {
			t.Errorf("recipe %q produces omitted item %q", r.ID, r.Output)
		}
		for _, in := range r.Inputs {
			if omitted[in.Item] {
				t.Errorf("recipe %q consumes omitted item %q", r.ID, in.Item)
			}
		}
	}
}

// SPEC-0004 REQ "Recipe Graph Construction":
// WHEN the source defines 26 refine recipes producing CATALYST2
// THEN the artifact carries all of them, and the normalizer selects none.
//
// Seven of the 26 are self-referential and excluded by the requirement
// below, so 19 reach the artifact. The point of the scenario is that the
// normalizer discards nothing on its own account.
func TestEveryAlternativeIsEmitted(t *testing.T) {
	a1 := graphArtifact(t)

	got := a1.RecipesFor("CATALYST2", domain.MethodRefine)
	if len(got) != 19 {
		t.Fatalf("CATALYST2 refine recipes = %d, want 19 (26 defined, 7 self-referential)", len(got))
	}
	// The source really does define 26, so the 19 above is an exclusion
	// rather than an incomplete read.
	if defined := countRecipesFor(t, "CATALYST2"); defined != 26 {
		t.Fatalf("the fixture defines %d CATALYST2 recipes, want 26", defined)
	}

	// Ids are distinct, because a plan records one to name a route.
	seen := map[string]bool{}
	for _, r := range got {
		if r.ID == "" {
			t.Error("a recipe reached the artifact with no id")
		}
		if seen[r.ID] {
			t.Errorf("duplicate recipe id %q", r.ID)
		}
		seen[r.ID] = true
	}
	// And the engine's view agrees: every one is a legal option.
	if legal := a1.LegalRecipes("CATALYST2", domain.MethodRefine); len(legal) != len(got) {
		t.Errorf("legal recipes = %d, want %d", len(legal), len(got))
	}
}

// countRecipesFor counts the recipes the fixture defines for an output,
// before any exclusion, by reading the source rather than the artifact.
func countRecipesFor(t *testing.T, output string) int {
	t.Helper()
	blob, err := os.ReadFile(filepath.Join(graphRoot, "recipes.MXML"))
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, row := range strings.Split(string(blob), `<Property name="Table" value="GcRefinerRecipe"`)[1:] {
		result, _, ok := strings.Cut(row, `<Property name="Ingredients">`)
		if !ok {
			continue
		}
		if strings.Contains(result, `<Property name="Id" value="`+output+`" />`) {
			n++
		}
	}
	return n
}

// SPEC-0004 REQ "Recipe Graph Construction":
// WHEN a recipe producing 50 units from one input is read
// THEN its yield is 50 in the artifact, not 1.
func TestYieldsAreReadNotDefaulted(t *testing.T) {
	a1 := graphArtifact(t)

	// ADR-0005's worked example: 1x Crystal Sulphide -> 50x Sodium Nitrate.
	r, ok := a1.Recipe("CATALYST2", domain.MethodRefine, "REFINERECIPE_5")
	if !ok {
		t.Fatal("REFINERECIPE_5 missing")
	}
	if r.Yield != 50 {
		t.Errorf("yield = %d, want 50", r.Yield)
	}
	if len(r.Inputs) != 1 || r.Inputs[0].Item != "VENTGEM" || r.Inputs[0].Quantity != 1 {
		t.Errorf("inputs = %+v, want one VENTGEM", r.Inputs)
	}

	// Crafting has yields too, read from DefaultCraftAmount rather than
	// assumed: AMMO is the single product in the table that makes 25.
	ammo, ok := a1.Recipe("AMMO", domain.MethodCraft, "AMMO")
	if !ok {
		t.Fatal("AMMO craft recipe missing")
	}
	if ammo.Yield != 25 {
		t.Errorf("AMMO yield = %d, want 25", ammo.Yield)
	}

	// Every recipe states a yield; none was left at the zero value.
	for _, rec := range a1.Recipes {
		if rec.Yield <= 0 {
			t.Errorf("recipe %q yield = %d; yields are read, never defaulted", rec.ID, rec.Yield)
		}
	}
}

// SPEC-0004 REQ "Recipe Graph Construction":
// WHEN a recipe's output quantity cannot be read from the source
// THEN generation fails naming the recipe, rather than assuming a yield of
// one.
func TestAbsentYieldFailsRatherThanDefaults(t *testing.T) {
	root := copyGraphTree(t)
	p := filepath.Join(root, "recipes.MXML")
	blob, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	// REFINERECIPE_5's Result block, with its Amount removed.
	const marker = `<Property name="Table" value="GcRefinerRecipe" _id="REFINERECIPE_5">`
	i := strings.Index(string(blob), marker)
	if i < 0 {
		t.Fatal("REFINERECIPE_5 is not in the fixture, so this case proves nothing")
	}
	head, tail := string(blob)[:i], string(blob)[i:]
	amount := `<Property name="Amount" value="50" />`
	if !strings.Contains(tail, amount) {
		t.Fatal("REFINERECIPE_5 no longer states Amount 50")
	}
	edited := head + strings.Replace(tail, amount, "", 1)
	if err := os.WriteFile(p, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}

	g, err := normalize.BuildGraph(graphSources(root))
	if !errors.Is(err, normalize.ErrStructureUnrecognized) {
		t.Fatalf("error = %v, want ErrStructureUnrecognized", err)
	}
	if g != nil {
		t.Error("a graph was returned alongside an error")
	}
	if !strings.Contains(err.Error(), "REFINERECIPE_5") {
		t.Errorf("error %q does not name the recipe", err)
	}
}

// SPEC-0004 REQ "Recipe Graph Construction":
// WHEN a refiner recipe carries Cooking true
// THEN its method is cook, and a recipe carrying Cooking false is refine.
func TestCookingFlagDistinguishesMethod(t *testing.T) {
	a1 := graphArtifact(t)

	// RECIPE_2 is the fixture's cooked recipe; REFINERECIPE_5 is refined.
	if _, ok := a1.Recipe("FOOD_P_STELLAR", domain.MethodCook, "RECIPE_2"); !ok {
		t.Error("RECIPE_2 did not resolve to method cook")
	}
	if _, ok := a1.Recipe("FOOD_P_STELLAR", domain.MethodRefine, "RECIPE_2"); ok {
		t.Error("RECIPE_2 also appears as refine")
	}
	if _, ok := a1.Recipe("CATALYST2", domain.MethodRefine, "REFINERECIPE_5"); !ok {
		t.Error("REFINERECIPE_5 did not resolve to method refine")
	}

	// Both values of the flag are present, so neither branch passes because
	// the other never occurs.
	var cook, refine int
	for _, r := range a1.Recipes {
		switch r.Method {
		case domain.MethodCook:
			cook++
		case domain.MethodRefine:
			refine++
		}
	}
	if cook == 0 || refine == 0 {
		t.Errorf("cook = %d, refine = %d; the fixture must exercise both", cook, refine)
	}
}

// SPEC-0004 REQ "Recipe Graph Construction":
// WHEN a recipe names its own output among its ingredients
// THEN it is omitted from the artifact, and the provenance records the
// omitted count.
func TestSelfReferentialRecipesAreExcludedAndCounted(t *testing.T) {
	g := buildGraph(t)

	if g.SelfReferentialOmitted != 17 {
		t.Errorf("omitted %d self-referential recipes, want the 17 the fixture defines",
			g.SelfReferentialOmitted)
	}
	for _, r := range g.Recipes {
		for _, in := range r.Inputs {
			if in.Item == r.Output {
				t.Errorf("recipe %q names its own output %q among its ingredients", r.ID, r.Output)
			}
		}
	}
	// The items involved survive by their other routes; exclusion trims a
	// doubling strategy, it does not remove an item from the graph.
	if _, ok := itemsByID(g)["CATALYST2"]; !ok {
		t.Error("CATALYST2 disappeared with its self-referential recipes")
	}
}

// SPEC-0004 REQ "Recipe Graph Construction":
// Items with no recipe are emitted raw-obtainable with default method raw.
func TestItemsWithoutRecipesAreRawTerminals(t *testing.T) {
	g := buildGraph(t)

	produced := map[string]bool{}
	for _, r := range g.Recipes {
		produced[r.Output] = true
	}
	var raws int
	for _, it := range g.Items {
		if produced[it.ID] {
			if it.DefaultMethod == domain.MethodRaw && !it.RawObtainable {
				t.Errorf("item %q defaults to raw but is not raw-obtainable", it.ID)
			}
			continue
		}
		raws++
		if it.DefaultMethod != domain.MethodRaw {
			t.Errorf("item %q has no recipe but defaults to %q", it.ID, it.DefaultMethod)
		}
		if !it.RawObtainable {
			t.Errorf("item %q has no recipe but is not raw-obtainable", it.ID)
		}
	}
	if raws == 0 {
		t.Error("the fixture has no recipe-less items, so terminals are not exercised")
	}
}

// SPEC-0004 REQ "Recipe Graph Construction":
// WHEN a source table implies a method outside craft, refine, raw, cook
// THEN generation fails naming the method found, rather than emitting it.
func TestMethodVocabularyIsClosed(t *testing.T) {
	g := buildGraph(t)

	for _, r := range g.Recipes {
		switch r.Method {
		case domain.MethodCraft, domain.MethodRefine, domain.MethodCook:
		case domain.MethodRaw:
			t.Errorf("recipe %q declares method raw, which is terminal by definition", r.ID)
		default:
			t.Errorf("recipe %q declares method %q, outside the vocabulary", r.ID, r.Method)
		}
	}
	// "buy" is deliberately absent from the vocabulary: this is a build
	// planner, not a shopping list.
	blob, err := normalize.Encode(graphArtifact(t))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(blob), `"buy"`) {
		t.Error("a buy method reached the artifact")
	}
}

// SPEC-0004 REQ "Excluded Content":
// WHEN an item whose source record carries Description, Subtitle and Hint is
// emitted THEN none of those fields appear anywhere in the artifact; and no
// asset path appears either.
func TestDescriptiveTextAndAssetPathsAreExcluded(t *testing.T) {
	blob, err := normalize.Encode(graphArtifact(t))
	if err != nil {
		t.Fatal(err)
	}
	out := string(blob)

	for _, banned := range []string{
		"_DESC", "_SUB", "Subtitle", "Description", "Hint",
		".DDS", ".MBIN", ".SCENE", "TEXTURES/", "MODELS/",
	} {
		if strings.Contains(out, banned) {
			t.Errorf("artifact contains %q; only structure and quantities are taken", banned)
		}
	}

	// The source really does carry them, so exclusion is a property of the
	// normalizer rather than of the fixture.
	src, err := os.ReadFile(filepath.Join(graphRoot, "products.MXML"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Description", "Subtitle", "Hint", ".DDS", "MODELS/"} {
		if !strings.Contains(string(src), want) {
			t.Errorf("the source fixture no longer carries %q, so exclusion is not being exercised", want)
		}
	}
}

// The acceptance case: the generated graph reproduces the shape of the
// engine's hand-authored Stasis Device fixture for the nodes it covers.
//
// Compared as the craft closure rather than as a resolved tree, because the
// hand fixture pins several nodes to raw that the real data reaches by
// refining — a difference in default methods, not in structure.
func TestStasisDeviceCraftClosureMatchesTheEngineFixture(t *testing.T) {
	a1 := graphArtifact(t)

	seen := map[string]bool{}
	var walk func(string)
	walk = func(id string) {
		if seen[id] {
			return
		}
		seen[id] = true
		for _, r := range a1.RecipesFor(id, domain.MethodCraft) {
			for _, in := range r.Inputs {
				walk(in.Item)
			}
		}
	}
	walk("ULTRAPROD2")

	if len(seen) != 34 {
		t.Errorf("craft closure of ULTRAPROD2 = %d items, want the 34 the engine fixture carries", len(seen))
	}

	// And the top of the tree matches: three components, one of each.
	top := a1.RecipesFor("ULTRAPROD2", domain.MethodCraft)
	if len(top) != 1 {
		t.Fatalf("ULTRAPROD2 craft recipes = %d, want 1", len(top))
	}
	if len(top[0].Inputs) != 3 {
		t.Errorf("Stasis Device inputs = %d, want 3", len(top[0].Inputs))
	}
	for _, in := range top[0].Inputs {
		if in.Quantity != 1 {
			t.Errorf("Stasis Device consumes %d of %q, want 1", in.Quantity, in.Item)
		}
	}
}

// SPEC-0004 REQ "Structural Surprise Fails Loudly" — pointing the parser at
// the wrong file is a named error, not an empty table.
func TestWrongTemplateIsRefused(t *testing.T) {
	src := graphSources(graphRoot)
	src.Products = filepath.Join(graphRoot, "substances.MXML")

	g, err := normalize.BuildGraph(src)
	if !errors.Is(err, normalize.ErrStructureUnrecognized) {
		t.Fatalf("error = %v, want ErrStructureUnrecognized", err)
	}
	if g != nil {
		t.Error("a graph was returned alongside an error")
	}
	if !strings.Contains(err.Error(), "cGcProductTable") {
		t.Errorf("error %q does not name the template it wanted", err)
	}
}

// A missing source names the file rather than failing on a nil.
func TestMissingSourceIsNamed(t *testing.T) {
	src := graphSources(graphRoot)
	src.Recipes = filepath.Join(graphRoot, "not_a_table.MXML")

	g, err := normalize.BuildGraph(src)
	if !errors.Is(err, normalize.ErrSourceMissing) {
		t.Fatalf("error = %v, want ErrSourceMissing", err)
	}
	if g != nil {
		t.Error("a graph was returned alongside an error")
	}
	if !strings.Contains(err.Error(), "not_a_table.MXML") {
		t.Errorf("error %q does not name the missing file", err)
	}
}

// A product declaring an alternative craft route would need a second recipe
// id, which the id scheme does not provide. The game does not do this today
// and the normalizer refuses to guess if it starts.
func TestAlternativeCraftRouteIsRefused(t *testing.T) {
	root := copyGraphTree(t)
	p := filepath.Join(root, "products.MXML")
	blob, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	const empty = `<Property name="AltRequirements" />`
	if !strings.Contains(string(blob), empty) {
		t.Fatal("the fixture no longer carries an empty AltRequirements")
	}
	populated := `<Property name="AltRequirements">
				<Property name="AltRequirements" value="GcTechnologyRequirement" _id="VENTGEM">
					<Property name="ID" value="VENTGEM" />
					<Property name="Amount" value="1" />
				</Property>
			</Property>`
	edited := strings.Replace(string(blob), empty, populated, 1)
	if err := os.WriteFile(p, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}

	g, err := normalize.BuildGraph(graphSources(root))
	if !errors.Is(err, normalize.ErrStructureUnrecognized) {
		t.Fatalf("error = %v, want ErrStructureUnrecognized", err)
	}
	if g != nil {
		t.Error("a graph was returned alongside an error")
	}
	if !strings.Contains(err.Error(), "AltRequirements") {
		t.Errorf("error %q does not name the field", err)
	}
}

// copyGraphTree copies the graph fixtures into a temp dir so a case can
// break one.
func copyGraphTree(t *testing.T) string {
	t.Helper()
	dst := t.TempDir()
	entries, err := filepath.Glob(filepath.Join(graphRoot, "*.MXML"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatalf("no fixtures under %s", graphRoot)
	}
	for _, p := range entries {
		blob, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, filepath.Base(p)), blob, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dst
}
