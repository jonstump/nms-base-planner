package bridge_test

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jonstump/nms-base-planner/internal/bridge"
	"github.com/jonstump/nms-base-planner/internal/domain"
)

func loadFixture(t *testing.T) *domain.Tier1 {
	t.Helper()
	f, err := os.Open("../domain/testdata/stasis-device.tier1.json")
	if err != nil {
		t.Fatalf("opening fixture: %v", err)
	}
	defer f.Close()
	a1, err := domain.LoadTier1(f)
	if err != nil {
		t.Fatalf("loading fixture: %v", err)
	}
	return a1
}

func resolve(t *testing.T, in domain.PlanInput) *domain.ResolvedGraph {
	t.Helper()
	g, err := domain.Resolve(loadFixture(t), in)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	return g
}

func encode(t *testing.T, g *domain.ResolvedGraph) []byte {
	t.Helper()
	wire, err := bridge.EncodeGraph(g)
	if err != nil {
		t.Fatalf("EncodeGraph: %v", err)
	}
	blob, err := bridge.Marshal(bridge.Success(bridge.ResultPayload{Graph: wire}))
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return blob
}

// SPEC-0002 REQ "Result Envelope":
// WHEN a call succeeds
// THEN the envelope reports success, carries the result payload, and carries
// no error payload.
func TestSuccessCarriesAPayloadAndNoError(t *testing.T) {
	g := resolve(t, domain.PlanInput{Target: "sd", Quantity: 1})
	wire, err := bridge.EncodeGraph(g)
	if err != nil {
		t.Fatal(err)
	}
	env := bridge.Success(bridge.ResultPayload{Graph: wire})

	if !env.OK {
		t.Error("envelope does not report success")
	}
	if env.Data == nil || env.Data.Graph == nil {
		t.Fatal("envelope carries no result payload")
	}
	if env.Error != nil {
		t.Errorf("envelope carries an error payload: %+v", env.Error)
	}
	if env.ContractVersion != bridge.ContractVersion {
		t.Errorf("contract version = %q, want %q", env.ContractVersion, bridge.ContractVersion)
	}

	// On the wire, the error key is absent rather than null.
	blob, err := bridge.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(blob, &raw); err != nil {
		t.Fatal(err)
	}
	if _, present := raw["error"]; present {
		t.Errorf("a successful envelope carries an error key: %s", blob)
	}
}

// SPEC-0002 REQ "Result Envelope":
// WHEN graph resolution fails
// THEN the envelope reports failure, carries the error payload, and carries
// no result payload — not an empty one.
func TestFailureCarriesAnErrorAndNoPayload(t *testing.T) {
	// A real domain failure rather than a synthetic one.
	_, err := domain.Resolve(loadFixture(t), domain.PlanInput{Target: "not_an_item", Quantity: 1})
	if err == nil {
		t.Fatal("expected the domain to reject an unknown target")
	}

	env := bridge.Failure("", err.Error())
	if env.OK {
		t.Error("envelope reports success on a failure")
	}
	if env.Error == nil {
		t.Fatal("envelope carries no error payload")
	}
	if env.Data != nil {
		t.Errorf("envelope carries a result payload alongside an error: %+v", env.Data)
	}
	if env.Error.Code != bridge.CodeUnclassified {
		t.Errorf("code = %q, want the reserved unclassified code", env.Error.Code)
	}
	if !strings.Contains(env.Error.Message, "not_an_item") {
		t.Errorf("message %q does not carry the domain's prose", env.Error.Message)
	}

	// "not an empty one": the data key must be absent, not {}.
	blob, err := bridge.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte(`"data"`)) {
		t.Errorf("a failure envelope carries a data key: %s", blob)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(blob, &raw); err != nil {
		t.Fatal(err)
	}
	if _, present := raw["data"]; present {
		t.Errorf("a failure envelope carries a data key: %s", blob)
	}
}

// SPEC-0002 REQ "Exact Quantity Encoding":
// WHEN Condensed Carbon resolves to a total of 300
// THEN the encoded value is the string "300", not the number 300.
func TestOrdinaryTotalCrossesAsAString(t *testing.T) {
	blob := encode(t, resolve(t, domain.PlanInput{Target: "sd", Quantity: 1}))

	if !bytes.Contains(blob, []byte(`"total":"300"`)) {
		t.Errorf("Condensed Carbon's 300 did not cross as the string \"300\"")
	}
	if bytes.Contains(blob, []byte(`"total":300`)) {
		t.Error("a total crossed as a JSON number")
	}

	// Structurally: every quantity field in the payload is a string.
	for _, key := range []string{"total", "quantity", "perUnit", "yield", "applications"} {
		assertAllStrings(t, blob, key)
	}
}

// assertAllStrings walks the encoded payload and fails if any occurrence of
// the named key holds a JSON number.
func assertAllStrings(t *testing.T, blob []byte, key string) {
	t.Helper()
	var doc any
	if err := json.Unmarshal(blob, &doc); err != nil {
		t.Fatal(err)
	}
	var walk func(v any)
	walk = func(v any) {
		switch node := v.(type) {
		case map[string]any:
			for k, child := range node {
				if k == key {
					if _, isNumber := child.(float64); isNumber {
						t.Errorf("%q crossed as a JSON number: %v", k, child)
					}
					if _, isString := child.(string); !isString && child != nil {
						t.Errorf("%q crossed as %T, want a string", k, child)
					}
				}
				walk(child)
			}
		case []any:
			for _, child := range node {
				walk(child)
			}
		}
	}
	walk(doc)
}

// SPEC-0002 REQ "Exact Quantity Encoding":
// WHEN a total exceeds 2^53−1 THEN the encoded string carries the exact
// value, and parsing it as a BigInt yields that value unchanged.
func TestValueBeyondJavaScriptSafeIntegerSurvives(t *testing.T) {
	// 500 units of gas per Stasis Device, so this lands well past 2^53−1.
	const qty = 1_000_000_000_000_000
	g := resolve(t, domain.PlanInput{Target: "sd", Quantity: qty})

	sul, ok := g.Node("sul")
	if !ok {
		t.Fatal("sul missing")
	}
	want := new(big.Rat).Mul(big.NewRat(500, 1), new(big.Rat).SetInt64(qty))
	maxSafe := big.NewRat(1<<53-1, 1)
	if want.Cmp(maxSafe) <= 0 {
		t.Fatalf("the test quantity %s does not exceed 2^53-1, so this proves nothing", want.RatString())
	}

	q := bridge.QuantityOf(sul.Total())
	// Round-trips exactly, which is what a BigInt parse does on the other
	// side: the string is exact decimal digits.
	back, ok := q.Rat()
	if !ok {
		t.Fatalf("encoded quantity %q does not parse back", q)
	}
	if back.Cmp(want) != 0 {
		t.Errorf("round trip = %s, want %s", back.RatString(), want.RatString())
	}
	if strings.ContainsAny(string(q), ".eE") {
		t.Errorf("quantity %q is not exact decimal digits; a BigInt parse would reject it", q)
	}

	// The graph value above is past 2^53−1 but happens to be
	// double-representable, so on its own it does not show that a number
	// path would lose anything. 2^53+1 does: it is the smallest integer a
	// double cannot hold, and it is what a consumer parsing with Number
	// instead of BigInt would silently round.
	unsafe := new(big.Rat).SetInt(new(big.Int).Add(
		new(big.Int).Lsh(big.NewInt(1), 53), big.NewInt(1)))

	encoded := bridge.QuantityOf(unsafe)
	if encoded != "9007199254740993" {
		t.Fatalf("2^53+1 encoded as %q", encoded)
	}
	roundTripped, ok := encoded.Rat()
	if !ok || roundTripped.Cmp(unsafe) != 0 {
		t.Errorf("2^53+1 round trip = %v, want %s", roundTripped, unsafe.RatString())
	}

	// The same value through a float64 does not survive, which is what the
	// string encoding exists to avoid.
	viaFloat, _ := unsafe.Float64()
	if new(big.Rat).SetFloat64(viaFloat).Cmp(unsafe) == 0 {
		t.Fatal("2^53+1 survived a float64 round trip; this platform is not IEEE-754 double")
	}
}

// SPEC-0002 REQ "Exact Quantity Encoding":
// WHEN a later stage produces a total that is exactly one and a half
// THEN the encoded value represents that quantity exactly, and no rounding
// or truncation is applied.
func TestNonIntegerTotalIsNotRounded(t *testing.T) {
	// A yield of 2 satisfying a demand of 3: one and a half applications,
	// and one and a half of the input. The shape SPEC-0001's Applications()
	// already produces on real refiner data.
	const artifact = `{
	  "schema_version": 2, "game_version": "test-halves",
	  "items": [
	    {"id":"x","name":"X","raw_obtainable":true,"default_method":"raw"},
	    {"id":"z","name":"Z","default_method":"refine"}
	  ],
	  "recipes": [
	    {"id":"z_x","output":"z","method":"refine","inputs":[{"item":"x","quantity":1}],"yield":2}
	  ]
	}`
	a1, err := domain.LoadTier1(strings.NewReader(artifact))
	if err != nil {
		t.Fatal(err)
	}
	g, err := domain.Resolve(a1, domain.PlanInput{Target: "z", Quantity: 3})
	if err != nil {
		t.Fatal(err)
	}

	z, _ := g.Node("z")
	if got := bridge.QuantityOf(z.Applications()); got != "3/2" {
		t.Errorf("applications = %q, want \"3/2\"", got)
	}
	x, _ := g.Node("x")
	if got := bridge.QuantityOf(x.Total()); got != "3/2" {
		t.Errorf("x total = %q, want \"3/2\"", got)
	}

	// Exact on the way back: no rounding, no truncation.
	back, ok := bridge.QuantityOf(x.Total()).Rat()
	if !ok || back.Cmp(big.NewRat(3, 2)) != 0 {
		t.Errorf("round trip = %v, want 3/2", back)
	}
	// And it did not silently become "1" or "2".
	if intVal, exact := x.TotalInt(); exact {
		t.Errorf("the domain reported %d as exact for a fractional total", intVal)
	}
}

// SPEC-0002 REQ "Exact Quantity Encoding":
// WHEN the adapter encodes any quantity
// THEN no conversion through float64 occurs, verified by the absence of such
// conversions in the encoding code.
//
// Checked mechanically by parsing this package's own source, because the
// scenario asks for verification rather than a comment saying so. A
// float64 conversion, a FloatString call (which rounds to a fixed number of
// places), or a Float64/Float32 call anywhere in the encoding path fails
// this test.
func TestNoFloatInTheEncodingPath(t *testing.T) {
	sources, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	var checked int
	for _, path := range sources {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		checked++

		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", path, err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			switch fn := call.Fun.(type) {
			case *ast.Ident:
				// A float64(x) or float32(x) conversion.
				if fn.Name == "float64" || fn.Name == "float32" {
					t.Errorf("%s: %s conversion in the encoding path",
						fset.Position(call.Pos()), fn.Name)
				}
			case *ast.SelectorExpr:
				// FloatString rounds to a fixed number of places; Float64
				// and Float32 leave the exact domain entirely.
				switch fn.Sel.Name {
				case "FloatString", "Float64", "Float32", "SetFloat64":
					t.Errorf("%s: %s call in the encoding path",
						fset.Position(call.Pos()), fn.Sel.Name)
				}
			}
			return true
		})

		// Belt and braces: no float type appears in a declaration either.
		blob, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, banned := range []string{"float64", "float32"} {
			// Comments may discuss floats; declarations may not use them.
			for _, line := range strings.Split(string(blob), "\n") {
				trimmed := strings.TrimSpace(line)
				if strings.HasPrefix(trimmed, "//") {
					continue
				}
				if strings.Contains(line, banned) {
					t.Errorf("%s: %q appears in code: %s", path, banned, trimmed)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no non-test sources were checked, so this proves nothing")
	}
}

// SPEC-0002 REQ "Recipe Selection Crossing":
// WHEN a plan specifying a non-default recipe for one node crosses the
// boundary and is returned THEN that node reports the specified recipe, and
// its expansion reflects it.
func TestNonDefaultRecipeCrossesAndExpands(t *testing.T) {
	// The fixture's Glass has two routes; the craft one is its default.
	// Pin the refine route and check both the report and the expansion.
	in := domain.PlanInput{
		Target: "sd", Quantity: 1,
		Methods: map[string]domain.Method{"gla": domain.MethodRefine},
		Recipes: map[string]string{"gla": "gla_refine"},
	}
	wire := bridge.EncodePlan(in)
	if wire.Recipes["gla"] != "gla_refine" {
		t.Fatalf("plan recipes = %v, want gla_refine", wire.Recipes)
	}

	back, err := bridge.DecodePlan(wire)
	if err != nil {
		t.Fatal(err)
	}
	g, err := domain.Resolve(loadFixture(t), back)
	if err != nil {
		t.Fatalf("resolving the round-tripped plan: %v", err)
	}
	encoded, err := bridge.EncodeGraph(g)
	if err != nil {
		t.Fatal(err)
	}

	var gla *bridge.Node
	for i := range encoded.Nodes {
		if encoded.Nodes[i].ItemID == "gla" {
			gla = &encoded.Nodes[i]
		}
	}
	if gla == nil {
		t.Fatal("gla missing from the encoded graph")
	}
	if gla.Recipe != "gla_refine" {
		t.Errorf("node recipe = %q, want gla_refine", gla.Recipe)
	}
	// The expansion reflects it: the refine route takes 250 Frost Crystal,
	// the craft route 40.
	if len(gla.Children) != 1 || gla.Children[0].PerUnit != "250" {
		t.Errorf("gla children = %+v, want one edge of 250", gla.Children)
	}
}

// SPEC-0002 REQ "Recipe Selection Crossing":
// WHEN a plan in which every node uses its default recipe is encoded
// THEN the payload contains no recipe selections.
func TestDefaultsCostNoPayload(t *testing.T) {
	wire := bridge.EncodePlan(domain.PlanInput{Target: "sd", Quantity: 1})

	if wire.Recipes != nil {
		t.Errorf("recipes = %v, want none", wire.Recipes)
	}
	if wire.Methods != nil {
		t.Errorf("methods = %v, want none", wire.Methods)
	}

	blob, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"recipes"`, `"methods"`} {
		if bytes.Contains(blob, []byte(key)) {
			t.Errorf("an all-defaults plan carries %s: %s", key, blob)
		}
	}
}

// SPEC-0002 REQ "Recipe Selection Crossing":
// WHEN the view receives a resolved graph
// THEN each node carries its legal recipes for the chosen method, without
// the view reading the artifact.
func TestNodesCarryTheirLegalRecipes(t *testing.T) {
	g := resolve(t, domain.PlanInput{Target: "sd", Quantity: 1})
	wire, err := bridge.EncodeGraph(g)
	if err != nil {
		t.Fatal(err)
	}

	var checked int
	for _, n := range wire.Nodes {
		if n.Terminal {
			if n.Recipe != "" {
				t.Errorf("terminal %s carries recipe %q", n.ItemID, n.Recipe)
			}
			continue
		}
		checked++
		if n.Recipe == "" {
			t.Errorf("%s carries no recipe", n.ItemID)
		}
		if len(n.LegalRecipes) == 0 {
			t.Errorf("%s carries no legal recipes; the view would have to read the artifact", n.ItemID)
		}
		var found bool
		for _, r := range n.LegalRecipes {
			if r == n.Recipe {
				found = true
			}
		}
		if !found {
			t.Errorf("%s selected %q, which is not among its legal recipes %v", n.ItemID, n.Recipe, n.LegalRecipes)
		}
		if len(n.LegalMethods) == 0 {
			t.Errorf("%s carries no legal methods", n.ItemID)
		}
	}
	if checked == 0 {
		t.Fatal("no non-terminal nodes were checked")
	}
}

// SPEC-0002 REQ "Determinism Across the Boundary":
// WHEN the same plan input is resolved and encoded twice in the same process
// THEN the two encoded outputs are byte-identical.
func TestEncodingIsByteIdentical(t *testing.T) {
	in := domain.PlanInput{
		Target: "sd", Quantity: 4,
		Methods: map[string]domain.Method{"cc": domain.MethodRefine, "gla": domain.MethodRefine},
		Recipes: map[string]string{"gla": "gla_refine"},
	}

	first := encode(t, resolve(t, in))
	for i := 0; i < 25; i++ {
		if got := encode(t, resolve(t, in)); !bytes.Equal(got, first) {
			t.Fatalf("run %d differs from the first; map iteration is leaking into the encoding", i+2)
		}
	}

	// The plan payload's maps encode with sorted keys, which is what makes
	// the URL hash stable across runs.
	planFirst, err := json.Marshal(bridge.EncodePlan(in))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 25; i++ {
		got, err := json.Marshal(bridge.EncodePlan(in))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, planFirst) {
			t.Fatalf("plan encoding run %d differs from the first", i+2)
		}
	}
}

// SPEC-0002 REQ "Determinism Across the Boundary":
// WHEN an encoded graph is decoded by the consumer
// THEN node order matches the domain's order — terminals first, target last.
func TestNodeOrderMatchesTheDomain(t *testing.T) {
	g := resolve(t, domain.PlanInput{Target: "sd", Quantity: 1})
	wire, err := bridge.EncodeGraph(g)
	if err != nil {
		t.Fatal(err)
	}

	if len(wire.Nodes) != len(g.Nodes) {
		t.Fatalf("encoded %d nodes, domain has %d", len(wire.Nodes), len(g.Nodes))
	}
	for i, n := range g.Nodes {
		if wire.Nodes[i].ItemID != n.ItemID {
			t.Fatalf("node %d is %q, domain has %q — order was not preserved",
				i, wire.Nodes[i].ItemID, n.ItemID)
		}
	}
	if !wire.Nodes[0].Terminal {
		t.Error("the first node is not a terminal")
	}
	if last := wire.Nodes[len(wire.Nodes)-1]; last.ItemID != "sd" {
		t.Errorf("the last node is %q, want the target", last.ItemID)
	}
}

// SPEC-0002 REQ "Determinism Across the Boundary":
// WHEN a node is marked unverified by the domain
// THEN it arrives at the consumer marked unverified.
func TestProvenanceSurvivesTheCrossing(t *testing.T) {
	g := resolve(t, domain.PlanInput{Target: "sd", Quantity: 1})
	wire, err := bridge.EncodeGraph(g)
	if err != nil {
		t.Fatal(err)
	}

	domainVerified := map[string]bool{}
	var unverified int
	for _, n := range g.Nodes {
		domainVerified[n.ItemID] = n.Verified
		if !n.Verified {
			unverified++
		}
	}
	if unverified == 0 {
		t.Fatal("the fixture has no unverified nodes, so this proves nothing")
	}

	for _, n := range wire.Nodes {
		if n.Verified != domainVerified[n.ItemID] {
			t.Errorf("%s crossed as verified=%v, domain says %v", n.ItemID, n.Verified, domainVerified[n.ItemID])
		}
	}
}
