package domain

import (
	"math/big"
	"strings"
	"testing"
)

// Synthetic constants, per SPEC-0001 design.md: "Injection also makes every
// producer and power scenario testable with small synthetic constant sets
// rather than the full production dataset." Every number below is the one
// the scenario names.
func producerArtifact(t *testing.T, economy string, extra ...string) *Tier1 {
	t.Helper()
	items := `{"id":"crop_a","name":"Crop A","raw_obtainable":true,"default_method":"raw"},
	          {"id":"gas_a","name":"Gas A","raw_obtainable":true,"default_method":"raw"},
	          {"id":"gas_b","name":"Gas B","raw_obtainable":true,"default_method":"raw"},
	          {"id":"milk","name":"Wild Milk","raw_obtainable":true,"default_method":"raw"},
	          {"id":"egg","name":"Proto-Egg","raw_obtainable":true,"default_method":"raw"},
	          {"id":"target","name":"Target","default_method":"raw","raw_obtainable":true}`
	for _, e := range extra {
		items += ",\n" + e
	}
	src := `{"schema_version":2,"game_version":"test-producer",
	  "items":[` + items + `],
	  "recipes":[],
	  "economy":` + economy + `}`
	a1, err := LoadTier1(strings.NewReader(src))
	if err != nil {
		t.Fatalf("loading artifact: %v", err)
	}
	return a1
}

// economyFor builds an economy section with the parts and hotspots the
// scenarios need.
func economyFor(cropYield, cropGrowth, extractorRate, depotCapacity int64) string {
	return `{
	  "parts":[
	    {"id":"U_EXTRACTOR_S","primary":{"network":"resources","rate":` + itoa(extractorRate) + `,"storage":360000},"hotspot":"Mineral"},
	    {"id":"U_GASEXTRACTOR","primary":{"network":"resources","rate":` + itoa(extractorRate) + `,"storage":360000},"hotspot":"Gas"},
	    {"id":"U_SILO_S","primary":{"network":"resources","rate":0,"storage":` + itoa(depotCapacity) + `}},
	    {"id":"U_BATTERY_S","primary":{"network":"power","rate":0,"storage":45000}}
	  ],
	  "hotspots":[
	    {"category":"Gas","strengths":{"c":1,"b":1,"a":2,"s":2.5},"weightings":{"c":1,"b":1,"a":1,"s":1}},
	    {"category":"Mineral","strengths":{"c":1,"b":1,"a":2,"s":2.5},"weightings":{"c":1,"b":1,"a":1,"s":1}}
	  ],
	  "crops":[{"id":"PLANT_A","substance":"crop_a","yield":{"min":` + itoa(cropYield) + `,"max":` + itoa(cropYield) + `},"growth_seconds":` + itoa(cropGrowth) + `}]
	}`
}

func itoa(v int64) string { return new(big.Int).SetInt64(v).String() }

// demandOf builds a grouping directly, so producer tests exercise sizing
// rather than re-deriving a graph.
func demandOf(base BaseID, site SiteConfig, demands map[string]int64) *Grouping {
	group := &BaseGroup{Base: base, Site: site}
	for id, qty := range demands {
		group.Demands = append(group.Demands, LeafDemand{
			ItemID: id, Name: id, Verified: true,
			total: new(big.Rat).SetInt64(qty),
		})
	}
	sortDemands(group)
	return &Grouping{Groups: []BaseGroup{*group}, byBase: map[BaseID]*BaseGroup{base: group}}
}

func sortDemands(g *BaseGroup) {
	for i := 1; i < len(g.Demands); i++ {
		for j := i; j > 0 && g.Demands[j].ItemID < g.Demands[j-1].ItemID; j-- {
			g.Demands[j], g.Demands[j-1] = g.Demands[j-1], g.Demands[j]
		}
	}
}

func constantsFor(t *testing.T, a1 *Tier1, curated Curated) *Constants {
	t.Helper()
	c, err := NewConstants(a1, curated)
	if err != nil {
		t.Fatalf("NewConstants: %v", err)
	}
	return c
}

func baseCurated() Curated {
	return Curated{
		BiodomeCropSlots: 16, FaunaYieldPerCycle: 12, FaunaCycleSeconds: 1800,
		StepsPerProcessor: 2, DepotThreshold: 1000, ProcessSeconds: 30,
		FaunaProducts:    map[string]bool{"milk": true, "egg": true},
		ResourceHotspots: map[string]string{"gas_a": "Gas", "gas_b": "Gas"},
	}
}

func build(t *testing.T, g *Grouping, a1 *Tier1, c *Constants, in ProducerInput) *Build {
	t.Helper()
	b, err := RollupProducers(g, a1, c, in)
	if err != nil {
		t.Fatalf("RollupProducers: %v", err)
	}
	return b
}

// SPEC-0001 REQ "Producer Rollup":
// WHEN a base is assigned a crop requiring 200 units at a yield of 25 per
// plant and a dome capacity of 16 THEN the engine reports 8 plants and 1
// biodome for that crop.
func TestFarmRollup(t *testing.T) {
	a1 := producerArtifact(t, economyFor(25, 3600, 100, 1000))
	c := constantsFor(t, a1, baseCurated())

	b := build(t, demandOf("alpha", SiteConfig{ExtractorClass: ClassB, FillSeconds: 5400},
		map[string]int64{"crop_a": 200}), a1, c, ProducerInput{})

	base, ok := b.Base("alpha")
	if !ok {
		t.Fatal("alpha missing")
	}
	if len(base.Farms) != 1 {
		t.Fatalf("farms = %d, want 1", len(base.Farms))
	}
	row := base.Farms[0]
	if row.Plants != 8 {
		t.Errorf("plants = %d, want 8", row.Plants)
	}
	if row.Biodomes != 1 {
		t.Errorf("biodomes = %d, want 1", row.Biodomes)
	}
	if row.GrowthSeconds != 3600 {
		t.Errorf("growth = %d, want 3600", row.GrowthSeconds)
	}
}

// SPEC-0001 REQ "Exact Arithmetic and Rounding Discipline":
// WHEN a crop requires 250 units at a yield of 32 per plant THEN 8 plants,
// not 7.8125 — and domes round up from plants, so 17 plants at capacity 16
// is 2 domes.
func TestPlantsAndDomesRoundUp(t *testing.T) {
	a1 := producerArtifact(t, economyFor(32, 3600, 100, 1000))
	c := constantsFor(t, a1, baseCurated())

	b := build(t, demandOf("alpha", SiteConfig{ExtractorClass: ClassB, FillSeconds: 5400},
		map[string]int64{"crop_a": 250}), a1, c, ProducerInput{})
	base, _ := b.Base("alpha")
	if got := base.Farms[0].Plants; got != 8 {
		t.Errorf("plants = %d, want 8 (250/32 = 7.8125)", got)
	}

	// 17 plants at a capacity of 16 is two domes: the second rounding is
	// from plants, not from the requirement.
	a2 := producerArtifact(t, economyFor(1, 3600, 100, 1000))
	c2 := constantsFor(t, a2, baseCurated())
	b2 := build(t, demandOf("alpha", SiteConfig{ExtractorClass: ClassB, FillSeconds: 5400},
		map[string]int64{"crop_a": 17}), a2, c2, ProducerInput{})
	base2, _ := b2.Base("alpha")
	if got := base2.Farms[0].Plants; got != 17 {
		t.Fatalf("plants = %d, want 17", got)
	}
	if got := base2.Farms[0].Biodomes; got != 2 {
		t.Errorf("biodomes = %d, want 2", got)
	}
}

// SPEC-0001 REQ "Producer Rollup":
// WHEN a base is assigned a gas requiring 500 units, with a class-B rate of
// 200 per hour and a target fill duration of 1.5 hours THEN 2 extractors and
// the resulting fill time.
func TestExtractorSizedToFillDuration(t *testing.T) {
	// The scenario says 200 units per hour over 1.5 hours. Rate and window
	// are expressed in the same unit here, so the identical ratio with
	// integer inputs is a rate of 100 over a window of 3: 100 x 3 = 300
	// per extractor either way.
	a1 := producerArtifact(t, economyFor(25, 3600, 100, 1000))
	c := constantsFor(t, a1, baseCurated())

	b := build(t, demandOf("alpha", SiteConfig{ExtractorClass: ClassB, FillSeconds: 3},
		map[string]int64{"gas_a": 500}), a1, c, ProducerInput{})
	base, _ := b.Base("alpha")
	if len(base.Extractors) != 1 {
		t.Fatalf("extractor rows = %d, want 1", len(base.Extractors))
	}
	row := base.Extractors[0]

	if row.Extractors != 2 {
		t.Errorf("extractors = %d, want 2 (500 / (100 x 3) = 1.67)", row.Extractors)
	}
	// The resulting fill time, which is shorter than the 3 asked for
	// because the count rounded up: 500 / (100 x 2) = 5/2.
	if got := row.FillSeconds().RatString(); got != "5/2" {
		t.Errorf("fill time = %s, want 5/2", got)
	}
	if got := row.RatePerSecond().RatString(); got != "100" {
		t.Errorf("rate = %s, want 100 at class B in this economy", got)
	}
	if row.Class != ClassB {
		t.Errorf("row class = %q, want B", row.Class)
	}

	// A site with no configured window cannot size anything, and says so.
	_, err := RollupProducers(demandOf("beta", SiteConfig{ExtractorClass: ClassB},
		map[string]int64{"gas_a": 500}), a1, c, ProducerInput{})
	if err == nil {
		t.Fatal("an unconfigured fill window sized extractors anyway")
	}
	if !strings.Contains(err.Error(), "fill duration") {
		t.Errorf("error %q does not name the missing window", err)
	}
}

// SPEC-0001 REQ "Producer Rollup":
// WHEN the extractor class at a base changes from B to S THEN every
// extractor row at that base recomputes, and no other base is affected.
func TestSiteClassAppliesToAllRowsAndOnlyThatBase(t *testing.T) {
	a1 := producerArtifact(t, economyFor(25, 3600, 100, 1000))
	c := constantsFor(t, a1, baseCurated())

	// Two bases, two extractor rows each.
	grouping := func(alphaClass HotspotClass) *Grouping {
		alpha := &BaseGroup{Base: "alpha", Site: SiteConfig{ExtractorClass: alphaClass, FillSeconds: 1}}
		beta := &BaseGroup{Base: "beta", Site: SiteConfig{ExtractorClass: ClassB, FillSeconds: 1}}
		for _, id := range []string{"gas_a", "gas_b"} {
			alpha.Demands = append(alpha.Demands, LeafDemand{ItemID: id, Name: id, total: new(big.Rat).SetInt64(500)})
			beta.Demands = append(beta.Demands, LeafDemand{ItemID: id, Name: id, total: new(big.Rat).SetInt64(500)})
		}
		return &Grouping{
			Groups: []BaseGroup{*alpha, *beta},
			byBase: map[BaseID]*BaseGroup{"alpha": alpha, "beta": beta},
		}
	}

	atB := build(t, grouping(ClassB), a1, c, ProducerInput{})
	atS := build(t, grouping(ClassS), a1, c, ProducerInput{})

	alphaB, _ := atB.Base("alpha")
	alphaS, _ := atS.Base("alpha")
	if len(alphaB.Extractors) != 2 || len(alphaS.Extractors) != 2 {
		t.Fatalf("alpha rows = %d and %d, want 2 each", len(alphaB.Extractors), len(alphaS.Extractors))
	}
	// Every row at the base recomputes, not just the first.
	for i := range alphaB.Extractors {
		if alphaS.Extractors[i].Extractors >= alphaB.Extractors[i].Extractors {
			t.Errorf("row %s did not recompute: B needed %d, S needs %d",
				alphaB.Extractors[i].ItemID, alphaB.Extractors[i].Extractors, alphaS.Extractors[i].Extractors)
		}
		if alphaS.Extractors[i].Class != ClassS {
			t.Errorf("row %s reports class %q, want S", alphaS.Extractors[i].ItemID, alphaS.Extractors[i].Class)
		}
	}

	// And no other base moved.
	betaB, _ := atB.Base("beta")
	betaS, _ := atS.Base("beta")
	for i := range betaB.Extractors {
		if betaB.Extractors[i].Extractors != betaS.Extractors[i].Extractors {
			t.Errorf("beta row %s changed when alpha's class did", betaB.Extractors[i].ItemID)
		}
		if betaS.Extractors[i].Class != ClassB {
			t.Errorf("beta row %s class = %q, want B", betaS.Extractors[i].ItemID, betaS.Extractors[i].Class)
		}
	}
}

// SPEC-0001 REQ "Producer Rollup":
// WHEN a resource requires 2500 units at a depot threshold of 1000 and a
// capacity of 1000 THEN 3 supply depots; at 800 units THEN none.
func TestSupplyDepotsAroundTheThreshold(t *testing.T) {
	a1 := producerArtifact(t, economyFor(25, 3600, 100, 1000))
	c := constantsFor(t, a1, baseCurated()) // threshold 1000, capacity 1000

	for _, tc := range []struct {
		required int64
		depots   int64
	}{
		{2500, 3}, // ceil(2500/1000)
		{800, 0},  // below the threshold
		{1000, 0}, // at the threshold, not above it
		{1001, 2}, // just above: ceil(1001/1000)
	} {
		b := build(t, demandOf("alpha", SiteConfig{ExtractorClass: ClassB, FillSeconds: 3600},
			map[string]int64{"gas_a": tc.required}), a1, c, ProducerInput{})
		base, _ := b.Base("alpha")
		if got := base.Extractors[0].Depots; got != tc.depots {
			t.Errorf("%d units: depots = %d, want %d", tc.required, got, tc.depots)
		}
	}
}

// SPEC-0001 REQ "Producer Rollup":
// WHEN a base is assigned a fauna product requiring 100 units at a yield of
// 12 per creature per cycle THEN 9 fauna, together with the cycle time.
func TestRanchRollup(t *testing.T) {
	a1 := producerArtifact(t, economyFor(25, 3600, 100, 1000))
	c := constantsFor(t, a1, baseCurated())

	b := build(t, demandOf("alpha", SiteConfig{ExtractorClass: ClassB, FillSeconds: 3600},
		map[string]int64{"milk": 100}), a1, c, ProducerInput{})
	base, _ := b.Base("alpha")
	if len(base.Ranches) != 1 {
		t.Fatalf("ranch rows = %d, want 1", len(base.Ranches))
	}
	if got := base.Ranches[0].Fauna; got != 9 {
		t.Errorf("fauna = %d, want 9 (100/12 = 8.33)", got)
	}
	if got := base.Ranches[0].CycleSeconds; got != 1800 {
		t.Errorf("cycle = %d, want 1800", got)
	}
}

// SPEC-0001 REQ "Producer Rollup":
// WHEN a base is assigned two distinct fauna products that both require
// feeding THEN 1 pellet feeder for that base, not one per row.
//
// The trap: a per-row implementation reports 2 here and passes every
// single-row test.
func TestFeederIsReportedOncePerBase(t *testing.T) {
	a1 := producerArtifact(t, economyFor(25, 3600, 100, 1000))
	c := constantsFor(t, a1, baseCurated())

	b := build(t, demandOf("alpha", SiteConfig{ExtractorClass: ClassB, FillSeconds: 3600},
		map[string]int64{"milk": 100, "egg": 60}), a1, c, ProducerInput{})
	base, _ := b.Base("alpha")

	if len(base.Ranches) != 2 {
		t.Fatalf("ranch rows = %d, want 2 — the scenario needs both", len(base.Ranches))
	}
	if base.PelletFeeders != 1 {
		t.Errorf("feeders = %d, want 1 for two fed products", base.PelletFeeders)
	}
	// A base with no fauna builds no feeder.
	b = build(t, demandOf("beta", SiteConfig{ExtractorClass: ClassB, FillSeconds: 3600},
		map[string]int64{"gas_a": 500}), a1, c, ProducerInput{})
	beta, _ := b.Base("beta")
	if beta.PelletFeeders != 0 {
		t.Errorf("a base with no fauna reports %d feeders", beta.PelletFeeders)
	}
}

// SPEC-0001 REQ "Producer Rollup":
// WHEN a base carries 4 nutrient processor steps at 2 steps per processor
// THEN 2 processors once for that base, not a count on each of the 4 rows.
//
// The trap: summing per-row ceilings gives 4, since ceil(1/2) is 1 four
// times over. The two answers differ whenever a base has more than one step.
func TestKitchenSizesProcessorsPerBase(t *testing.T) {
	// No crops: this artifact defines no crop_a, so an economy referencing
	// one would dangle. Validate checks that, which is the point.
	const kitchenEconomy = `{
	  "parts":[
	    {"id":"U_EXTRACTOR_S","primary":{"network":"resources","rate":100,"storage":360000},"hotspot":"Mineral"},
	    {"id":"U_GASEXTRACTOR","primary":{"network":"resources","rate":100,"storage":360000},"hotspot":"Gas"},
	    {"id":"U_SILO_S","primary":{"network":"resources","rate":0,"storage":1000}},
	    {"id":"U_BATTERY_S","primary":{"network":"power","rate":0,"storage":45000}}
	  ],
	  "hotspots":[
	    {"category":"Gas","strengths":{"c":1,"b":1,"a":2,"s":2.5},"weightings":{"c":1,"b":1,"a":1,"s":1}},
	    {"category":"Mineral","strengths":{"c":1,"b":1,"a":2,"s":2.5},"weightings":{"c":1,"b":1,"a":1,"s":1}}
	  ]
	}`

	const recipes = `{"id":"flour_cook","output":"flour","method":"cook","inputs":[{"item":"wheat","quantity":5}]},
	                 {"id":"butter_cook","output":"butter","method":"cook","inputs":[{"item":"milk","quantity":4}]},
	                 {"id":"batter_cook","output":"batter","method":"cook","inputs":[{"item":"flour","quantity":2},{"item":"egg","quantity":3}],"yield":2},
	                 {"id":"cake_cook","output":"cake","method":"cook","inputs":[{"item":"batter","quantity":1},{"item":"butter","quantity":1}]}`
	src := `{"schema_version":2,"game_version":"test-kitchen",
	  "items":[
	    {"id":"wheat","name":"Wheat","raw_obtainable":true,"default_method":"raw"},
	    {"id":"milk","name":"Wild Milk","raw_obtainable":true,"default_method":"raw"},
	    {"id":"egg","name":"Proto-Egg","raw_obtainable":true,"default_method":"raw"},
	    {"id":"flour","name":"Flour","default_method":"cook"},
	    {"id":"butter","name":"Butter","default_method":"cook"},
	    {"id":"batter","name":"Batter","default_method":"cook"},
	    {"id":"cake","name":"Cake","default_method":"cook"}
	  ],
	  "recipes":[` + recipes + `],
	  "economy":` + kitchenEconomy + `}`
	a1, err := LoadTier1(strings.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	c := constantsFor(t, a1, baseCurated())

	in := ProducerInput{Kitchen: map[BaseID][]KitchenStepInput{
		"alpha": {
			{ItemID: "flour", Recipe: "flour_cook", Quantity: 10},
			{ItemID: "butter", Recipe: "butter_cook", Quantity: 5},
			{ItemID: "batter", Recipe: "batter_cook", Quantity: 5},
			{ItemID: "cake", Recipe: "cake_cook", Quantity: 5},
		},
	}}
	b := build(t, demandOf("alpha", SiteConfig{ExtractorClass: ClassB, FillSeconds: 3600},
		map[string]int64{"milk": 20}), a1, c, in)
	base, _ := b.Base("alpha")

	if len(base.Kitchen) != 4 {
		t.Fatalf("kitchen steps = %d, want 4", len(base.Kitchen))
	}
	if base.NutrientProcessors != 2 {
		t.Errorf("processors = %d, want 2 — ceil(4/2), not the sum of per-row ceilings (4)",
			base.NutrientProcessors)
	}

	// WHEN a base's kitchen steps include the one producing the plan target
	// THEN that step is final and the rest are intermediate.
	var finals int
	for _, step := range base.Kitchen {
		if step.Final {
			finals++
			if step.ItemID != "cake" {
				t.Errorf("final step is %q, want cake", step.ItemID)
			}
		}
	}
	if finals != 1 {
		t.Errorf("%d steps marked final, want exactly 1", finals)
	}

	// Each step reports its input-to-output ratio and duration. Batter
	// yields 2, so 2 flour per batch is 1 per unit of output.
	var batter *KitchenStep
	for i := range base.Kitchen {
		if base.Kitchen[i].ItemID == "batter" {
			batter = &base.Kitchen[i]
		}
	}
	if batter == nil {
		t.Fatal("batter step missing")
	}
	ratios := map[string]string{}
	for _, in := range batter.Inputs {
		ratios[in.ItemID] = in.PerOutput().RatString()
	}
	if ratios["flour"] != "1" {
		t.Errorf("flour per batter = %s, want 1 (2 per batch at yield 2)", ratios["flour"])
	}
	if ratios["egg"] != "3/2" {
		t.Errorf("egg per batter = %s, want 3/2", ratios["egg"])
	}
	if batter.ProcessSeconds != 30 {
		t.Errorf("process seconds = %d, want the curated 30", batter.ProcessSeconds)
	}
}

// A base with an odd number of steps still sizes from the total.
func TestProcessorsRoundUpFromTheTotal(t *testing.T) {
	// 5 steps at 2 per processor is 3, and it is ceil(5/2) rather than
	// 5 × ceil(1/2).
	if got := ceilRat(big.NewRat(5, 2)); got != 3 {
		t.Errorf("ceil(5/2) = %d, want 3", got)
	}
	if got := ceilRat(big.NewRat(4, 2)); got != 2 {
		t.Errorf("ceil(4/2) = %d, want 2", got)
	}
}

// SPEC-0001 REQ "Producer Rollup":
// WHEN a base's Condensed Carbon demand is met by the byproduct of gas
// refining at that same base THEN it requires no construction, with no
// producer count and no power draw.
func TestByproductRequiresNoConstruction(t *testing.T) {
	a1 := producerArtifact(t, economyFor(25, 3600, 100, 1000))
	c := constantsFor(t, a1, baseCurated())

	in := ProducerInput{Byproducts: map[BaseID][]ByproductSource{
		"alpha": {{Item: "gas_b", From: "gas_a refining"}},
	}}
	b := build(t, demandOf("alpha", SiteConfig{ExtractorClass: ClassB, FillSeconds: 3600},
		map[string]int64{"gas_a": 500, "gas_b": 300}), a1, c, in)
	base, _ := b.Base("alpha")

	// No row of any kind for the covered item.
	for _, row := range base.Extractors {
		if row.ItemID == "gas_b" {
			t.Errorf("gas_b got an extractor row with %d extractors", row.Extractors)
		}
	}
	if len(base.Extractors) != 1 {
		t.Errorf("extractor rows = %d, want 1 — only the uncovered item", len(base.Extractors))
	}

	// It is reported, not dropped, and it carries its full demand.
	if len(base.NoBuild) != 1 {
		t.Fatalf("no-build entries = %d, want 1", len(base.NoBuild))
	}
	nb := base.NoBuild[0]
	if nb.ItemID != "gas_b" || nb.From != "gas_a refining" {
		t.Errorf("no-build entry = %+v, want gas_b from gas_a refining", nb)
	}
	if got := nb.Required().RatString(); got != "300" {
		t.Errorf("no-build requirement = %s, want 300", got)
	}
}

// The unassigned group has no site, so it produces no construction
// instructions — it stays a list of things the plan has not placed.
func TestUnassignedGroupBuildsNothing(t *testing.T) {
	a1 := producerArtifact(t, economyFor(25, 3600, 100, 1000))
	c := constantsFor(t, a1, baseCurated())

	un := &BaseGroup{Base: Unassigned}
	un.Demands = append(un.Demands, LeafDemand{ItemID: "gas_a", Name: "Gas A", total: new(big.Rat).SetInt64(500)})
	g := &Grouping{Groups: []BaseGroup{*un}, byBase: map[BaseID]*BaseGroup{Unassigned: un}}

	b := build(t, g, a1, c, ProducerInput{})
	if len(b.Bases) != 0 {
		t.Errorf("unassigned leaves produced %d base builds, want none", len(b.Bases))
	}
}

// Nothing in the rollup hardcodes an economy value: changing a constant
// changes the answer.
//
// Governing: SPEC-0001 REQ "Producer Rollup" — "Producer counts MUST derive
// from constants supplied at call time and MUST NOT be hardcoded."
func TestNoConstantIsHardcoded(t *testing.T) {
	cases := []struct {
		name    string
		economy string
		curated Curated
		check   func(*testing.T, BaseBuild)
	}{
		{
			name:    "crop yield",
			economy: economyFor(50, 3600, 100, 1000),
			curated: baseCurated(),
			check: func(t *testing.T, b BaseBuild) {
				if b.Farms[0].Plants != 4 { // 200/50
					t.Errorf("plants = %d, want 4 at a yield of 50", b.Farms[0].Plants)
				}
			},
		},
		{
			name:    "dome capacity",
			economy: economyFor(1, 3600, 100, 1000),
			curated: func() Curated { c := baseCurated(); c.BiodomeCropSlots = 100; return c }(),
			check: func(t *testing.T, b BaseBuild) {
				if b.Farms[0].Biodomes != 2 { // 200 plants at 100 per dome
					t.Errorf("biodomes = %d, want 2 at a capacity of 100", b.Farms[0].Biodomes)
				}
			},
		},
		{
			name:    "depot capacity",
			economy: economyFor(25, 3600, 100, 250),
			curated: baseCurated(),
			check: func(t *testing.T, b BaseBuild) {
				if b.Extractors[0].Depots != 8 { // ceil(2000/250)
					t.Errorf("depots = %d, want 8 at a capacity of 250", b.Extractors[0].Depots)
				}
			},
		},
		{
			name:    "fauna yield",
			economy: economyFor(25, 3600, 100, 1000),
			curated: func() Curated { c := baseCurated(); c.FaunaYieldPerCycle = 50; return c }(),
			check: func(t *testing.T, b BaseBuild) {
				if b.Ranches[0].Fauna != 2 { // ceil(100/50)
					t.Errorf("fauna = %d, want 2 at a yield of 50", b.Ranches[0].Fauna)
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a1 := producerArtifact(t, tc.economy)
			c := constantsFor(t, a1, tc.curated)
			b := build(t, demandOf("alpha", SiteConfig{ExtractorClass: ClassB, FillSeconds: 3600},
				map[string]int64{"crop_a": 200, "gas_a": 2000, "milk": 100}), a1, c, ProducerInput{})
			base, _ := b.Base("alpha")
			tc.check(t, base)
		})
	}
}

// A resource with no configured hotspot category cannot be sized, and says
// so rather than defaulting to Mineral.
func TestUnclassifiedResourceIsRefused(t *testing.T) {
	a1 := producerArtifact(t, economyFor(25, 3600, 100, 1000))
	curated := baseCurated()
	delete(curated.ResourceHotspots, "gas_a")
	c := constantsFor(t, a1, curated)

	_, err := RollupProducers(demandOf("alpha", SiteConfig{ExtractorClass: ClassB, FillSeconds: 3600},
		map[string]int64{"gas_a": 500}), a1, c, ProducerInput{})
	if err == nil {
		t.Fatal("an unclassified resource was sized anyway")
	}
	if !strings.Contains(err.Error(), "gas_a") || !strings.Contains(err.Error(), "hotspot category") {
		t.Errorf("error %q does not name the item and what is missing", err)
	}
}
