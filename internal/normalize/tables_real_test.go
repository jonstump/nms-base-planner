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

// A pass over a whole decompiled install, opt-in via NMS_SOURCE_DIR.
//
// The fixtures under testdata/graph are real rows, but they are a slice —
// 69 items out of 2,255 — chosen by someone who already knew what the parser
// expects. A slice cannot show that the *rest* of the table holds no shape
// this code has never seen. That is precisely the failure this project has
// recorded three times: a bounded search reported as a general result.
//
// The counts asserted below are the ones SPEC-0004 and ADR-0005 quote. If a
// game update moves them, this test says so and the documents are wrong
// rather than the code being quietly wrong.
//
// Point NMS_SOURCE_DIR at a directory holding metadata/reality/tables/ and
// language/, decompiled with MBINCompiler:
//
//	NMS_SOURCE_DIR=/path/to/decompiled go test ./internal/normalize/ -run RealInstall -v
func TestRealInstallGraphMatchesTheRecordedCounts(t *testing.T) {
	root := os.Getenv("NMS_SOURCE_DIR")
	if root == "" {
		t.Skip("NMS_SOURCE_DIR is not set; skipping the pass over a real decompiled install")
	}

	tables := filepath.Join(root, "metadata/reality/tables")
	loc, err := filepath.Glob(filepath.Join(root, "language", "nms_*_english.MXML"))
	if err != nil {
		t.Fatal(err)
	}
	if len(loc) == 0 {
		t.Fatalf("no English localisation tables under %s/language", root)
	}

	g, err := normalize.BuildGraph(normalize.Sources{
		Products:     filepath.Join(tables, "nms_reality_gcproducttable.MXML"),
		Substances:   filepath.Join(tables, "nms_reality_gcsubstancetable.MXML"),
		Recipes:      filepath.Join(tables, "nms_reality_gcrecipetable.MXML"),
		Localisation: loc,
	})
	if err != nil {
		t.Fatalf("BuildGraph over the real tables: %v", err)
	}

	// 2,144 products less the 18 the allowlist omits, plus 111 substances.
	if got, want := len(g.Items), 2237; got != want {
		t.Errorf("items = %d, want %d", got, want)
	}
	if got, want := len(g.UnnamedOmitted), 18; got != want {
		t.Errorf("unnamed items omitted = %d, want %d", got, want)
	}
	// SPEC-0004: "There are 27."
	if got, want := g.SelfReferentialOmitted, 27; got != want {
		t.Errorf("self-referential recipes omitted = %d, want %d", got, want)
	}

	var craft, refine, cook int
	var maxYield int64
	pairs := map[string]int{}
	for _, r := range g.Recipes {
		switch r.Method {
		case domain.MethodCraft:
			craft++
		case domain.MethodRefine:
			refine++
			pairs[r.Output+"/refine"]++
		case domain.MethodCook:
			cook++
			pairs[r.Output+"/cook"]++
		default:
			t.Fatalf("recipe %q declares method %q", r.ID, r.Method)
		}
		if r.Yield > maxYield {
			maxYield = r.Yield
		}
	}
	// 1,681 refiner recipes less the 27 excluded.
	if got, want := refine+cook, 1654; got != want {
		t.Errorf("refiner recipes = %d, want %d", got, want)
	}
	if craft == 0 {
		t.Error("no craft recipes were built from the product table")
	}
	// ADR-0005: yields run up to 250.
	if got, want := maxYield, int64(250); got != want {
		t.Errorf("largest yield = %d, want %d", got, want)
	}
	var multi int
	for _, n := range pairs {
		if n > 1 {
			multi++
		}
	}
	if multi == 0 {
		t.Error("no output/method pair has more than one recipe; ADR-0005 says 261 do")
	}

	// The whole graph must assemble and validate, which is the real bar: a
	// duplicate recipe id or a dangling edge anywhere in 2,000+ recipes
	// fails here and nowhere in the fixture.
	b, err := normalize.NewBuilder("real-install", "6.45.0.1", []string{"NMSARC.Precache.pak"})
	if err != nil {
		t.Fatal(err)
	}
	b.AddItems(g.Items...)
	b.AddRecipes(g.Recipes...)
	b.SetSelfReferentialOmitted(g.SelfReferentialOmitted)
	a1, err := b.Artifact()
	if err != nil {
		t.Fatalf("assembling the whole graph: %v", err)
	}

	if got := len(a1.RecipesFor("CATALYST2", domain.MethodRefine)); got != 19 {
		t.Errorf("CATALYST2 refine recipes = %d, want 19 (26 defined, 7 self-referential)", got)
	}
	it, ok := a1.Item("ULTRAPROD2")
	if !ok {
		t.Fatal("ULTRAPROD2 missing from the real graph")
	}
	if it.Name != "Stasis Device" {
		t.Errorf("ULTRAPROD2 name = %q, want %q", it.Name, "Stasis Device")
	}

	// The whole point of reading gatherability from the source: under pure
	// defaults, every item resolves.
	//
	// Governing: SPEC-0004 REQ "Recipe Graph Construction" — Scenario "The
	// generated graph resolves". Before PinObjective was read, 571 of these
	// hit a refine cycle between gatherable substances.
	var cycles []string
	for _, it := range g.Items {
		_, err := domain.Resolve(a1, domain.PlanInput{Target: it.ID, Quantity: 1})
		if err == nil {
			continue
		}
		if errors.Is(err, domain.ErrCycleDetected) {
			cycles = append(cycles, it.ID)
			continue
		}
		t.Errorf("resolving %s: %v", it.ID, err)
	}
	if len(cycles) != 0 {
		limit := len(cycles)
		if limit > 10 {
			limit = 10
		}
		t.Errorf("%d of %d items hit a cycle under default methods: %v",
			len(cycles), len(g.Items), cycles[:limit])
	}

	// Six substances read UI_REFINE_OBJ. Five of them are emitted non-raw;
	// WATERPLANT (Cyto-Phosphate) is marked refined-only by the source while
	// no refiner recipe produces it, so it is emitted raw by necessity and
	// recorded as a contradiction rather than silently overridden.
	refineOnly := map[string]bool{
		"CAVE2": true, "WATER2": true,
		"LAND3": true, "LAUNCHSUB2": true, "STELLAR2": true,
	}
	if got, want := g.RawByNecessity, []string{"WATERPLANT"}; len(got) != len(want) || (len(got) > 0 && got[0] != want[0]) {
		t.Errorf("raw by necessity = %v, want %v", got, want)
	}
	substances := substanceIDs(t, filepath.Join(tables, "nms_reality_gcsubstancetable.MXML"))
	if len(substances) != 111 {
		t.Errorf("substance table holds %d rows, want 111", len(substances))
	}
	var nonRaw []string
	for _, it := range g.Items {
		if !substances[it.ID] {
			continue
		}
		if it.RawObtainable {
			if it.DefaultMethod != domain.MethodRaw {
				t.Errorf("%s is raw-obtainable but defaults to %q", it.ID, it.DefaultMethod)
			}
			continue
		}
		nonRaw = append(nonRaw, it.ID)
		if !refineOnly[it.ID] {
			t.Errorf("%s is not raw-obtainable and is not one of the six refine-only substances", it.ID)
		}
	}
	if len(nonRaw) != len(refineOnly) {
		t.Errorf("non-raw substances = %v, want the six refine-only ones", nonRaw)
	}
}

// substanceIDs reads the substance table's row ids, so the assertions above
// can tell a substance from a product without the graph carrying the
// distinction into the artifact, where nothing needs it.
func substanceIDs(t *testing.T, path string) map[string]bool {
	t.Helper()
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	const marker = `<Property name="Table" value="GcRealitySubstanceData" _id="`
	out := map[string]bool{}
	for _, row := range strings.Split(string(blob), marker)[1:] {
		id, _, ok := strings.Cut(row, `"`)
		if !ok {
			t.Fatalf("malformed row marker in %s", path)
		}
		out[id] = true
	}
	return out
}
