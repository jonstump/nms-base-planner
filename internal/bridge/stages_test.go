package bridge_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/jonstump/nms-base-planner/internal/bridge"
)

// A self-contained artifact carrying both a recipe graph and an economy
// section, so one module can serve all three stages.
//
// The domain fixtures cover stage 1 only — neither carries an economy
// section — and the generated artifact is not a test dependency. Building
// one here keeps the boundary's tests readable: every number below is
// visible in this file, so an assertion that fails names a value the reader
// can see.
//
// widget = 2 crop_a + 3 gas_a. At quantity 10 that is 20 crop_a and 30
// gas_a, which is the arithmetic every rollup assertion rests on.
const stagesArtifact = `{
  "schema_version":2,
  "game_version":"test-stages",
  "items":[
    {"id":"crop_a","name":"Crop A","raw_obtainable":true,"default_method":"raw"},
    {"id":"gas_a","name":"Gas A","raw_obtainable":true,"default_method":"raw"},
    {"id":"widget","name":"Widget","default_method":"craft"}
  ],
  "recipes":[
    {"id":"widget_craft","output":"widget","method":"craft",
     "inputs":[{"item":"crop_a","quantity":2},{"item":"gas_a","quantity":3}]}
  ],
  "economy":{
    "parts":[
      {"id":"U_EXTRACTOR_S","primary":{"network":"resources","rate":100,"storage":360000},
       "dependencies":[{"network":"power","rate":-50,"effect":"EnablesRate"}],"hotspot":"Mineral"},
      {"id":"U_GASEXTRACTOR","primary":{"network":"resources","rate":100,"storage":360000},
       "dependencies":[{"network":"power","rate":-50,"effect":"EnablesRate"}],"hotspot":"Gas"},
      {"id":"U_SILO_S","primary":{"network":"resources","rate":0,"storage":720}},
      {"id":"U_BATTERY_S","primary":{"network":"power","rate":0,"storage":45000}},
      {"id":"U_GENERATOR_S","primary":{"network":"power","rate":1},"hotspot":"Power"},
      {"id":"U_SOLAR_S","primary":{"network":"power","rate":50}}
    ],
    "hotspots":[
      {"category":"Gas","strengths":{"c":1,"b":1,"a":2,"s":2.5},"weightings":{"c":1,"b":1,"a":1,"s":1}},
      {"category":"Mineral","strengths":{"c":1,"b":1,"a":2,"s":2.5},"weightings":{"c":1,"b":1,"a":1,"s":1}},
      {"category":"Power","strengths":{"c":150,"b":220,"a":250,"s":300},"weightings":{"c":1,"b":1,"a":1,"s":1}}
    ],
    "crops":[{"id":"PLANT_A","substance":"crop_a","yield":{"min":25,"max":25},"growth_seconds":1800}]
  }
}`

// curatedJSON is a complete Tier 2 set. The engine refuses a partial one,
// so every scalar is present even where a scenario does not read it.
const curatedJSON = `{
  "biodomeCropSlots":"16","faunaYieldPerCycle":"12","faunaCycleSeconds":"1800",
  "stepsPerProcessor":"2","depotThreshold":"1000","processSeconds":"30",
  "panelsPerBattery":"2",
  "resourceHotspots":{"gas_a":"Gas"}
}`

func stagesModule(t *testing.T) *bridge.Module {
	t.Helper()
	m := bridge.NewModule()
	if env := m.Load(stagesArtifact); !env.OK {
		t.Fatalf("loading the stages artifact: %+v", env.Error)
	}
	return m
}

// rollupRequest builds a request placing both leaves at one base.
func rollupRequest(constants string) string {
	return `{
	  "plan":{"target":"widget","quantity":"10"},
	  "assignments":{"crop_a":"base1","gas_a":"base1"},
	  "sites":{"base1":{"extractorClass":"B","fillSeconds":"3600"}},
	  "constants":` + constants + `}`
}

func powerRequest(constants string) string {
	return `{
	  "sources":{"base1":{"emGenerators":"1","emClass":"B"}},
	  "draws":{"base1":[{"partId":"U_GASEXTRACTOR","count":"2"}]},
	  "constants":` + constants + `}`
}

func callOK(t *testing.T, m *bridge.Module, name, arg string) ([]byte, bridge.Envelope) {
	t.Helper()
	blob := []byte(m.CallJSON(name, arg))
	var env bridge.Envelope
	if err := json.Unmarshal(blob, &env); err != nil {
		t.Fatalf("%s returned unparseable output: %v", name, err)
	}
	if !env.OK {
		t.Fatalf("%s failed: %s — %s", name, env.Error.Code, env.Error.Message)
	}
	return blob, env
}

// SPEC-0002 REQ "Boundary Surface":
// WHEN rollup or power is added in a later stage THEN it accepts and returns
// the same envelope shape defined by REQ "Result Envelope", with no bespoke
// calling convention.
func TestWiredStagesShareTheEnvelopeShape(t *testing.T) {
	m := stagesModule(t)

	for _, tc := range []struct {
		stage string
		arg   string
	}{
		{"rollup", rollupRequest(curatedJSON)},
		{"power", powerRequest(curatedJSON)},
	} {
		_, env := callOK(t, m, tc.stage, tc.arg)
		if env.Data == nil {
			t.Fatalf("%s returned no result payload", tc.stage)
		}
		if env.Error != nil {
			t.Errorf("%s carried both a payload and an error", tc.stage)
		}
		if env.ContractVersion != bridge.ContractVersion {
			t.Errorf("%s contract version = %q, want %q",
				tc.stage, env.ContractVersion, bridge.ContractVersion)
		}
	}
}

// The stages fill the payload field that belongs to them and no other, so a
// consumer can tell which stage answered without tracking what it asked.
func TestEachStageFillsItsOwnPayloadField(t *testing.T) {
	m := stagesModule(t)

	_, resolved := callOK(t, m, "resolve", `{"target":"widget","quantity":"10"}`)
	if resolved.Data.Graph == nil {
		t.Error("resolve returned no graph")
	}
	if resolved.Data.Build != nil || resolved.Data.Power != nil {
		t.Error("resolve returned a stage-2 or stage-3 payload")
	}

	_, rolled := callOK(t, m, "rollup", rollupRequest(curatedJSON))
	if rolled.Data.Build == nil {
		t.Error("rollup returned no build")
	}
	if rolled.Data.Graph != nil || rolled.Data.Power != nil {
		t.Error("rollup returned a stage-1 or stage-3 payload")
	}

	_, powered := callOK(t, m, "power", powerRequest(curatedJSON))
	if powered.Data.Power == nil {
		t.Error("power returned no power budget")
	}
	if powered.Data.Graph != nil || powered.Data.Build != nil {
		t.Error("power returned a stage-1 or stage-2 payload")
	}
}

// SPEC-0002 REQ "Exact Quantity Encoding":
// WHEN a total crosses the boundary THEN it is a JSON string.
//
// The structural walk stage 1 established, extended to every quantity key
// the new payloads introduce. Checking by key name rather than by field
// means a quantity added later is covered the moment it reuses a name, and
// visible as an omission when it does not.
func TestEveryStageQuantityCrossesAsAString(t *testing.T) {
	m := stagesModule(t)

	buildBlob, _ := callOK(t, m, "rollup", rollupRequest(curatedJSON))
	for _, key := range []string{
		"required", "plants", "biodomes", "growthSeconds", "min", "max",
		"extractorCount", "depots", "ratePerSecond", "fillSeconds",
		"fauna", "cycleSeconds", "processSeconds", "perOutput",
		"nutrientProcessors", "pelletFeeders", "total",
	} {
		assertAllStrings(t, buildBlob, key)
	}

	powerBlob, _ := callOK(t, m, "power", powerRequest(curatedJSON))
	for _, key := range []string{
		"generation", "draw", "balance", "deficit",
		"perGenerator", "batteries", "additionalGenerators",
	} {
		assertAllStrings(t, powerBlob, key)
	}
}

// SPEC-0002 REQ "Boundary Surface":
// WHEN the view resolves a plan and renders 36 nodes THEN exactly one
// boundary crossing occurred.
//
// The coarse-grained rule, applied across stages: three stages cost three
// calls, not three per base or three per row. Counted rather than asserted
// in prose — a stage that grew a per-row accessor would fail here.
func TestThreeStagesCostThreeCrossings(t *testing.T) {
	m := stagesModule(t)
	counter := &countingModule{m: m}

	_, _ = counter.call(t, "resolve", `{"target":"widget","quantity":"10"}`)
	_, rolled := counter.call(t, "rollup", rollupRequest(curatedJSON))
	_, _ = counter.call(t, "power", powerRequest(curatedJSON))

	if counter.calls != 3 {
		t.Errorf("crossings = %d, want 3", counter.calls)
	}

	// And the one rollup crossing carried every base, not one of them.
	if got := len(rolled.Data.Build.Bases); got != 1 {
		t.Fatalf("bases in one crossing = %d, want 1", got)
	}
	base := rolled.Data.Build.Bases[0]
	if len(base.Farms) != 1 || len(base.Extractors) != 1 {
		t.Errorf("one crossing carried %d farm and %d extractor rows, want 1 and 1",
			len(base.Farms), len(base.Extractors))
	}
}

type countingModule struct {
	m     *bridge.Module
	calls int
}

func (c *countingModule) call(t *testing.T, name, arg string) ([]byte, bridge.Envelope) {
	t.Helper()
	c.calls++
	return callOK(t, c.m, name, arg)
}

// SPEC-0001 REQ "Producer Rollup", crossing the boundary intact:
// 20 crop_a at 25 per plant is 1 plant in 1 biodome; 30 gas_a is one
// extractor's work well inside an hour.
func TestProducerCountsSurviveTheCrossing(t *testing.T) {
	m := stagesModule(t)
	_, env := callOK(t, m, "rollup", rollupRequest(curatedJSON))

	base := env.Data.Build.Bases[0]
	if base.Base != "base1" {
		t.Errorf("base = %q, want base1", base.Base)
	}
	if base.Site.ExtractorClass != "B" {
		t.Errorf("site class = %q, want B — the configuration a result was computed under should read back", base.Site.ExtractorClass)
	}

	farm := base.Farms[0]
	if farm.ItemID != "crop_a" || farm.Required != "20" || farm.Plants != "1" || farm.Biodomes != "1" {
		t.Errorf("farm row = %+v, want crop_a required 20, 1 plant, 1 biodome", farm)
	}
	if farm.YieldPerPlant.Min != "25" || farm.YieldPerPlant.Max != "25" {
		t.Errorf("yield range = %+v, want 25..25", farm.YieldPerPlant)
	}

	ext := base.Extractors[0]
	if ext.ItemID != "gas_a" || ext.Required != "30" || ext.Class != "B" {
		t.Errorf("extractor row = %+v, want gas_a required 30 at class B", ext)
	}
	if ext.ExtractorCount != "1" {
		t.Errorf("extractor count = %q, want 1", ext.ExtractorCount)
	}
}

// SPEC-0001 REQ "Power Computation", crossing intact:
// one class-B generator at rate 1 against a 220 class strength generates
// 220; two gas extractors drawing 50 each draw 100.
func TestPowerPositionSurvivesTheCrossing(t *testing.T) {
	m := stagesModule(t)
	_, env := callOK(t, m, "power", powerRequest(curatedJSON))

	if got := len(env.Data.Power.Bases); got != 1 {
		t.Fatalf("bases = %d, want 1", got)
	}
	b := env.Data.Power.Bases[0]
	if b.Generation != "220" {
		t.Errorf("generation = %q, want 220", b.Generation)
	}
	if b.Draw != "100" {
		t.Errorf("draw = %q, want 100", b.Draw)
	}
	if b.Balance != "120" {
		t.Errorf("balance = %q, want 120", b.Balance)
	}
	if b.Deficit != "0" || b.InDeficit {
		t.Errorf("deficit = %q inDeficit = %v, want 0 and false", b.Deficit, b.InDeficit)
	}
}

// SPEC-0001 REQ "Power Computation" — Scenario "Deficit reports the fix".
//
// A deficit crosses as an action rather than as a warning: the count of
// additional generators is the domain's, and the adapter neither sizes nor
// second-guesses it.
func TestDeficitCrossesWithItsFix(t *testing.T) {
	m := stagesModule(t)
	req := `{
	  "sources":{"base1":{"emGenerators":"1","emClass":"C"}},
	  "draws":{"base1":[{"partId":"U_GASEXTRACTOR","count":"10"}]},
	  "constants":` + curatedJSON + `}`

	_, env := callOK(t, m, "power", req)
	b := env.Data.Power.Bases[0]

	if !b.InDeficit {
		t.Fatalf("base is not in deficit: generation %q draw %q", b.Generation, b.Draw)
	}
	if b.Deficit != "350" {
		t.Errorf("deficit = %q, want 350 (500 draw less 150 generation)", b.Deficit)
	}
	if b.AdditionalGenerators != "3" {
		t.Errorf("additional generators = %q, want 3 at 150 each", b.AdditionalGenerators)
	}
	if b.FixUnsized {
		t.Error("fix reported unsized when a class was configured")
	}
}

// A deficit with no configured class is still a deficit.
//
// The domain reports it with an unsized fix rather than refusing the base,
// and that distinction has to survive the crossing — a view told only
// "additional generators: 0" would render a base in deficit as healthy.
func TestUnsizedFixCrossesAsItsOwnState(t *testing.T) {
	m := stagesModule(t)
	req := `{
	  "draws":{"base1":[{"partId":"U_GASEXTRACTOR","count":"2"}]},
	  "constants":` + curatedJSON + `}`

	_, env := callOK(t, m, "power", req)
	b := env.Data.Power.Bases[0]

	if !b.InDeficit {
		t.Fatal("a base drawing power with no generation is not in deficit")
	}
	if !b.FixUnsized {
		t.Error("fix was not reported unsized with no generator class configured")
	}
	if b.AdditionalGenerators != "0" {
		t.Errorf("additional generators = %q, want 0 when the fix has no size", b.AdditionalGenerators)
	}
	if b.Deficit != "100" {
		t.Errorf("deficit = %q, want 100 — a deficit that cannot be costed is still reported", b.Deficit)
	}
}

// The domain models generation as independent counts rather than a choice
// between two source types, and the boundary must not narrow that: a base
// running both generators and panels is a configuration the engine accepts.
func TestMixedGenerationSourcesCross(t *testing.T) {
	m := stagesModule(t)
	req := `{
	  "sources":{"base1":{"emGenerators":"1","emClass":"B","solarPanels":"4"}},
	  "constants":` + curatedJSON + `}`

	_, env := callOK(t, m, "power", req)
	b := env.Data.Power.Bases[0]

	if b.Generation != "420" {
		t.Errorf("generation = %q, want 420 (220 electromagnetic + 200 solar)", b.Generation)
	}
	if b.Batteries != "2" {
		t.Errorf("batteries = %q, want 2 for 4 panels at 2 panels per battery", b.Batteries)
	}
}

// SPEC-0002 REQ "Sentinel Error Preservation":
// a missing curated constant crosses with a stable code, not UNCLASSIFIED.
//
// MISSING_CONSTANT specifically. When this test was written the engine
// raised ErrInvalidArtifact for an absent constant and the assertion said
// so; SPEC-0001 REQ "Error Handling Standards" requires the
// missing-constant sentinel, and the engine now raises it. The distinction
// is the point: a view can tell "you did not supply this" from "our
// artifact is broken".
func TestMissingCuratedConstantCrossesWithAStableCode(t *testing.T) {
	m := stagesModule(t)
	incomplete := `{"biodomeCropSlots":"16","faunaYieldPerCycle":"12"}`

	var env bridge.Envelope
	if err := json.Unmarshal([]byte(m.CallJSON("rollup", rollupRequest(incomplete))), &env); err != nil {
		t.Fatalf("unparseable output: %v", err)
	}
	if env.OK {
		t.Fatal("rollup succeeded against an incomplete constant set")
	}
	if env.Error.Code == bridge.CodeUnclassified {
		t.Error("a missing constant crossed as UNCLASSIFIED")
	}
	if env.Error.Code != bridge.CodeMissingConstant {
		t.Errorf("code = %q, want %q", env.Error.Code, bridge.CodeMissingConstant)
	}
	if !strings.Contains(env.Error.Message, "fauna cycle seconds") {
		t.Errorf("message %q does not name the missing constant", env.Error.Message)
	}
}

// A stage called before the artifact loads fails as not-ready and names
// itself, so the failure is distinguishable from a typo in the entry point.
func TestUnloadedStagesReportNotReadyAndNameThemselves(t *testing.T) {
	m := bridge.NewModule()

	for _, name := range []string{"rollup", "power"} {
		var env bridge.Envelope
		if err := json.Unmarshal([]byte(m.CallJSON(name, `{}`)), &env); err != nil {
			t.Fatalf("%s returned unparseable output: %v", name, err)
		}
		if env.OK {
			t.Errorf("%s succeeded before the artifact loaded", name)
		}
		if env.Error.Code != bridge.CodeNotReady {
			t.Errorf("%s code = %q, want %q", name, env.Error.Code, bridge.CodeNotReady)
		}
		if !strings.Contains(env.Error.Message, name) {
			t.Errorf("%s message %q does not name the stage", name, env.Error.Message)
		}
	}
}

// SPEC-0002 REQ "Error Handling Standards":
// decoding failures name what could not be decoded and attempt no computation.
func TestStageDecodingFailuresNameTheField(t *testing.T) {
	m := stagesModule(t)

	for _, tc := range []struct {
		name  string
		stage string
		arg   string
		names string
	}{
		{
			name:  "fill duration is not a number",
			stage: "rollup",
			arg: `{"plan":{"target":"widget","quantity":"10"},
			       "sites":{"base1":{"extractorClass":"B","fillSeconds":"soon"}},
			       "constants":` + curatedJSON + `}`,
			names: "fill duration for base base1",
		},
		{
			name:  "generator count is fractional",
			stage: "power",
			arg:   `{"sources":{"base1":{"emGenerators":"3/2"}},"constants":` + curatedJSON + `}`,
			names: "generator count for base base1",
		},
		{
			name:  "draw count is not a number",
			stage: "power",
			arg: `{"draws":{"base1":[{"partId":"U_SOLAR_S","count":"lots"}]},
			       "constants":` + curatedJSON + `}`,
			names: "draw count for U_SOLAR_S at base base1",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var env bridge.Envelope
			if err := json.Unmarshal([]byte(m.CallJSON(tc.stage, tc.arg)), &env); err != nil {
				t.Fatalf("unparseable output: %v", err)
			}
			if env.OK {
				t.Fatal("the stage computed against an undecodable request")
			}
			if env.Error.Code != bridge.CodeMalformedInput {
				t.Errorf("code = %q, want %q", env.Error.Code, bridge.CodeMalformedInput)
			}
			if !strings.Contains(env.Error.Message, tc.names) {
				t.Errorf("message %q does not name %q", env.Error.Message, tc.names)
			}
		})
	}
}

// SPEC-0002 REQ "Determinism Across the Boundary":
// identical inputs produce byte-identical output.
func TestStageEncodingIsByteIdentical(t *testing.T) {
	m := stagesModule(t)

	for _, tc := range []struct{ stage, arg string }{
		{"rollup", rollupRequest(curatedJSON)},
		{"power", powerRequest(curatedJSON)},
	} {
		first := m.CallJSON(tc.stage, tc.arg)
		second := m.CallJSON(tc.stage, tc.arg)
		if first != second {
			t.Errorf("%s encoded two different payloads for one input:\n%s\n%s", tc.stage, first, second)
		}
	}
}

// A leaf the plan places nowhere is reported rather than dropped. The
// producer stage skips it — there is no site to build it at — and losing it
// here would make an unplaced requirement indistinguishable from one that
// does not exist.
func TestUnassignedLeavesAreReported(t *testing.T) {
	m := stagesModule(t)
	req := `{
	  "plan":{"target":"widget","quantity":"10"},
	  "assignments":{"crop_a":"base1"},
	  "sites":{"base1":{"extractorClass":"B","fillSeconds":"3600"}},
	  "constants":` + curatedJSON + `}`

	_, env := callOK(t, m, "rollup", req)
	build := env.Data.Build

	if len(build.Unassigned) != 1 {
		t.Fatalf("unassigned = %d entries, want 1", len(build.Unassigned))
	}
	if build.Unassigned[0].ItemID != "gas_a" || build.Unassigned[0].Total != "30" {
		t.Errorf("unassigned = %+v, want gas_a totalling 30", build.Unassigned[0])
	}
}

// SPEC-0001 REQ "Provenance Propagation", crossing the boundary.
//
// The stage-2 payload previously carried no provenance at all: the domain
// computed it for the leaf demand and the producer rows dropped it, so a
// view had nothing to mark. Both halves cross now — the row's own flag and
// the base-level answer.
func TestProducerProvenanceCrossesTheBoundary(t *testing.T) {
	m := stagesModule(t)

	// No verified dates: every constant is unconfirmed, which is the true
	// state of this project's curated set today.
	_, unverified := callOK(t, m, "rollup", rollupRequest(curatedJSON))
	base := unverified.Data.Build.Bases[0]
	if base.Farms[0].Verified {
		t.Error("farm row crossed as verified with no constant dates supplied")
	}
	if base.Extractors[0].Verified {
		t.Error("extractor row crossed as verified with no constant dates supplied")
	}
	if base.Verified {
		t.Error("base crossed as verified with no constant dates supplied")
	}

	// The same plan with dates supplied crosses verified, so the flag
	// tracks the input rather than being hardcoded either way.
	dated := `{
	  "biodomeCropSlots":"16","faunaYieldPerCycle":"12","faunaCycleSeconds":"1800",
	  "stepsPerProcessor":"2","depotThreshold":"1000","processSeconds":"30",
	  "panelsPerBattery":"2",
	  "resourceHotspots":{"gas_a":"Gas"},
	  "verifiedOn":{
	    "biodome crop slots":"2026-08-20","depot threshold":"2026-08-20",
	    "fauna yield per cycle":"2026-08-20","fauna cycle seconds":"2026-08-20",
	    "steps per processor":"2026-08-20","process seconds":"2026-08-20",
	    "panels per battery":"2026-08-20"
	  }}`
	_, verified := callOK(t, m, "rollup", rollupRequest(dated))
	base = verified.Data.Build.Bases[0]
	if !base.Farms[0].Verified || !base.Extractors[0].Verified {
		t.Errorf("a row crossed unverified with every date supplied: farm=%v extractor=%v",
			base.Farms[0].Verified, base.Extractors[0].Verified)
	}
	if !base.Verified {
		t.Error("base crossed unverified with every date supplied")
	}
}

// SPEC-0011 REQ "A Place Is Creatable by Hand":
// WHEN a leaf is assigned to a place that has no site configuration
// THEN the boundary reports the base as unconfigured with the demand
// unsized, rather than failing the call or reporting zero extractors.
//
// Asserted at the boundary rather than only in the domain because the view
// renders the absence, and a field the encoder drops is a gap the view
// cannot tell from a base with nothing to extract.
func TestRollupCarriesAnUnconfiguredBase(t *testing.T) {
	m := stagesModule(t)

	blob, _ := callOK(t, m, "rollup", `{
	  "plan":{"target":"widget","quantity":"10"},
	  "assignments":{"crop_a":"base1","gas_a":"base1"},
	  "constants":`+curatedJSON+`}`)

	var out struct {
		Data struct {
			Build struct {
				Bases []struct {
					Base       string `json:"base"`
					Configured bool   `json:"configured"`
					Extractors []struct {
						ItemID string `json:"itemId"`
					} `json:"extractors"`
					Farms []struct {
						ItemID string `json:"itemId"`
					} `json:"farms"`
					Unsited []struct {
						ItemID   string `json:"itemId"`
						Required string `json:"required"`
					} `json:"unsited"`
				} `json:"bases"`
			} `json:"build"`
		} `json:"data"`
	}
	if err := json.Unmarshal(blob, &out); err != nil {
		t.Fatalf("unparseable rollup output: %v", err)
	}
	if len(out.Data.Build.Bases) != 1 {
		t.Fatalf("bases = %d, want 1", len(out.Data.Build.Bases))
	}

	base := out.Data.Build.Bases[0]
	if base.Configured {
		t.Error("a base with no sites entry crossed as configured")
	}
	if len(base.Extractors) != 0 {
		t.Errorf("extractor rows = %d, want none", len(base.Extractors))
	}
	if len(base.Unsited) != 1 || base.Unsited[0].ItemID != "gas_a" {
		t.Fatalf("unsited = %+v, want gas_a alone", base.Unsited)
	}
	if base.Unsited[0].Required == "" {
		t.Error("the unsited row crossed with no requirement")
	}
	// The half that still works: a crop needs no site, so the farm is sized.
	if len(base.Farms) != 1 {
		t.Errorf("farm rows = %d, want 1 — an unconfigured base still says what to plant", len(base.Farms))
	}
}

// The complement: a configured base still reports itself configured, so the
// flag is a real distinction rather than a field that is always false.
func TestRollupReportsAConfiguredBase(t *testing.T) {
	m := stagesModule(t)

	blob, _ := callOK(t, m, "rollup", rollupRequest(curatedJSON))

	var out struct {
		Data struct {
			Build struct {
				Bases []struct {
					Configured bool `json:"configured"`
					Unsited    []struct {
						ItemID string `json:"itemId"`
					} `json:"unsited"`
				} `json:"bases"`
			} `json:"build"`
		} `json:"data"`
	}
	if err := json.Unmarshal(blob, &out); err != nil {
		t.Fatalf("unparseable rollup output: %v", err)
	}
	if len(out.Data.Build.Bases) != 1 || !out.Data.Build.Bases[0].Configured {
		t.Fatalf("configured base did not report itself configured: %+v", out.Data.Build.Bases)
	}
	if len(out.Data.Build.Bases[0].Unsited) != 0 {
		t.Errorf("configured base carried %d unsited rows, want none", len(out.Data.Build.Bases[0].Unsited))
	}
}
