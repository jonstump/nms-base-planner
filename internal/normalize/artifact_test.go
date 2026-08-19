package normalize_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jonstump/nms-base-planner/internal/domain"
	"github.com/jonstump/nms-base-planner/internal/normalize"
)

// Governing: SPEC-0004 REQ "Source Provenance and Version Stamping", REQ
// "Deterministic Output", REQ "Structural Surprise Fails Loudly", REQ "Error
// Handling Standards".

func builder(t *testing.T) *normalize.Builder {
	t.Helper()
	b, err := normalize.NewBuilder("NMS 5.97", "6.45.0.1", []string{"NMSARC.Precache.pak", "NMSARC.globals.pak"})
	if err != nil {
		t.Fatalf("NewBuilder: %v", err)
	}
	return b
}

// A minimal but valid graph: one raw leaf and one craftable that consumes it.
func seed(b *normalize.Builder) {
	b.AddItems(
		domain.Item{ID: "PLANT_SNOW", Name: "Frost Crystal", RawObtainable: true, DefaultMethod: domain.MethodRaw},
		domain.Item{ID: "FUEL2", Name: "Condensed Carbon", RawObtainable: true, DefaultMethod: domain.MethodRaw},
		domain.Item{ID: "REACTION1", Name: "Thermic Condensate", DefaultMethod: domain.MethodRefine},
	)
	b.AddRecipes(domain.Recipe{
		Output: "REACTION1", Method: domain.MethodRefine,
		Inputs: []domain.Input{{Item: "PLANT_SNOW", Quantity: 250}, {Item: "FUEL2", Quantity: 50}},
	})
}

// SPEC-0004 REQ "Source Provenance and Version Stamping":
// WHEN an artifact is generated from a real install
// THEN extracted is true, game_version names the build read, and source
// names the archives and the MBINCompiler version used.
func TestProvenanceIsRecorded(t *testing.T) {
	b := builder(t)
	seed(b)
	art, err := b.Artifact()
	if err != nil {
		t.Fatalf("Artifact: %v", err)
	}
	if !art.Extracted {
		t.Error("extracted is false on a generated artifact")
	}
	if art.GameVersion != "NMS 5.97" {
		t.Errorf("game_version = %q, want the build read", art.GameVersion)
	}
	if art.Provenance == nil {
		t.Fatal("provenance is absent")
	}
	if art.Provenance.MBINCompiler != "6.45.0.1" {
		t.Errorf("mbincompiler = %q", art.Provenance.MBINCompiler)
	}
	if len(art.Provenance.Archives) != 2 {
		t.Errorf("archives = %v, want both recorded", art.Provenance.Archives)
	}
	if !strings.Contains(art.Source, "6.45.0.1") {
		t.Errorf("source %q does not name the MBINCompiler version", art.Source)
	}
	if art.SchemaVersion != domain.CurrentSchemaVersion {
		t.Errorf("schema_version = %d, want %d", art.SchemaVersion, domain.CurrentSchemaVersion)
	}
}

// SPEC-0004 REQ "Source Provenance and Version Stamping":
// WHEN the game version cannot be determined from the install
// THEN generation fails naming what could not be read, and no artifact is
// written.
func TestUnknownGameVersionFailsRatherThanGuesses(t *testing.T) {
	for _, tc := range []struct {
		name, game, mbin string
		archives         []string
	}{
		{"no game version", "", "6.45.0.1", []string{"a.pak"}},
		{"no compiler version", "NMS 5.97", "", []string{"a.pak"}},
		{"no archives", "NMS 5.97", "6.45.0.1", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := normalize.NewBuilder(tc.game, tc.mbin, tc.archives)
			if err == nil {
				t.Fatal("NewBuilder accepted missing provenance")
			}
			if !errors.Is(err, normalize.ErrSourceMissing) {
				t.Errorf("error is %v, want ErrSourceMissing", err)
			}
		})
	}
}

// SPEC-0004 REQ "Deterministic Output":
// WHEN the normalizer runs twice against an unchanged install
// THEN the two artifacts are byte-identical.
//
// The two builders add the same records in *opposite* order, which is what
// makes this a test of the emitter rather than of the caller: unstable
// output would differ here even though the inputs are the same set.
func TestOutputIsByteIdenticalRegardlessOfInsertionOrder(t *testing.T) {
	forward := builder(t)
	forward.AddItems(
		domain.Item{ID: "AAA", Name: "A", RawObtainable: true, DefaultMethod: domain.MethodRaw},
		domain.Item{ID: "BBB", Name: "B", RawObtainable: true, DefaultMethod: domain.MethodRaw},
		domain.Item{ID: "CCC", Name: "C", DefaultMethod: domain.MethodCraft},
	)
	forward.AddRecipes(domain.Recipe{
		Output: "CCC", Method: domain.MethodCraft,
		Inputs: []domain.Input{{Item: "AAA", Quantity: 1}, {Item: "BBB", Quantity: 2}},
	})

	reverse := builder(t)
	reverse.AddItems(
		domain.Item{ID: "CCC", Name: "C", DefaultMethod: domain.MethodCraft},
		domain.Item{ID: "BBB", Name: "B", RawObtainable: true, DefaultMethod: domain.MethodRaw},
		domain.Item{ID: "AAA", Name: "A", RawObtainable: true, DefaultMethod: domain.MethodRaw},
	)
	reverse.AddRecipes(domain.Recipe{
		Output: "CCC", Method: domain.MethodCraft,
		Inputs: []domain.Input{{Item: "BBB", Quantity: 2}, {Item: "AAA", Quantity: 1}},
	})

	a1, err := forward.Artifact()
	if err != nil {
		t.Fatal(err)
	}
	a2, err := reverse.Artifact()
	if err != nil {
		t.Fatal(err)
	}
	b1, err := normalize.Encode(a1)
	if err != nil {
		t.Fatal(err)
	}
	b2, err := normalize.Encode(a2)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b1, b2) {
		t.Errorf("encodings differ by insertion order:\n--- forward\n%s\n--- reverse\n%s", b1, b2)
	}
}

// Encoding the same artifact twice must not drift either — this is the plain
// reading of "two runs produce byte-identical output".
func TestRepeatedEncodingIsStable(t *testing.T) {
	b := builder(t)
	seed(b)
	art, err := b.Artifact()
	if err != nil {
		t.Fatal(err)
	}
	first, err := normalize.Encode(art)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 5 {
		again, err := normalize.Encode(art)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(first, again) {
			t.Fatalf("encoding %d differs from the first", i+2)
		}
	}
}

// The artifact carries no clock reading, because one would defeat
// determinism for no benefit game_version does not already provide.
func TestArtifactCarriesNoTimestamp(t *testing.T) {
	b := builder(t)
	seed(b)
	art, err := b.Artifact()
	if err != nil {
		t.Fatal(err)
	}
	blob, err := normalize.Encode(art)
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{"generated_at", "timestamp", "2026-", "2026-"} {
		if bytes.Contains(blob, []byte(banned)) {
			t.Errorf("artifact contains %q, which would break byte-identical regeneration", banned)
		}
	}
}

// SPEC-0004 REQ "Structural Surprise Fails Loudly":
// WHEN generation fails partway through THEN no artifact file is left behind.
//
// Two halves, because "no artifact left behind" has two failure points. A
// generation that fails never reaches the writer at all; a write that fails
// mid-stream must not leave a truncated file at the destination, which is
// what the temp-file-and-rename buys.
func TestFailedGenerationNeverReachesTheWriter(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tier1.json")

	b := builder(t)
	seed(b)
	// A recipe input naming an item no table defines: the graph is not
	// closed, so assembly must fail before anything is written.
	b.AddRecipes(domain.Recipe{
		Output: "REACTION1", Method: domain.MethodCraft,
		Inputs: []domain.Input{{Item: "NOT_AN_ITEM", Quantity: 1}},
	})

	art, err := b.Artifact()
	if err == nil {
		t.Fatal("Artifact accepted a recipe with a dangling input")
	}
	if art != nil {
		t.Error("Artifact returned a value alongside an error")
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Errorf("an artifact exists at %s after a failed generation", path)
	}
	assertNoTempFiles(t, dir)
}

// A write that cannot complete leaves the previous artifact intact and no
// partial file at the destination.
func TestFailedWriteLeavesThePreviousArtifactIntact(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tier1.json")

	b := builder(t)
	seed(b)
	good, err := b.Artifact()
	if err != nil {
		t.Fatal(err)
	}
	if err := normalize.WriteFile(path, good); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	// Make the directory read-only so the temp-file creation fails. The
	// destination must be untouched, not truncated.
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Skipf("cannot make directory read-only here: %v", err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o755) })

	if err := normalize.WriteFile(path, good); err == nil {
		t.Skip("directory is still writable (running as root?); cannot exercise the failure path")
	}

	os.Chmod(dir, 0o755)
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the previous artifact is gone after a failed write: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Error("a failed write modified the previously written artifact")
	}
	assertNoTempFiles(t, dir)
}

func assertNoTempFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("temp file %s was left behind", e.Name())
		}
	}
}

// SPEC-0004 REQ "Error Handling Standards":
// WHEN a caller encounters a missing source table versus an unresolved
// localisation key THEN the two failures carry different sentinels.
func TestSentinelsAreDistinguishable(t *testing.T) {
	all := []error{
		normalize.ErrSourceMissing,
		normalize.ErrStructureUnrecognized,
		normalize.ErrReferenceUnresolved,
		normalize.ErrLocalisationUnresolved,
	}
	for i, a := range all {
		for j, b := range all {
			if i != j && errors.Is(a, b) {
				t.Errorf("sentinels %d and %d are not distinct: %v / %v", i, j, a, b)
			}
		}
	}

	missing := normalize.Missing("nms_reality_gcproducttable")
	name := normalize.UnresolvedName("nms_reality_gcproducttable", "ULTRAPROD2", "UI_ULTRAPROD_2_NAME_L")
	if !errors.Is(missing, normalize.ErrSourceMissing) || errors.Is(missing, normalize.ErrLocalisationUnresolved) {
		t.Error("a missing table is not cleanly distinguishable from an unresolved name")
	}
	if !errors.Is(name, normalize.ErrLocalisationUnresolved) || errors.Is(name, normalize.ErrSourceMissing) {
		t.Error("an unresolved name is not cleanly distinguishable from a missing table")
	}
}

// SPEC-0004 REQ "Error Handling Standards":
// WHEN normalization fails on one row of one table
// THEN the error names the table, the row's identifier, and the expectation
// violated.
func TestErrorNamesTableRowAndExpectation(t *testing.T) {
	err := normalize.Unrecognized("basebuildingobjectstable", "U_EXTRACTOR_S", "Rate", "an integer", "\"fast\"")
	msg := err.Error()
	for _, want := range []string{"basebuildingobjectstable", "U_EXTRACTOR_S", "Rate", "an integer"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not name %q", msg, want)
		}
	}
	var se *normalize.SourceError
	if !errors.As(err, &se) {
		t.Fatalf("error %v is not a *SourceError", err)
	}
	attrs := se.LogAttrs()
	if len(attrs)%2 != 0 {
		t.Errorf("LogAttrs returned %d values; key-value pairs must be even", len(attrs))
	}
	if se.Table == "" || se.Row == "" {
		t.Error("SourceError lost its table or row")
	}
}

// The economy section round-trips through LoadTier1 with unknown fields
// disallowed — the constraint that forces schema and producer to move
// together.
//
// SPEC-0004 REQ "Schema Extension and Load Compatibility":
// WHEN an artifact carrying base-economy sections is passed to LoadTier1
// THEN it decodes without an unknown-field error and validates.
func TestEconomySectionLoads(t *testing.T) {
	b := builder(t)
	seed(b)
	b.SetEconomy(&domain.Economy{
		Parts: []domain.Part{{
			ID:      "U_EXTRACTOR_S",
			Primary: domain.Flow{Network: domain.NetworkResources, Rate: 100, Storage: 360000},
			Dependencies: []domain.Dependency{
				{Network: domain.NetworkPower, Rate: -50, Effect: "EnablesRate"},
			},
			Hotspot: "Mineral1",
		}},
		Hotspots: []domain.Hotspot{{
			Category:   "Mineral1",
			Strengths:  domain.ClassValues{C: 1, B: 1.5, A: 2, S: 2.5},
			Weightings: domain.ClassValues{C: 6, B: 4, A: 2, S: 1},
		}},
		Crops: []domain.Crop{{
			ID: "SNOWPLANT", Substance: "PLANT_SNOW",
			Yield: domain.Range{Min: 50, Max: 50}, GrowthSeconds: 3600,
		}},
		Refining: &domain.Refining{
			ProductsPerCycle: 2, SubstancesPerCycle: 250,
			ProductsPerCycleSurvival: 1, SubstancesPerCycleSurvival: 100,
		},
	})
	art, err := b.Artifact()
	if err != nil {
		t.Fatalf("Artifact: %v", err)
	}
	blob, err := normalize.Encode(art)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := domain.LoadTier1(bytes.NewReader(blob))
	if err != nil {
		t.Fatalf("LoadTier1 rejected an artifact carrying the economy section: %v", err)
	}
	if loaded.Economy == nil {
		t.Fatal("economy section did not survive the round trip")
	}
	if got := loaded.Economy.Crops[0].Yield.Max; got != 50 {
		t.Errorf("crop yield max = %d, want 50", got)
	}
	if got := loaded.Economy.Refining.SubstancesPerCycleSurvival; got != 100 {
		t.Errorf("survival throughput = %d, want 100", got)
	}
}

// A crop yielding an item the artifact does not carry is a dangling
// reference and must be refused.
func TestEconomyReferencesAreChecked(t *testing.T) {
	b := builder(t)
	seed(b)
	b.SetEconomy(&domain.Economy{
		Crops: []domain.Crop{{ID: "SNOWPLANT", Substance: "NOT_AN_ITEM", Yield: domain.Range{Min: 1, Max: 1}}},
	})
	if _, err := b.Artifact(); err == nil {
		t.Fatal("Artifact accepted a crop yielding an unknown item")
	}
}

// A part naming a hotspot category the artifact does not carry is likewise
// dangling — the planner could not scale its rate.
func TestPartHotspotReferenceIsChecked(t *testing.T) {
	b := builder(t)
	seed(b)
	b.SetEconomy(&domain.Economy{
		Parts: []domain.Part{{
			ID:      "U_EXTRACTOR_S",
			Primary: domain.Flow{Network: domain.NetworkResources, Rate: 100},
			Hotspot: "NoSuchCategory",
		}},
	})
	if _, err := b.Artifact(); err == nil {
		t.Fatal("Artifact accepted a part referencing an absent hotspot category")
	}
}
