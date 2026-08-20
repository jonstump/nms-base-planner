//go:build ignore

// Command gen builds the recipe-graph fixtures from a real decompiled
// extraction.
//
// The rows are real: whole `<Property name="Table" ...>` blocks lifted
// verbatim out of the decompiled tables, not an approximation of their
// shape. Testing a parser against a hand-authored idea of the format tests
// only that the parser agrees with its author, which is how this project
// came to ship a PSARC reader for a format that is not PSARC.
//
// Usage, from a tree decompiled with MBINCompiler 6.45.0.1:
//
//	nmsextract extract NMSARC.Precache.pak $SRC metadata/reality/tables/
//	nmsextract extract NMSARC.Precache.pak $SRC language/
//	MBINCompiler <each .mbin>
//	go run gen.go $SRC
//
// What is kept, and why:
//
//	products, substances  the craft closure of ULTRAPROD2 — the 34-node
//	                      Stasis Device tree the engine fixture asserts —
//	                      plus CATALYST2 and every ingredient of the
//	                      recipes below, so the graph is closed. Two
//	                      known-unnamed products are included so the
//	                      allowlist is exercised rather than assumed.
//	recipes               every recipe producing one of those items. That
//	                      is 26 for CATALYST2 alone (ADR-0005's worked
//	                      example), seven of them self-referential, and it
//	                      includes yields other than one.
//	localisation          only the Id and English properties of the keys
//	                      the emitted items name. The real rows carry
//	                      fifteen further translations that no code here
//	                      reads; projecting them away keeps the fixture to
//	                      what is under test.
package main

import (
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The seeds. Each is here for a property the fixture has to exercise
// against real rows rather than an invented approximation of them.
var seeds = []string{
	"ULTRAPROD2",     // the Stasis Device: a 34-item craft closure
	"CATALYST2",      // Sodium Nitrate: 26 refine recipes, seven self-referential
	"FOOD_P_STELLAR", // a cooked product, so the Cooking flag has both values
	"AMMO",           // the one product in the table that crafts 25 at a time
}

// knownUnnamed products, included so the allowlist path is exercised. These
// carry NameLower keys no English table defines.
var unnamed = []string{"CHART_BUILDER", "WORLDSMB_SOUL"}

type node struct {
	Name  string `xml:"name,attr"`
	Value string `xml:"value,attr"`
	ID    string `xml:"_id,attr"`
	Props []node `xml:"Property"`
}

type doc struct {
	Props []node `xml:"Property"`
}

func (n node) child(name string) (node, bool) {
	for _, p := range n.Props {
		if p.Name == name {
			return p, true
		}
	}
	return node{}, false
}

func (n node) children(name string) []node {
	var out []node
	for _, p := range n.Props {
		if p.Name == name {
			out = append(out, p)
		}
	}
	return out
}

func (n node) str(name string) string {
	c, _ := n.child(name)
	return c.Value
}

// table is one parsed source file, keeping both the structure (for the
// closure) and each row's original text (for the slice).
type table struct {
	path   string
	header []string
	rows   map[string]node
	text   map[string]string
	order  []string
}

func load(path, wrapper, rowValue string) (*table, error) {
	blob, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var d doc
	if err := xml.Unmarshal(blob, &d); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}

	t := &table{path: path, rows: map[string]node{}, text: map[string]string{}}
	for _, p := range d.Props {
		if p.Name != wrapper {
			continue
		}
		for _, r := range p.children(wrapper) {
			if r.Value != rowValue {
				return nil, fmt.Errorf("%s: row %q has value %q, want %q", path, r.ID, r.Value, rowValue)
			}
			t.rows[r.ID] = r
			t.order = append(t.order, r.ID)
		}
	}

	// Rows sit at one indent level inside the wrapper and close on a line
	// that is exactly that indent, which makes the slice a scan rather than
	// a parse.
	const open = `<Property name="Table" value="`
	lines := strings.Split(string(blob), "\n")
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		if !strings.Contains(l, open) || !strings.Contains(l, `_id="`) {
			continue
		}
		id := between(l, `_id="`, `"`)
		indent := l[:len(l)-len(strings.TrimLeft(l, "\t"))]
		row := []string{l}
		for i++; i < len(lines); i++ {
			row = append(row, lines[i])
			if lines[i] == indent+"</Property>" {
				break
			}
		}
		t.text[id] = strings.Join(row, "\n")
	}
	for _, id := range t.order {
		if _, ok := t.text[id]; !ok {
			return nil, fmt.Errorf("%s: no text sliced for row %q", path, id)
		}
	}
	return t, nil
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run gen.go <decompiled-source-root>")
		os.Exit(2)
	}
	src := os.Args[1]
	tables := filepath.Join(src, "metadata/reality/tables")

	products := must(load(filepath.Join(tables, "nms_reality_gcproducttable.MXML"), "Table", "GcProductData"))
	substances := must(load(filepath.Join(tables, "nms_reality_gcsubstancetable.MXML"), "Table", "GcRealitySubstanceData"))
	recipes := must(load(filepath.Join(tables, "nms_reality_gcrecipetable.MXML"), "Table", "GcRefinerRecipe"))

	// Craft closure: a product's Requirements name the items it is built
	// from, and those items' own requirements in turn.
	core := map[string]bool{}
	stack := append([]string(nil), seeds...)
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if core[id] {
			continue
		}
		core[id] = true
		r, ok := products.rows[id]
		if !ok {
			continue
		}
		reqs, ok := r.child("Requirements")
		if !ok {
			continue
		}
		for _, e := range reqs.children("Requirements") {
			stack = append(stack, e.str("ID"))
		}
	}

	// Every recipe producing a core item, and every ingredient it names.
	items := map[string]bool{}
	for id := range core {
		items[id] = true
	}
	keptRecipes := map[string]bool{}
	for _, rid := range recipes.order {
		r := recipes.rows[rid]
		result, ok := r.child("Result")
		if !ok {
			continue
		}
		if !core[result.str("Id")] {
			continue
		}
		keptRecipes[rid] = true
		ing, ok := r.child("Ingredients")
		if !ok {
			continue
		}
		for _, e := range ing.children("Ingredients") {
			items[e.str("Id")] = true
		}
	}
	for _, id := range unnamed {
		items[id] = true
	}

	// Localisation keys: every emitted item's NameLower, minus the ones the
	// allowlist expects to be absent.
	keys := map[string]bool{}
	skip := map[string]bool{}
	for _, id := range unnamed {
		skip[id] = true
	}
	for _, t := range []*table{products, substances} {
		for id, r := range t.rows {
			if items[id] && !skip[id] {
				keys[r.str("NameLower")] = true
			}
		}
	}

	must0(emit("products.MXML", "cGcProductTable", products, items))
	must0(emit("substances.MXML", "cGcSubstanceTable", substances, items))
	must0(emit("recipes.MXML", "cGcRecipeTable", recipes, keptRecipes))
	must0(emitLocalisation(filepath.Join(src, "language"), keys))

	fmt.Printf("items %d (core %d), recipes %d, localisation keys %d\n",
		len(items), len(core), len(keptRecipes), len(keys))
}

// emit writes the selected rows of a table, verbatim.
func emit(dst, template string, t *table, keep map[string]bool) error {
	out := []string{`<?xml version="1.0" encoding="utf-8"?>`,
		`<!--File created using MBINCompiler version (6.45.0.1)-->`,
		`<Data template="` + template + `">`,
		"\t" + `<Property name="Table">`}
	n := 0
	for _, id := range t.order {
		if !keep[id] {
			continue
		}
		out = append(out, t.text[id])
		n++
	}
	if n == 0 {
		return fmt.Errorf("%s: no rows selected", dst)
	}
	out = append(out, "\t</Property>", "</Data>", "")
	return os.WriteFile(dst, []byte(strings.Join(out, "\n")), 0o644)
}

// emitLocalisation projects each wanted key to its Id and English value.
//
// A key absent from every table is an error here rather than an omission:
// the fixture exists to prove names resolve, and one that quietly lacks a
// key would make the resolution test pass for the wrong reason.
func emitLocalisation(dir string, keys map[string]bool) error {
	files, err := filepath.Glob(filepath.Join(dir, "nms_*_english.MXML"))
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("%s: no english localisation tables", dir)
	}
	sort.Strings(files)

	found := map[string]string{}
	for _, f := range files {
		t, err := load(f, "Table", "TkLocalisationEntry")
		if err != nil {
			return err
		}
		for id, r := range t.rows {
			if keys[id] {
				found[id] = r.str("English")
			}
		}
	}
	var missing []string
	for k := range keys {
		if _, ok := found[k]; !ok {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return fmt.Errorf("localisation keys not found in %v: %v", files, missing)
	}

	ids := make([]string, 0, len(found))
	for k := range found {
		ids = append(ids, k)
	}
	sort.Strings(ids)

	out := []string{`<?xml version="1.0" encoding="utf-8"?>`,
		`<!--File created using MBINCompiler version (6.45.0.1)-->`,
		`<Data template="cTkLocalisationTable">`,
		"\t" + `<Property name="Table">`}
	for _, id := range ids {
		out = append(out,
			"\t\t"+`<Property name="Table" value="TkLocalisationEntry" _id="`+esc(id)+`">`,
			"\t\t\t"+`<Property name="Id" value="`+esc(id)+`" />`,
			"\t\t\t"+`<Property name="English" value="`+esc(found[id])+`" />`,
			"\t\t"+`</Property>`)
	}
	out = append(out, "\t</Property>", "</Data>", "")
	return os.WriteFile("localisation.MXML", []byte(strings.Join(out, "\n")), 0o644)
}

func esc(s string) string {
	var b strings.Builder
	xml.EscapeText(&b, []byte(s))
	return b.String()
}

func between(s, open, close string) string {
	i := strings.Index(s, open)
	if i < 0 {
		return ""
	}
	s = s[i+len(open):]
	j := strings.Index(s, close)
	if j < 0 {
		return ""
	}
	return s[:j]
}

func must(t *table, err error) *table {
	must0(err)
	return t
}

func must0(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
