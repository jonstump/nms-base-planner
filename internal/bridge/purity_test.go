package bridge_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jonstump/nms-base-planner/internal/bridge"
)

// SPEC-0002 REQ "Domain Purity Preservation":
// WHEN the module's dependency graph is inspected
// THEN syscall/js is reachable only through the adapter package.
//
// The issue asked for this to stop being an honour-system comment. It is
// checked with the command the note itself names, run under the build that
// could actually contain syscall/js — GOOS=js GOARCH=wasm. On any other
// GOOS the dependency cannot appear, so a check without those variables
// would pass for the wrong reason and prove nothing.
func TestSyscallJSIsReachableOnlyThroughTheAdapter(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("the go tool is not on PATH")
	}

	// Direct imports, not the transitive closure.
	//
	// Under GOOS=js every package reaches syscall/js transitively, because
	// the standard library's own syscall package imports it — so a
	// `go list -deps | grep` check reports every package as impure and
	// distinguishes nothing. It was the first thing I wrote here and it
	// failed for exactly that reason.
	//
	// What ADR-0003 actually forbids is a package of ours importing it, so
	// that is what is checked: the direct import list of every package in
	// this module.
	imports := directImports(t)
	if len(imports) < 5 {
		t.Fatalf("go list found only %d packages, so this proves nothing", len(imports))
	}

	const adapter = "github.com/jonstump/nms-base-planner/cmd/planner"
	var importers []string
	for pkg, deps := range imports {
		for _, dep := range deps {
			if dep != "syscall/js" {
				continue
			}
			importers = append(importers, pkg)
			if pkg != adapter {
				t.Errorf("%s imports syscall/js; ADR-0003 confines it to the adapter", pkg)
			}
		}
	}

	// And the check has teeth: the adapter really does import it, so a pass
	// is the absence of a dependency that exists elsewhere in this module
	// rather than a query that never finds anything.
	if len(importers) == 0 {
		t.Error("no package in this module imports syscall/js, so the checks above " +
			"cannot distinguish a pure package from a broken query")
	}
}

// directImports lists each package in this module against its direct
// imports, under the build where syscall/js can appear at all.
func directImports(t *testing.T) map[string][]string {
	t.Helper()
	cmd := exec.Command("go", "list", "-f", "{{.ImportPath}} {{join .Imports \" \"}}", "./...")
	cmd.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm")
	// The repository root: this test runs in internal/bridge, and ./...
	// from anywhere shallower would miss cmd/planner — which is the one
	// package the check needs to find.
	cmd.Dir = "../.."
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list: %v\n%s", err, out)
	}
	result := map[string][]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		result[fields[0]] = fields[1:]
	}
	return result
}

// SPEC-0002 REQ "Domain Purity Preservation":
// WHEN the adapter is inspected for quantity arithmetic, graph traversal, or
// provenance rules THEN none are present; it delegates every such
// determination to the domain package.
//
// design.md names the concrete temptation: rounding a rational to something
// display-friendly on the way out. SPEC-0001 enumerates which physical
// boundaries round and in which direction, and none of them is "on the way
// to the view".
func TestAdapterHoldsNoDomainLogic(t *testing.T) {
	sources, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}

	// Arithmetic on quantities, rounding, and traversal all have
	// recognisable shapes. The adapter formats and dispatches; it does not
	// compute.
	banned := map[string]string{
		"Add":         "quantity arithmetic belongs to the domain",
		"Sub":         "quantity arithmetic belongs to the domain",
		"Mul":         "quantity arithmetic belongs to the domain",
		"Quo":         "quantity arithmetic belongs to the domain",
		"QuoRem":      "rounding belongs to the domain's enumerated boundaries",
		"Ceil":        "rounding belongs to the domain's enumerated boundaries",
		"Floor":       "rounding belongs to the domain's enumerated boundaries",
		"FloatString": "formatting a rational with fixed places truncates it",
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
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if why, bad := banned[sel.Sel.Name]; bad {
				t.Errorf("%s: %s() in the adapter — %s",
					fset.Position(call.Pos()), sel.Sel.Name, why)
			}
			return true
		})
	}
	if checked == 0 {
		t.Fatal("no adapter sources were checked")
	}
}

// SPEC-0002 REQ "Domain Purity Preservation":
// WHEN the encoding and decoding paths are exercised THEN they run under
// plain go test with no browser and no WASM build.
//
// Asserted by this file existing and passing: every other test in this
// package exercises encoding and decoding, and none of them needs a build
// tag. What is worth checking mechanically is that no adapter source has
// acquired one, which would move that behaviour out of reach.
func TestEncodingPathsNeedNoBuildTag(t *testing.T) {
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
		blob, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(blob), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "//go:build") {
				t.Errorf("%s carries %q; the encoding paths must build everywhere", path, strings.TrimSpace(line))
			}
			if strings.Contains(line, `"syscall/js"`) {
				t.Errorf("%s imports syscall/js; that belongs in cmd/planner alone", path)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no non-test adapter sources were checked")
	}
}

// SPEC-0002 REQ "Event Loop Safety":
// WHEN a resolve call executes THEN the page does not become unresponsive,
// and no deadlock occurs between the Go runtime and the JavaScript event
// loop.
//
// The issue flagged this as the requirement with the least specified
// acceptance, and asked for an operational definition before a test that
// asserts nothing. Here it is, in two parts:
//
//  1. BOUNDED. A single resolve on the largest plan the app supports returns
//     in under 50 ms. A frame is 16.7 ms at 60 Hz; three dropped frames is
//     a visible stutter and the point at which "unresponsive" starts to
//     mean something. Measured in Go rather than in a browser, because the
//     work being timed is Go's.
//
//  2. NON-BLOCKING. No entry point contains a construct that can wait on
//     the event loop: no channel operation, no select, no sleep, no
//     WaitGroup, no goroutine. A synchronous call that blocks waiting for
//     JavaScript is the standard Go/WASM deadlock, and the only way to
//     deadlock against a single-threaded event loop is to wait inside a
//     call it is making. Checked mechanically, because it is a property of
//     the code rather than of a run.
//
// The `select {}` that parks main is outside every entry point, which is
// why it is permitted and why the check is scoped to the call paths.
func TestResolveIsBoundedAndNonBlocking(t *testing.T) {
	t.Run("bounded", func(t *testing.T) {
		m := loadedModule(t)
		// Warm the path so the measurement is steady-state rather than
		// first-call parsing.
		m.Resolve(`{"target":"sd","quantity":"1"}`)

		const budget = 50 * time.Millisecond
		start := time.Now()
		env := m.Resolve(`{"target":"sd","quantity":"1000000"}`)
		elapsed := time.Since(start)

		if !env.OK {
			t.Fatalf("resolve failed: %+v", env.Error)
		}
		if elapsed > budget {
			t.Errorf("resolve took %v, over the %v budget — three frames at 60 Hz", elapsed, budget)
		}
		t.Logf("resolve of the 34-node plan at quantity 1,000,000 took %v", elapsed)
	})

	t.Run("non-blocking", func(t *testing.T) {
		assertNoBlockingConstructs(t, "module.go")
		assertNoBlockingConstructs(t, "../../cmd/planner/main.go", "main")
	})
}

// assertNoBlockingConstructs fails if any function in the file — other than
// those named in exempt — contains a construct that can wait.
func assertNoBlockingConstructs(t *testing.T, path string, exempt ...string) {
	t.Helper()
	skip := map[string]bool{}
	for _, name := range exempt {
		skip[name] = true
	}

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}

	var checked int
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || skip[fn.Name.Name] || fn.Body == nil {
			continue
		}
		checked++
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.SelectStmt:
				t.Errorf("%s: select in %s — an entry point must not wait on the event loop",
					fset.Position(node.Pos()), fn.Name.Name)
			case *ast.GoStmt:
				t.Errorf("%s: goroutine in %s — a call must be straight-line",
					fset.Position(node.Pos()), fn.Name.Name)
			case *ast.UnaryExpr:
				if node.Op == token.ARROW {
					t.Errorf("%s: channel receive in %s", fset.Position(node.Pos()), fn.Name.Name)
				}
			case *ast.SendStmt:
				t.Errorf("%s: channel send in %s", fset.Position(node.Pos()), fn.Name.Name)
			case *ast.CallExpr:
				if sel, ok := node.Fun.(*ast.SelectorExpr); ok {
					switch sel.Sel.Name {
					case "Sleep", "Wait", "Lock":
						// RWMutex.RLock and Lock are not event-loop waits —
						// they are uncontended in a single-threaded runtime.
						// Sleep and WaitGroup.Wait are.
						if sel.Sel.Name != "Lock" {
							t.Errorf("%s: %s() in %s — an entry point must not block",
								fset.Position(node.Pos()), sel.Sel.Name, fn.Name.Name)
						}
					}
				}
			}
			return true
		})
	}
	if checked == 0 {
		t.Fatalf("no functions were checked in %s, so this proves nothing", path)
	}
}

// The contract version is reported on every envelope, which is what the
// consumer's version check reads.
func TestEveryEnvelopeCarriesTheContractVersion(t *testing.T) {
	m := loadedModule(t)
	for _, name := range bridge.EntryPoints {
		out := m.CallJSON(name, `{"target":"sd","quantity":"1"}`)
		if !strings.Contains(out, `"contractVersion":"`+bridge.ContractVersion+`"`) {
			t.Errorf("%s returned an envelope without the contract version: %s", name, out)
		}
	}
}
