package normalize_test

import (
	"errors"
	"os"
	"path/filepath"
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

	// A recorded finding, not desired behaviour.
	//
	// SPEC-0004 derives raw-obtainability from the absence of a recipe, so
	// a substance you gather with a mining beam *and* can refine — Cobalt,
	// Sodium, the gases — comes out defaulting to refine. Refining runs
	// both ways between several of those pairs, so resolving under pure
	// defaults hits a cycle: 571 of the 2,237 items do, all of them
	// refine loops between gatherable substances.
	//
	// The engine is right to refuse; SPEC-0001 REQ "Cycle Detection" calls
	// this a runtime condition rather than one to assume away. What is
	// missing is a source of truth for gatherability, and the substance
	// table has one — PinObjective, which reads UI_REFINE_OBJ for the six
	// substances that are refined only and some flavour of gather, find or
	// process for the rest. Marking raw-obtainability from it resolves all
	// 2,237 with no cycles.
	//
	// That is a modelling decision SPEC-0004 does not make, so it is
	// recorded here rather than invented in the normalizer. When the spec
	// is amended, this assertion changes with it.
	_, err = domain.Resolve(a1, domain.PlanInput{Target: "ULTRAPROD2", Quantity: 1})
	if !errors.Is(err, domain.ErrCycleDetected) {
		t.Fatalf("resolving the Stasis Device: error = %v, want ErrCycleDetected until "+
			"raw-obtainability is read from the source", err)
	}

	// The cycle is between refinable substances, not anywhere in the craft
	// tree: every craft input still resolves to an item, which is what this
	// story is responsible for.
	if got := len(a1.RecipesFor("ULTRAPROD2", domain.MethodCraft)); got != 1 {
		t.Errorf("ULTRAPROD2 craft recipes = %d, want 1", got)
	}
}
