package domain

import (
	"errors"
	"os"
	"strings"
	"testing"
)

// realArtifact is the generated dataset, which carries the economy section
// the constants resolve against. Tests that only need a graph use the
// hand-authored fixture; tests about where a constant comes from need the
// real one, because "it reads from Economy" is only meaningful against the
// Economy the normalizer actually emits.
func realArtifact(t *testing.T) *Tier1 {
	t.Helper()
	f, err := os.Open("../../data/tier1.json")
	if err != nil {
		t.Fatalf("opening the generated artifact: %v", err)
	}
	defer f.Close()
	a1, err := LoadTier1(f)
	if err != nil {
		t.Fatalf("loading the generated artifact: %v", err)
	}
	return a1
}

// curatedForTest is a complete curated set. Values are the community-reported
// ones where a report exists and placeholders otherwise; the point of these
// tests is that they arrive from the caller, not what they are.
func curatedForTest() Curated {
	return Curated{
		BiodomeCropSlots:   16,
		FaunaYieldPerCycle: 12,
		FaunaCycleSeconds:  1800,
		StepsPerProcessor:  2,
		DepotThreshold:     1000,
		ProcessSeconds:     30,
		FaunaProducts:      map[string]bool{},
		ResourceHotspots:   map[string]string{},
		PanelsPerBattery:   2,
	}
}

func sites(bases ...BaseID) map[BaseID]SiteConfig {
	out := map[BaseID]SiteConfig{}
	for _, b := range bases {
		out[b] = SiteConfig{ExtractorClass: ClassB}
	}
	return out
}

// SPEC-0001 REQ "Leaf Assignment to Bases":
// WHEN crops are assigned to one base and gases to another
// THEN each base's rollup contains only its assigned leaf items.
func TestLeavesGroupByBase(t *testing.T) {
	g := resolveStasis(t, 1, nil)

	in := RollupInput{
		Assignments: map[string]BaseID{
			// Crops at one base, gases at another.
			"fc": "farm", "sol": "farm", "cf": "farm", "sb": "farm", "gr": "farm", "fae": "farm",
			"sul": "gasfield", "nit": "gasfield", "rad": "gasfield",
		},
		Sites: sites("farm", "gasfield"),
	}
	grouping, err := GroupLeaves(g, in)
	if err != nil {
		t.Fatalf("GroupLeaves: %v", err)
	}

	farm, ok := grouping.Group("farm")
	if !ok {
		t.Fatal("farm group missing")
	}
	gas, ok := grouping.Group("gasfield")
	if !ok {
		t.Fatal("gasfield group missing")
	}

	for _, d := range farm.Demands {
		if strings.Contains("sul nit rad", d.ItemID) {
			t.Errorf("gas %q leaked into the farm group", d.ItemID)
		}
	}
	if len(gas.Demands) != 3 {
		t.Errorf("gasfield has %d demands, want 3", len(gas.Demands))
	}
	for _, d := range gas.Demands {
		got, exact := d.TotalInt()
		if !exact || got != 500 {
			t.Errorf("%s total = %s, want 500", d.ItemID, d.Total().RatString())
		}
	}

	// Sorted, so output order never depends on map iteration.
	for i := 1; i < len(farm.Demands); i++ {
		if farm.Demands[i-1].ItemID >= farm.Demands[i].ItemID {
			t.Errorf("farm demands are not sorted: %v", farm.Demands)
		}
	}
}

// SPEC-0001 REQ "Leaf Assignment to Bases":
// WHEN a leaf item has no base assignment
// THEN it appears in the unassigned group with its full required total.
func TestUnassignedLeavesAreSurfaced(t *testing.T) {
	g := resolveStasis(t, 1, nil)

	// Assign only the gases; everything else is unplaced.
	grouping, err := GroupLeaves(g, RollupInput{
		Assignments: map[string]BaseID{"sul": "gasfield", "nit": "gasfield", "rad": "gasfield"},
		Sites:       sites("gasfield"),
	})
	if err != nil {
		t.Fatalf("GroupLeaves: %v", err)
	}

	un, ok := grouping.Unassigned()
	if !ok {
		t.Fatal("no unassigned group, but most leaves were left unplaced")
	}
	if !un.IsUnassigned() {
		t.Error("the unassigned group does not report itself as unassigned")
	}

	// Condensed Carbon is unassigned and must carry its whole requirement,
	// not a share of it and not zero.
	var cc *LeafDemand
	for i := range un.Demands {
		if un.Demands[i].ItemID == "cc" {
			cc = &un.Demands[i]
		}
	}
	if cc == nil {
		t.Fatal("cc is not in the unassigned group; an unplaced leaf was dropped")
	}
	if got, exact := cc.TotalInt(); !exact || got != 300 {
		t.Errorf("cc total = %s, want 300", cc.Total().RatString())
	}

	// It is a distinct group, not a base: nothing was attributed to
	// gasfield that was not assigned there.
	gas, _ := grouping.Group("gasfield")
	if len(gas.Demands) != 3 {
		t.Errorf("gasfield picked up %d demands, want only its 3 assigned", len(gas.Demands))
	}

	// And the unassigned group sorts last — a remainder, not a base.
	if last := grouping.Groups[len(grouping.Groups)-1]; !last.IsUnassigned() {
		t.Errorf("last group is %q, want the unassigned group", last.Base)
	}

	// Every leaf lands somewhere.
	var counted int
	for _, group := range grouping.Groups {
		counted += len(group.Demands)
	}
	if want := len(g.Leaves()); counted != want {
		t.Errorf("grouped %d leaves, graph has %d", counted, want)
	}
}

// SPEC-0001 REQ "Leaf Assignment to Bases":
// WHEN a leaf is reassigned from one base to another
// THEN both the origin and destination base rollups are recomputed.
func TestReassignmentRecomputesBothBases(t *testing.T) {
	g := resolveStasis(t, 1, nil)

	before, err := GroupLeaves(g, RollupInput{
		Assignments: map[string]BaseID{"sul": "alpha", "nit": "alpha", "rad": "beta"},
		Sites:       sites("alpha", "beta"),
	})
	if err != nil {
		t.Fatal(err)
	}
	after, err := GroupLeaves(g, RollupInput{
		Assignments: map[string]BaseID{"sul": "alpha", "nit": "beta", "rad": "beta"},
		Sites:       sites("alpha", "beta"),
	})
	if err != nil {
		t.Fatal(err)
	}

	a0, _ := before.Group("alpha")
	b0, _ := before.Group("beta")
	a1, _ := after.Group("alpha")
	b1, _ := after.Group("beta")

	if len(a0.Demands) != 2 || len(b0.Demands) != 1 {
		t.Fatalf("before: alpha %d, beta %d; want 2 and 1", len(a0.Demands), len(b0.Demands))
	}
	// The origin shrank and the destination grew — both recomputed, not
	// just the one that gained.
	if len(a1.Demands) != 1 {
		t.Errorf("after: alpha has %d demands, want 1 — the origin was not recomputed", len(a1.Demands))
	}
	if len(b1.Demands) != 2 {
		t.Errorf("after: beta has %d demands, want 2", len(b1.Demands))
	}
	if a1.Demands[0].ItemID != "sul" {
		t.Errorf("alpha kept %q, want sul", a1.Demands[0].ItemID)
	}
}

// SPEC-0001 REQ "Producer Rollup" — "Extractor class MUST be configured per
// site, not per row."
func TestExtractorClassIsPerSite(t *testing.T) {
	g := resolveStasis(t, 1, nil)

	in := RollupInput{
		Assignments: map[string]BaseID{"sul": "alpha", "nit": "alpha", "rad": "beta"},
		Sites: map[BaseID]SiteConfig{
			"alpha": {ExtractorClass: ClassS},
			"beta":  {ExtractorClass: ClassC},
		},
	}
	grouping, err := GroupLeaves(g, in)
	if err != nil {
		t.Fatal(err)
	}

	alpha, _ := grouping.Group("alpha")
	beta, _ := grouping.Group("beta")
	if alpha.Site.ExtractorClass != ClassS {
		t.Errorf("alpha class = %q, want S", alpha.Site.ExtractorClass)
	}
	if beta.Site.ExtractorClass != ClassC {
		t.Errorf("beta class = %q, want C", beta.Site.ExtractorClass)
	}
	// One class per site, not per row: both of alpha's rows read the same
	// setting because it lives on the group.
	if len(alpha.Demands) != 2 {
		t.Fatalf("alpha has %d demands, want 2", len(alpha.Demands))
	}
}

// A base with assignments but no configuration is refused rather than
// defaulted — an extractor class picked for the caller is a number they
// never chose showing up in their plan.
func TestUnconfiguredBaseIsRefused(t *testing.T) {
	g := resolveStasis(t, 1, nil)

	cases := []struct {
		name string
		in   RollupInput
		want string
	}{
		{
			name: "no site configuration",
			in: RollupInput{
				Assignments: map[string]BaseID{"sul": "alpha"},
				Sites:       map[BaseID]SiteConfig{},
			},
			want: "no site configuration",
		},
		{
			name: "class outside the vocabulary",
			in: RollupInput{
				Assignments: map[string]BaseID{"sul": "alpha"},
				Sites:       map[BaseID]SiteConfig{"alpha": {ExtractorClass: "X"}},
			},
			want: "not one of C, B, A, S",
		},
		{
			name: "assigned to the empty base id",
			in: RollupInput{
				Assignments: map[string]BaseID{"sul": Unassigned},
				Sites:       sites("alpha"),
			},
			want: "empty base id",
		},
		{
			name: "assigned an item that is not a leaf",
			in: RollupInput{
				// The Stasis Device itself is the target, not a leaf.
				Assignments: map[string]BaseID{"sd": "alpha"},
				Sites:       sites("alpha"),
			},
			want: "not a leaf of this graph",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := GroupLeaves(g, tc.in)
			if err == nil {
				t.Fatal("GroupLeaves accepted it")
			}
			if out != nil {
				t.Error("a grouping was returned alongside an error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

// SPEC-0001 design.md "Tier 2 constants injected, never hardcoded" — every
// constant the later stages need resolves to an Economy field or to an
// explicit curated input.
func TestConstantsResolveToTheirSource(t *testing.T) {
	c, err := NewConstants(realArtifact(t), curatedForTest())
	if err != nil {
		t.Fatalf("NewConstants: %v", err)
	}

	// From the artifact: crop yields and growth times.
	crop, err := c.CropFor("PLANT_SNOW")
	if err != nil {
		t.Fatalf("CropFor: %v", err)
	}
	if crop.Yield.Min != 50 || crop.Yield.Max != 50 {
		t.Errorf("Frost Crystal yield = %+v, want 50/50", crop.Yield)
	}
	if crop.GrowthSeconds != 3600 {
		t.Errorf("Frost Crystal growth = %d, want 3600", crop.GrowthSeconds)
	}

	// From the artifact: part rates, storage and draws.
	ext, err := c.Part(PartExtractorMineral)
	if err != nil {
		t.Fatalf("Part: %v", err)
	}
	if ext.Primary.Rate != 100 || ext.Primary.Storage != 360000 {
		t.Errorf("extractor primary = %+v, want rate 100 storage 360000", ext.Primary)
	}
	if len(ext.Dependencies) != 1 || ext.Dependencies[0].Rate != -50 {
		t.Errorf("extractor draws %+v, want a single -50 power dependency", ext.Dependencies)
	}

	// From the artifact, though the design entry calls them curated: the
	// silo and the battery both state their buffers.
	if got, err := c.DepotCapacity(); err != nil || got != 1440000 {
		t.Errorf("DepotCapacity = %d, %v; want 1440000", got, err)
	}
	if got, err := c.BatteryCapacity(); err != nil || got != 45000 {
		t.Errorf("BatteryCapacity = %d, %v; want 45000", got, err)
	}

	// From the artifact: class scaling, as an exact rational.
	for _, tc := range []struct {
		category string
		class    HotspotClass
		want     string
	}{
		{"Mineral", ClassC, "1"}, {"Mineral", ClassB, "3/2"}, {"Mineral", ClassS, "5/2"},
		{"Power", ClassC, "150"}, {"Power", ClassS, "300"},
	} {
		got, err := c.ClassStrength(tc.category, tc.class)
		if err != nil {
			t.Errorf("ClassStrength(%s, %s): %v", tc.category, tc.class, err)
			continue
		}
		if got.RatString() != tc.want {
			t.Errorf("%s class %s = %s, want %s", tc.category, tc.class, got.RatString(), tc.want)
		}
	}

	// Curated: supplied by the caller, echoed back unchanged.
	if c.Curated().BiodomeCropSlots != 16 {
		t.Errorf("biodome slots = %d, want the caller's 16", c.Curated().BiodomeCropSlots)
	}
}

// A curated constant left at zero is refused rather than defaulted.
func TestCuratedConstantsMustBeSupplied(t *testing.T) {
	a1 := realArtifact(t)

	full := curatedForTest()
	cases := map[string]func(*Curated){
		"biodome crop slots":    func(c *Curated) { c.BiodomeCropSlots = 0 },
		"fauna yield per cycle": func(c *Curated) { c.FaunaYieldPerCycle = 0 },
		"fauna cycle seconds":   func(c *Curated) { c.FaunaCycleSeconds = 0 },
		"steps per processor":   func(c *Curated) { c.StepsPerProcessor = 0 },
		"depot threshold":       func(c *Curated) { c.DepotThreshold = 0 },
		"process seconds":       func(c *Curated) { c.ProcessSeconds = 0 },
		"panels per battery":    func(c *Curated) { c.PanelsPerBattery = 0 },
	}
	for name, clear := range cases {
		t.Run(name, func(t *testing.T) {
			curated := full
			clear(&curated)
			c, err := NewConstants(a1, curated)
			if !errors.Is(err, ErrMissingConstant) {
				t.Fatalf("error = %v, want ErrMissingConstant", err)
			}
			if c != nil {
				t.Error("constants were returned alongside an error")
			}
			if !strings.Contains(err.Error(), name) {
				t.Errorf("error %q does not name the missing constant", err)
			}
		})
	}
}

// An artifact with no economy section fails loudly rather than rolling up
// against zeros.
func TestMissingEconomyIsRefused(t *testing.T) {
	fixture := loadFixture(t) // the hand-authored graph carries no economy
	if fixture.Economy != nil {
		t.Skip("the fixture now carries an economy section")
	}

	c, err := NewConstants(fixture, curatedForTest())
	if !errors.Is(err, ErrInvalidArtifact) {
		t.Fatalf("error = %v, want ErrInvalidArtifact", err)
	}
	if c != nil {
		t.Error("constants were returned alongside an error")
	}
	if !strings.Contains(err.Error(), "economy") {
		t.Errorf("error %q does not say what was missing", err)
	}
}

// A constant whose source the artifact does not carry errors naming what it
// wanted, rather than returning a zero that looks like data.
func TestAbsentSourceIsNamed(t *testing.T) {
	c, err := NewConstants(realArtifact(t), curatedForTest())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := c.Part("U_NOT_A_PART"); !errors.Is(err, ErrUnknownItem) {
		t.Errorf("Part error = %v, want ErrUnknownItem", err)
	}
	if _, err := c.CropFor("NOT_A_CROP"); !errors.Is(err, ErrUnknownItem) {
		t.Errorf("CropFor error = %v, want ErrUnknownItem", err)
	}
	if _, err := c.ClassStrength("Antimatter", ClassS); !errors.Is(err, ErrUnknownItem) {
		t.Errorf("ClassStrength error = %v, want ErrUnknownItem", err)
	}
	if _, err := c.ClassStrength("Mineral", "X"); !errors.Is(err, ErrInvalidArtifact) {
		t.Errorf("ClassStrength with a bad class = %v, want ErrInvalidArtifact", err)
	}
}

// SPEC-0001's stage boundary: resolving a graph reads no economy constant
// and needs no base assignment.
//
// Asserted on the fixture, which carries no economy section at all — if
// stage 1 had started depending on one, this could not resolve.
func TestStageOneNeedsNoRollupConfiguration(t *testing.T) {
	fixture := loadFixture(t)
	if fixture.Economy != nil {
		t.Skip("the fixture now carries an economy section")
	}

	g, err := Resolve(fixture, PlanInput{Target: "sd", Quantity: 1})
	if err != nil {
		t.Fatalf("resolving without economy data: %v", err)
	}
	if len(g.Nodes) == 0 {
		t.Fatal("resolved an empty graph")
	}

	// And grouping with no assignment at all is valid — every leaf simply
	// lands unassigned.
	grouping, err := GroupLeaves(g, RollupInput{})
	if err != nil {
		t.Fatalf("GroupLeaves with no configuration: %v", err)
	}
	if len(grouping.Groups) != 1 || !grouping.Groups[0].IsUnassigned() {
		t.Errorf("groups = %+v, want one unassigned group", grouping.Groups)
	}
}

// SPEC-0001 REQ "Error Handling Standards" — Scenario "Missing constant is
// distinguishable":
// WHEN a Tier 2 constant required by a producer calculation is absent
// THEN the engine returns an error matching the missing-constant sentinel,
// naming the constant.
//
// One case per kind of absence the stages can meet, because the sentinel's
// value is the distinction it draws: each of these is the caller or the
// artifact failing to supply a figure, and none of them is the artifact
// being structurally wrong. A test per site is what stops the next one
// added from quietly reaching for ErrInvalidArtifact again.
func TestAbsentTier2ConstantMatchesTheMissingConstantSentinel(t *testing.T) {
	const econ = `{
	  "parts":[
	    {"id":"U_EXTRACTOR_S","primary":{"network":"resources","rate":0,"storage":360000},"hotspot":"Mineral"},
	    {"id":"U_SILO_S","primary":{"network":"resources","rate":0,"storage":0}},
	    {"id":"U_GENERATOR_S","primary":{"network":"power","rate":0},"hotspot":"Power"},
	    {"id":"U_SOLAR_S","primary":{"network":"power","rate":0}}
	  ],
	  "hotspots":[
	    {"category":"Mineral","strengths":{"c":1,"b":1,"a":2,"s":2.5},"weightings":{"c":1,"b":1,"a":1,"s":1}},
	    {"category":"Power","strengths":{"c":150,"b":220,"a":250,"s":300},"weightings":{"c":1,"b":1,"a":1,"s":1}}
	  ],
	  "crops":[{"id":"PLANT_Z","substance":"crop_z","yield":{"min":0,"max":0},"growth_seconds":60}]
	}`
	a1 := producerArtifact(t, econ, `{"id":"crop_z","name":"Crop Z","raw_obtainable":true,"default_method":"raw"}`)

	for _, tc := range []struct {
		name  string
		names string
		run   func(*Constants) error
	}{
		{
			name:  "curated scalar not supplied",
			names: "panels per battery",
			run: func(*Constants) error {
				_, err := NewConstants(a1, Curated{
					BiodomeCropSlots: 16, FaunaYieldPerCycle: 12, FaunaCycleSeconds: 1800,
					StepsPerProcessor: 2, DepotThreshold: 1000, ProcessSeconds: 30,
				})
				return err
			},
		},
		{
			name:  "no hotspot category configured for a resource",
			names: "gas_a",
			run: func(c *Constants) error {
				_, err := c.ExtractorRate("gas_a", ClassB)
				return err
			},
		},
		{
			name:  "part states no extraction rate",
			names: PartExtractorMineral,
			run: func(c *Constants) error {
				_, err := c.ExtractorRate("crop_z", ClassB)
				return err
			},
		},
		{
			name:  "depot states no storage buffer",
			names: PartSupplyDepot,
			run: func(c *Constants) error {
				_, err := c.DepotCapacity()
				return err
			},
		},
		{
			name:  "generator states no output",
			names: PartGenerator,
			run: func(c *Constants) error {
				_, err := ComputePower(c, PowerInput{
					Config: map[BaseID]PowerConfig{"a": {EMGenerators: 1, EMClass: ClassB}},
				})
				return err
			},
		},
		{
			name:  "crop states no yield",
			names: "PLANT_Z",
			run: func(c *Constants) error {
				_, err := RollupProducers(
					demandOf("a", SiteConfig{ExtractorClass: ClassB, FillSeconds: 3600},
						map[string]int64{"crop_z": 10}),
					a1, c, ProducerInput{})
				return err
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			curated := baseCurated()
			curated.ResourceHotspots = map[string]string{"crop_z": "Mineral"}
			c := constantsFor(t, a1, curated)

			err := tc.run(c)
			if err == nil {
				t.Fatal("no error for an absent Tier 2 constant")
			}
			if !errors.Is(err, ErrMissingConstant) {
				t.Errorf("error = %v, want ErrMissingConstant", err)
			}
			if errors.Is(err, ErrInvalidArtifact) {
				t.Errorf("error also matches ErrInvalidArtifact, which erases the distinction: %v", err)
			}
			if !strings.Contains(err.Error(), tc.names) {
				t.Errorf("error %q does not name the constant at fault (%q)", err, tc.names)
			}
		})
	}
}
