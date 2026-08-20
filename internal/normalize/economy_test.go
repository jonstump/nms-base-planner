package normalize_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jonstump/nms-base-planner/internal/domain"
	"github.com/jonstump/nms-base-planner/internal/normalize"
)

// The fixtures under testdata/economy are real content sliced out of a
// 6.45.0.1 decompilation — see testdata/economy/gen.go for exactly which
// rows and why. Asserting against hand-authored MXML would test only that
// the parser agrees with my idea of the format, which is the mistake that
// cost this project its first parser.
const economyRoot = "testdata/economy"

func economy(t *testing.T) *domain.Economy {
	t.Helper()
	e, err := normalize.ReadEconomy(economyRoot)
	if err != nil {
		t.Fatalf("ReadEconomy: %v", err)
	}
	return e
}

func part(t *testing.T, e *domain.Economy, id string) domain.Part {
	t.Helper()
	for _, p := range e.Parts {
		if p.ID == id {
			return p
		}
	}
	t.Fatalf("part %q missing; got %d parts", id, len(e.Parts))
	return domain.Part{}
}

func crop(t *testing.T, e *domain.Economy, id string) domain.Crop {
	t.Helper()
	for _, c := range e.Crops {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("crop %q missing; got %d crops", id, len(e.Crops))
	return domain.Crop{}
}

// SPEC-0004 REQ "Base Economy Data":
// WHEN U_EXTRACTOR_S is emitted
// THEN its rate, its storage, and its dependent power draw are present,
// each identified by the network it applies to.
func TestExtractorCarriesRateStorageAndPowerDraw(t *testing.T) {
	p := part(t, economy(t), "U_EXTRACTOR_S")

	if got, want := p.Primary.Network, domain.NetworkResources; got != want {
		t.Errorf("primary network = %q, want %q", got, want)
	}
	if got, want := p.Primary.Rate, int64(100); got != want {
		t.Errorf("rate = %d, want %d", got, want)
	}
	if got, want := p.Primary.Storage, int64(360000); got != want {
		t.Errorf("storage = %d, want %d", got, want)
	}
	if len(p.Dependencies) != 1 {
		t.Fatalf("dependencies = %d, want 1", len(p.Dependencies))
	}
	d := p.Dependencies[0]
	if d.Network != domain.NetworkPower || d.Rate != -50 || d.Effect != "EnablesRate" {
		t.Errorf("dependency = %+v, want power -50 EnablesRate", d)
	}
	// The class lives on the hotspot; the part only names which hotspot it
	// scales with.
	if got, want := p.Hotspot, "Mineral"; got != want {
		t.Errorf("hotspot = %q, want %q", got, want)
	}
}

// SPEC-0004 REQ "Base Economy Data":
// WHEN class strengths are emitted
// THEN they are keyed by hotspot category and class, and no per-class device
// variants appear.
func TestHotspotClassStrengthsAndWeightings(t *testing.T) {
	e := economy(t)

	want := map[string]struct{ strengths, weightings domain.ClassValues }{
		"Power":   {domain.ClassValues{C: 150, B: 220, A: 250, S: 300}, domain.ClassValues{C: 10, B: 6, A: 2, S: 1}},
		"Mineral": {domain.ClassValues{C: 1, B: 1.5, A: 2, S: 2.5}, domain.ClassValues{C: 6, B: 4, A: 2, S: 1}},
		"Gas":     {domain.ClassValues{C: 1, B: 1.5, A: 2, S: 2.5}, domain.ClassValues{C: 20, B: 4, A: 2, S: 1}},
	}
	if len(e.Hotspots) != len(want) {
		t.Fatalf("hotspots = %d, want %d", len(e.Hotspots), len(want))
	}
	for _, h := range e.Hotspots {
		w, ok := want[h.Category]
		if !ok {
			t.Errorf("unexpected hotspot category %q", h.Category)
			continue
		}
		if h.Strengths != w.strengths {
			t.Errorf("%s strengths = %+v, want %+v", h.Category, h.Strengths, w.strengths)
		}
		if h.Weightings != w.weightings {
			t.Errorf("%s weightings = %+v, want %+v", h.Category, h.Weightings, w.weightings)
		}
	}

	// Every part that scales names a category the artifact carries; none
	// carries a class of its own.
	categories := map[string]bool{}
	for _, h := range e.Hotspots {
		categories[h.Category] = true
	}
	for _, p := range e.Parts {
		if p.Hotspot != "" && !categories[p.Hotspot] {
			t.Errorf("part %q names hotspot %q, which is not emitted", p.ID, p.Hotspot)
		}
	}
}

// SPEC-0004 REQ "Base Economy Data" — "The normalizer MUST NOT emit
// per-class device variants, which do not exist in the source."
//
// Asserted on the encoded form rather than on part IDs, because a name check
// would trip over U_EXTRACTOR_S, whose trailing S is a size tier and not a
// class. What must be true is that class-keyed values appear nowhere outside
// the hotspots section.
func TestNoPerClassDeviceVariants(t *testing.T) {
	e := economy(t)

	blob, err := json.Marshal(e.Parts)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"c":`, `"b":`, `"a":`, `"s":`, `"strengths"`, `"weightings"`} {
		if strings.Contains(string(blob), key) {
			t.Errorf("parts carry %s; class scaling belongs to the hotspot, not the device", key)
		}
	}

	// And the source really does hold only one extractor of each size, not
	// four classes of one: a per-class model would have produced siblings.
	var extractors int
	for _, p := range e.Parts {
		if strings.HasPrefix(p.ID, "U_EXTRACTOR") {
			extractors++
		}
	}
	if extractors != 1 {
		t.Errorf("extractor parts = %d, want 1 (the fixture carries one size)", extractors)
	}
}

// SPEC-0004 REQ "Base Economy Data":
// WHEN a crop yield is expressed as a minimum and maximum in the source
// THEN both bounds are emitted, rather than one derived value.
func TestCropYieldsAndGrowthTimes(t *testing.T) {
	e := economy(t)

	cases := []struct {
		id        string
		substance string
		min, max  int64
		growth    int64
	}{
		// Frost Crystal. The acceptance case, and the one the wiki quotes:
		// the yield is on the substance the plant hands you, not the plant.
		{"SNOWPLANT", "PLANT_SNOW", 50, 50, 3600},
		// Cactus Flesh. The reward key is PLANT_BARREN but the substance is
		// PLANT_DUST — reading the key as the substance would be wrong here
		// and right everywhere else, which is the worst kind of wrong.
		{"BARRENPLANT", "PLANT_DUST", 100, 100, 57600},
		// Star Bulb.
		{"LUSHPLANT", "PLANT_LUSH", 25, 25, 14400},
		// Venom Sac, whose reward is a product rather than a substance.
		{"SACVENOMPLANT", "SACVENOM", 1, 1, 12000},
	}
	for _, tc := range cases {
		c := crop(t, e, tc.id)
		if c.Substance != tc.substance {
			t.Errorf("%s substance = %q, want %q", tc.id, c.Substance, tc.substance)
		}
		if c.Yield.Min != tc.min || c.Yield.Max != tc.max {
			t.Errorf("%s yield = [%d, %d], want [%d, %d]", tc.id, c.Yield.Min, c.Yield.Max, tc.min, tc.max)
		}
		if c.GrowthSeconds != tc.growth {
			t.Errorf("%s growth = %ds, want %ds", tc.id, c.GrowthSeconds, tc.growth)
		}
	}
}

// A container on the growth network is not a crop: it grows nothing itself.
func TestGrowthNetworkContainerIsNotACrop(t *testing.T) {
	e := economy(t)

	for _, c := range e.Crops {
		if c.ID == "CARBONPLANTER" {
			t.Fatal("CARBONPLANTER emitted as a crop; it is a planter, with no flora entity and no yield")
		}
	}
	// It is still carried as a part, because it does participate in the
	// network — dropping it entirely would lose its growth contribution.
	p := part(t, e, "CARBONPLANTER")
	if p.Primary.Network != domain.NetworkPlantGrowth {
		t.Errorf("CARBONPLANTER network = %q, want plant_growth", p.Primary.Network)
	}
}

// A buildable with no rate, no storage and no dependency has no economic
// behaviour and is not emitted.
func TestPartWithNoEconomicBehaviourIsSkipped(t *testing.T) {
	e := economy(t)
	for _, p := range e.Parts {
		if p.ID == "BUILD_REFINER1" {
			t.Fatal("BUILD_REFINER1 emitted; it carries no rate, storage or dependency")
		}
	}

	// The fixture does contain it, so the absence above is a decision rather
	// than an accident of what was sliced.
	blob, err := os.ReadFile(filepath.Join(economyRoot, "metadata/reality/tables/basebuildingobjectstable.MXML"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(blob), `_id="BUILD_REFINER1"`) {
		t.Fatal("the fixture no longer carries BUILD_REFINER1, so this scenario is not being exercised")
	}
}

// SPEC-0004 REQ "Base Economy Data" — refiner throughput including
// difficulty variants.
func TestRefinerThroughput(t *testing.T) {
	r := economy(t).Refining
	if r == nil {
		t.Fatal("no refining data emitted")
	}
	want := domain.Refining{
		ProductsPerCycle: 2, SubstancesPerCycle: 250,
		ProductsPerCycleSurvival: 1, SubstancesPerCycleSurvival: 100,
	}
	if *r != want {
		t.Errorf("refining = %+v, want %+v", *r, want)
	}
}

// SPEC-0004 REQ "Search Boundaries Are Recorded":
// WHEN a value is produced by searching several tables rather than reading
// one known field
// THEN the sources searched are recorded alongside it.
func TestSearchBoundariesAreRecorded(t *testing.T) {
	e := economy(t)
	if len(e.Searches) == 0 {
		t.Fatal("no search recorded; the crop chain spans three sources")
	}

	var found bool
	for _, s := range e.Searches {
		if !strings.Contains(s.Value, "crop") {
			continue
		}
		found = true
		for _, want := range []string{"basebuildingobjectstable", "plantinteraction.entity", "rewardtable"} {
			var named bool
			for _, src := range s.Searched {
				if strings.Contains(src, want) {
					named = true
				}
			}
			if !named {
				t.Errorf("crop search does not name %q among %v", want, s.Searched)
			}
		}
		// The note must say what was left out, not only what was covered.
		if !strings.Contains(s.Note, "CARBONPLANTER") {
			t.Errorf("crop search note does not record the container it skipped: %q", s.Note)
		}
	}
	if !found {
		t.Error("no search record covers the crop derivation")
	}
}

// The economy section must survive the artifact's own validation, since
// that is what a consumer actually loads.
func TestEconomyLoadsAsPartOfAnArtifact(t *testing.T) {
	e := economy(t)

	b, err := normalize.NewBuilder("5.97", "6.45.0.1",
		[]string{"NMSARC.Precache.pak", "NMSARC.globals.pak"})
	if err != nil {
		t.Fatal(err)
	}
	// Crop substances have to exist as items, which is the graph half of the
	// artifact; stand them in here so the economy can be validated on its own.
	for _, c := range e.Crops {
		b.AddItems(domain.Item{
			ID: c.Substance, Name: c.Substance,
			RawObtainable: true, DefaultMethod: domain.MethodRaw,
		})
	}
	b.SetEconomy(e)

	a1, err := b.Artifact()
	if err != nil {
		t.Fatalf("Artifact: %v", err)
	}
	if a1.Economy == nil || len(a1.Economy.Parts) == 0 {
		t.Fatal("economy did not survive assembly")
	}

	// And it round-trips: what was written loads back with the same values.
	blob, err := normalize.Encode(a1)
	if err != nil {
		t.Fatal(err)
	}
	back, err := domain.LoadTier1(strings.NewReader(string(blob)))
	if err != nil {
		t.Fatalf("reloading the encoded artifact: %v", err)
	}
	if back.Economy == nil {
		t.Fatal("economy absent after a round trip")
	}
	if len(back.Economy.Parts) != len(e.Parts) || len(back.Economy.Crops) != len(e.Crops) {
		t.Errorf("round trip = %d parts / %d crops, want %d / %d",
			len(back.Economy.Parts), len(back.Economy.Crops), len(e.Parts), len(e.Crops))
	}
}

// SPEC-0004 REQ "Deterministic Output" — the artifact is committed, so two
// runs over one install must produce the same bytes.
func TestEconomyExtractionIsDeterministic(t *testing.T) {
	first := encodeEconomy(t)
	for i := 0; i < 10; i++ {
		if got := encodeEconomy(t); got != first {
			t.Fatalf("run %d differs from the first; map iteration is leaking into output", i+2)
		}
	}
}

func encodeEconomy(t *testing.T) string {
	t.Helper()
	e := economy(t)
	b, err := normalize.NewBuilder("5.97", "6.45.0.1", []string{"NMSARC.Precache.pak"})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range e.Crops {
		b.AddItems(domain.Item{ID: c.Substance, Name: c.Substance,
			RawObtainable: true, DefaultMethod: domain.MethodRaw})
	}
	b.SetEconomy(e)
	a1, err := b.Artifact()
	if err != nil {
		t.Fatal(err)
	}
	blob, err := normalize.Encode(a1)
	if err != nil {
		t.Fatal(err)
	}
	return string(blob)
}

// SPEC-0004 REQ "Structural Surprise Fails Loudly" — every failure mode
// below produces a named error rather than a quietly smaller economy.
func TestSourcesFailClosed(t *testing.T) {
	cases := []struct {
		name string
		// mutate edits the copied source tree; an empty file path deletes.
		file, from, to string
		remove         string
		want           error
		mentions       string
	}{
		{
			name:   "a missing source",
			remove: "metadata/simulation/scanning/regionhotspotstable.MXML",
			want:   normalize.ErrSourceMissing,
		},
		{
			name: "a link network the vocabulary does not know",
			file: "metadata/reality/tables/basebuildingobjectstable.MXML",
			from: `<Property name="LinkNetworkType" value="Resources" />`,
			to:   `<Property name="LinkNetworkType" value="Antimatter" />`,
			want: normalize.ErrStructureUnrecognized, mentions: "Antimatter",
		},
		{
			name: "a hotspot family whose members disagree",
			file: "metadata/simulation/scanning/regionhotspotstable.MXML",
			from: `<Property name="Mineral2" value="GcRegionHotspotData">
			<Property name="ProbabilityWeighting" value="1.000000" />
			<Property name="MinRange" value="190.000000" />
			<Property name="MaxRange" value="225.000000" />
			<Property name="ClassWeightings">
				<Property name="C" value="6.000000" />`,
			to: `<Property name="Mineral2" value="GcRegionHotspotData">
			<Property name="ProbabilityWeighting" value="1.000000" />
			<Property name="MinRange" value="190.000000" />
			<Property name="MaxRange" value="225.000000" />
			<Property name="ClassWeightings">
				<Property name="C" value="99.000000" />`,
			want: normalize.ErrStructureUnrecognized, mentions: "Mineral2",
		},
		{
			name: "a crop whose reward key is not in the reward table",
			file: "models/planets/biomes/common/interactiveflora/farmsnow/entities/plantinteraction.entity.MXML",
			from: `<Property name="Id" value="PLANT_SNOW" />`,
			to:   `<Property name="Id" value="PLANT_NOT_IN_TABLE" />`,
			want: normalize.ErrReferenceUnresolved, mentions: "PLANT_NOT_IN_TABLE",
		},
		{
			name:   "a crop whose flora entity is absent",
			remove: "models/planets/biomes/common/interactiveflora/farmlush/entities/plantinteraction.entity.MXML",
			want:   normalize.ErrSourceMissing,
		},
		{
			name: "a refiner throughput field that is gone",
			file: "gcgameplayglobals.global.MXML",
			from: `<Property name="RefinerSubsMadeInTimeSurvival" value="100" />`,
			to:   ``,
			want: normalize.ErrStructureUnrecognized, mentions: "RefinerSubsMadeInTimeSurvival",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := copyTree(t, economyRoot)
			switch {
			case tc.remove != "":
				if err := os.Remove(filepath.Join(root, tc.remove)); err != nil {
					t.Fatal(err)
				}
			default:
				p := filepath.Join(root, tc.file)
				blob, err := os.ReadFile(p)
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(string(blob), tc.from) {
					t.Fatalf("the fixture no longer contains the text this case edits, so it proves nothing")
				}
				edited := strings.Replace(string(blob), tc.from, tc.to, 1)
				if err := os.WriteFile(p, []byte(edited), 0o644); err != nil {
					t.Fatal(err)
				}
			}

			e, err := normalize.ReadEconomy(root)
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
			if e != nil {
				t.Error("an economy was returned alongside an error; must be nil")
			}
			if tc.mentions != "" && !strings.Contains(err.Error(), tc.mentions) {
				t.Errorf("error %q does not name %q", err, tc.mentions)
			}

			var se *normalize.SourceError
			if !errors.As(err, &se) {
				t.Fatalf("error %v is not a *SourceError, so a logger cannot read its fields", err)
			}
			if se.Table == "" {
				t.Error("the error names no table")
			}
		})
	}
}

// copyTree copies a fixture tree into a temp dir so a case can break it.
func copyTree(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	err := filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || filepath.Ext(p) != ".MXML" {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		blob, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out := filepath.Join(dst, rel)
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		return os.WriteFile(out, blob, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

// SPEC-0004 REQ "Deterministic Output": collections are emitted in a
// defined, stable order — "not map-iteration order".
//
// sortArtifact orders Searches by Value, which is only a total key if Value
// is unique. Every other collection in the artifact pairs its sort key with a
// uniqueness check in Validate; this is that check for Searches.
//
// Rejecting rather than tiebreaking is deliberate. These records are written
// by the normalizer rather than read out of the game tables, so two searches
// deriving one value is an authoring mistake — a duplicate that wants merging
// or two derivations that want distinguishable names — and surfacing it beats
// silently ordering it.
func TestDuplicateSearchValueIsRefused(t *testing.T) {
	dup := []domain.Search{
		{Value: "crop substance", Searched: []string{"tableA"}, Note: "first"},
		{Value: "crop substance", Searched: []string{"tableB"}, Note: "second"},
	}

	b, err := normalize.NewBuilder("NMS 5.97", "6.45.0.1", []string{"a.pak"})
	if err != nil {
		t.Fatal(err)
	}
	b.AddItems(domain.Item{ID: "AAA", RawObtainable: true, DefaultMethod: domain.MethodRaw})
	b.SetEconomy(&domain.Economy{Searches: dup})

	if _, err := b.Artifact(); err == nil {
		t.Fatal("Artifact accepted two search records deriving the same value")
	} else if !errors.Is(err, domain.ErrInvalidArtifact) {
		t.Errorf("error is %v, want ErrInvalidArtifact", err)
	} else if !strings.Contains(err.Error(), "crop substance") {
		t.Errorf("error %q does not name the duplicated value", err)
	}
}

// The real economy's search records must satisfy the uniqueness the sort
// depends on — otherwise the check above only ever fires on crafted input.
func TestRealSearchValuesAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, s := range economy(t).Searches {
		if seen[s.Value] {
			t.Errorf("two search records derive %q", s.Value)
		}
		seen[s.Value] = true
	}
}
