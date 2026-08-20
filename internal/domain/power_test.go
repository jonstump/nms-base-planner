package domain

import (
	"strings"
	"testing"
)

// A synthetic economy whose Power hotspot strengths are the scenario's
// numbers: a class-B base output of 110 kPs and a class-A multiplier of 1.5
// is a class-A output of 165.
//
// The artifact states absolute per-class outputs rather than a base and a
// multiplier, which is the same model expressed once instead of twice.
const powerEconomy = `{
  "parts":[
    {"id":"U_SOLAR_S","primary":{"network":"power","rate":50}},
    {"id":"U_BATTERY_S","primary":{"network":"power","rate":0,"storage":45000}},
    {"id":"U_GENERATOR_S","primary":{"network":"power","rate":1},"hotspot":"Power"},
    {"id":"U_EXTRACTOR_S","primary":{"network":"resources","rate":100,"storage":360000},
     "dependencies":[{"network":"power","rate":-55,"effect":"EnablesRate"}],"hotspot":"Mineral"},
    {"id":"BIOROOM","primary":{"network":"power","rate":-20}},
    {"id":"U_SILO_S","primary":{"network":"resources","rate":0,"storage":1000}}
  ],
  "hotspots":[
    {"category":"Power","strengths":{"c":55,"b":110,"a":165,"s":220},"weightings":{"c":1,"b":1,"a":1,"s":1}},
    {"category":"Mineral","strengths":{"c":1,"b":1.5,"a":2,"s":2.5},"weightings":{"c":1,"b":1,"a":1,"s":1}}
  ]
}`

func powerConstants(t *testing.T) *Constants {
	t.Helper()
	src := `{"schema_version":2,"game_version":"test-power",
	  "items":[{"id":"x","name":"X","raw_obtainable":true,"default_method":"raw"}],
	  "recipes":[],"economy":` + powerEconomy + `}`
	a1, err := LoadTier1(strings.NewReader(src))
	if err != nil {
		t.Fatalf("loading artifact: %v", err)
	}
	c, err := NewConstants(a1, Curated{
		BiodomeCropSlots: 16, FaunaYieldPerCycle: 12, FaunaCycleSeconds: 1800,
		StepsPerProcessor: 2, DepotThreshold: 1000, PanelsPerBattery: 2,
	})
	if err != nil {
		t.Fatalf("NewConstants: %v", err)
	}
	return c
}

func budgetFor(t *testing.T, c *Constants, in PowerInput, base BaseID) PowerBudget {
	t.Helper()
	budgets, err := ComputePower(c, in)
	if err != nil {
		t.Fatalf("ComputePower: %v", err)
	}
	for _, b := range budgets {
		if b.Base == base {
			return b
		}
	}
	t.Fatalf("base %q missing from %d budgets", base, len(budgets))
	return PowerBudget{}
}

// SPEC-0001 REQ "Power Computation":
// WHEN a base has 3 electromagnetic generators at class A, with a class-B
// base output of 110 kPs and a class-A multiplier of 1.5
// THEN the engine reports 495 kPs of generation.
func TestEMGenerationByClass(t *testing.T) {
	c := powerConstants(t)

	b := budgetFor(t, c, PowerInput{
		Config: map[BaseID]PowerConfig{"alpha": {EMGenerators: 3, EMClass: ClassA}},
	}, "alpha")

	if got := b.Generation().RatString(); got != "495" {
		t.Errorf("generation = %s, want 495 (3 x 165)", got)
	}
	if got := b.PerGenerator().RatString(); got != "165" {
		t.Errorf("per generator = %s, want 165", got)
	}

	// The class is what moves it: the same three generators at B produce
	// 330, which is the other scenario's starting position.
	atB := budgetFor(t, c, PowerInput{
		Config: map[BaseID]PowerConfig{"alpha": {EMGenerators: 3, EMClass: ClassB}},
	}, "alpha")
	if got := atB.Generation().RatString(); got != "330" {
		t.Errorf("generation at B = %s, want 330", got)
	}
}

// SPEC-0001 REQ "Power Computation":
// WHEN a base is powered by 5 solar panels at a ratio of 1 battery per 2
// panels THEN the engine reports 3 batteries as required.
func TestSolarRequiresBatteries(t *testing.T) {
	c := powerConstants(t)

	b := budgetFor(t, c, PowerInput{
		Config: map[BaseID]PowerConfig{"alpha": {SolarPanels: 5}},
	}, "alpha")

	if b.Batteries != 3 {
		t.Errorf("batteries = %d, want 3 (ceil(5/2))", b.Batteries)
	}
	// Solar is classless: the panel's own rate is the output, with no
	// hotspot strength applied.
	if got := b.Generation().RatString(); got != "250" {
		t.Errorf("generation = %s, want 250 (5 x 50)", got)
	}
	// And a base with no panels needs no batteries.
	none := budgetFor(t, c, PowerInput{
		Config: map[BaseID]PowerConfig{"beta": {EMGenerators: 1, EMClass: ClassB}},
	}, "beta")
	if none.Batteries != 0 {
		t.Errorf("a base with no panels reports %d batteries", none.Batteries)
	}
}

// SPEC-0001 REQ "Power Computation":
// WHEN a base draws 400 kPs against 330 kPs of generation from class-B
// generators producing 110 each THEN a deficit of 70 kPs and 1 additional
// generator clears it.
func TestDeficitReportsTheFix(t *testing.T) {
	c := powerConstants(t)

	// Draw of 400: 4 extractors at 55 plus 9 biodomes at 20 is 220 + 180.
	b := budgetFor(t, c, PowerInput{
		Config: map[BaseID]PowerConfig{"alpha": {EMGenerators: 3, EMClass: ClassB}},
		Draws: map[BaseID][]PowerUnit{"alpha": {
			{PartID: "U_EXTRACTOR_S", Count: 4},
			{PartID: "BIOROOM", Count: 9},
		}},
	}, "alpha")

	if got := b.Draw().RatString(); got != "400" {
		t.Fatalf("draw = %s, want 400", got)
	}
	if got := b.Generation().RatString(); got != "330" {
		t.Fatalf("generation = %s, want 330", got)
	}
	if !b.InDeficit() {
		t.Fatal("the base is not reported as in deficit")
	}
	if got := b.Deficit().RatString(); got != "70" {
		t.Errorf("deficit = %s, want 70", got)
	}
	if b.AdditionalGenerators != 1 {
		t.Errorf("additional generators = %d, want 1 (ceil(70/110))", b.AdditionalGenerators)
	}

	// A surplus reports no fix and no deficit.
	surplus := budgetFor(t, c, PowerInput{
		Config: map[BaseID]PowerConfig{"alpha": {EMGenerators: 4, EMClass: ClassB}},
		Draws:  map[BaseID][]PowerUnit{"alpha": {{PartID: "U_EXTRACTOR_S", Count: 4}}},
	}, "alpha")
	if surplus.InDeficit() {
		t.Errorf("a base at %s generation and %s draw reports a deficit",
			surplus.Generation().RatString(), surplus.Draw().RatString())
	}
	if surplus.AdditionalGenerators != 0 {
		t.Errorf("a base at surplus asks for %d more generators", surplus.AdditionalGenerators)
	}
	if got := surplus.Balance().RatString(); got != "220" {
		t.Errorf("balance = %s, want 220", got)
	}
}

// SPEC-0001 REQ "Power Computation":
// WHEN a base at surplus has its generator class downgraded such that
// generation falls below draw THEN a deficit and the required additional
// unit count.
func TestDowngradeReopensADeficit(t *testing.T) {
	c := powerConstants(t)

	draws := map[BaseID][]PowerUnit{"alpha": {{PartID: "U_EXTRACTOR_S", Count: 6}}} // 330

	atA := budgetFor(t, c, PowerInput{
		Config: map[BaseID]PowerConfig{"alpha": {EMGenerators: 3, EMClass: ClassA}},
		Draws:  draws,
	}, "alpha")
	if atA.InDeficit() {
		t.Fatalf("class A should cover it: generation %s against draw %s",
			atA.Generation().RatString(), atA.Draw().RatString())
	}

	// Downgrade A → C: 3 x 55 = 165 against a draw of 330.
	atC := budgetFor(t, c, PowerInput{
		Config: map[BaseID]PowerConfig{"alpha": {EMGenerators: 3, EMClass: ClassC}},
		Draws:  draws,
	}, "alpha")
	if !atC.InDeficit() {
		t.Fatal("the downgrade did not reopen the deficit")
	}
	if got := atC.Deficit().RatString(); got != "165" {
		t.Errorf("deficit = %s, want 165", got)
	}
	if atC.AdditionalGenerators != 3 {
		t.Errorf("additional generators = %d, want 3 (ceil(165/55))", atC.AdditionalGenerators)
	}
}

// Draw reads each part's power cost from the artifact — both a direct
// negative rate on the power network and a negative power dependency.
//
// A part like the biodome consumes directly rather than through a
// dependency, so reading only dependencies would report it as free.
func TestDrawReadsBothDirectAndDependentCosts(t *testing.T) {
	c := powerConstants(t)

	direct := budgetFor(t, c, PowerInput{
		Draws: map[BaseID][]PowerUnit{"alpha": {{PartID: "BIOROOM", Count: 3}}},
	}, "alpha")
	if got := direct.Draw().RatString(); got != "60" {
		t.Errorf("biodome draw = %s, want 60 (3 x 20, a direct negative rate)", got)
	}

	dependent := budgetFor(t, c, PowerInput{
		Draws: map[BaseID][]PowerUnit{"alpha": {{PartID: "U_EXTRACTOR_S", Count: 2}}},
	}, "alpha")
	if got := dependent.Draw().RatString(); got != "110" {
		t.Errorf("extractor draw = %s, want 110 (2 x 55, a power dependency)", got)
	}

	// A base with draw and no generation configured is still reportable:
	// the deficit is real, and only the fix has no size.
	if !direct.InDeficit() {
		t.Error("a base with draw and no generation is not reported as in deficit")
	}
	if !direct.FixUnsized {
		t.Error("the fix was sized despite no generator class being configured")
	}
	if direct.AdditionalGenerators != 0 {
		t.Errorf("additional generators = %d with no class configured", direct.AdditionalGenerators)
	}

	// A part that neither draws nor generates contributes nothing.
	free := budgetFor(t, c, PowerInput{
		Draws: map[BaseID][]PowerUnit{"alpha": {{PartID: "U_SILO_S", Count: 10}}},
	}, "alpha")
	if got := free.Draw().RatString(); got != "0" {
		t.Errorf("silo draw = %s, want 0", got)
	}
}

// SPEC-0001 REQ "Provenance Propagation" — a budget derived from anything
// unverified is marked unverified.
func TestPowerCarriesProvenance(t *testing.T) {
	c := powerConstants(t)

	in := PowerInput{
		Config:     map[BaseID]PowerConfig{"alpha": {EMGenerators: 1, EMClass: ClassB}, "beta": {EMGenerators: 1, EMClass: ClassB}},
		Unverified: map[BaseID]bool{"beta": true},
	}
	if b := budgetFor(t, c, in, "alpha"); !b.Verified {
		t.Error("alpha is marked unverified but nothing contributing to it is")
	}
	if b := budgetFor(t, c, in, "beta"); b.Verified {
		t.Error("beta is marked verified despite an unverified contributor")
	}
}

// SPEC-0001 REQ "Determinism" — repeated computation is stable, and bases
// come back in a defined order.
func TestPowerComputationIsDeterministic(t *testing.T) {
	c := powerConstants(t)
	in := PowerInput{
		Config: map[BaseID]PowerConfig{
			"gamma": {EMGenerators: 1, EMClass: ClassB},
			"alpha": {SolarPanels: 4},
			"beta":  {EMGenerators: 2, EMClass: ClassS},
		},
		Draws: map[BaseID][]PowerUnit{
			"alpha": {{PartID: "BIOROOM", Count: 2}},
			"beta":  {{PartID: "U_EXTRACTOR_S", Count: 1}},
		},
	}

	first, err := ComputePower(c, in)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 3 {
		t.Fatalf("budgets = %d, want 3", len(first))
	}
	for i := 1; i < len(first); i++ {
		if first[i-1].Base >= first[i].Base {
			t.Errorf("budgets are not sorted by base: %v then %v", first[i-1].Base, first[i].Base)
		}
	}
	for run := 0; run < 25; run++ {
		got, err := ComputePower(c, in)
		if err != nil {
			t.Fatal(err)
		}
		for i := range got {
			if got[i].Base != first[i].Base ||
				got[i].Generation().Cmp(first[i].Generation()) != 0 ||
				got[i].Draw().Cmp(first[i].Draw()) != 0 {
				t.Fatalf("run %d differs at index %d", run+2, i)
			}
		}
	}
}

// A deficit at a base with no generators still reports a fix, sized against
// the class the caller configured — which is what building the first
// generator there would produce.
func TestDeficitWithNoGeneratorsStillSizesTheFix(t *testing.T) {
	c := powerConstants(t)

	b := budgetFor(t, c, PowerInput{
		Config: map[BaseID]PowerConfig{"alpha": {EMClass: ClassB}},
		Draws:  map[BaseID][]PowerUnit{"alpha": {{PartID: "U_EXTRACTOR_S", Count: 4}}},
	}, "alpha")

	if got := b.Deficit().RatString(); got != "220" {
		t.Fatalf("deficit = %s, want 220", got)
	}
	if b.AdditionalGenerators != 2 {
		t.Errorf("additional generators = %d, want 2 (ceil(220/110))", b.AdditionalGenerators)
	}
}

// An unknown part fails naming itself rather than counting as free.
func TestUnknownPartIsRefused(t *testing.T) {
	c := powerConstants(t)

	_, err := ComputePower(c, PowerInput{
		Draws: map[BaseID][]PowerUnit{"alpha": {{PartID: "U_NOT_A_PART", Count: 1}}},
	})
	if err == nil {
		t.Fatal("an unknown part was counted as drawing nothing")
	}
	if !strings.Contains(err.Error(), "U_NOT_A_PART") || !strings.Contains(err.Error(), "alpha") {
		t.Errorf("error %q does not name the part and the base", err)
	}
}
