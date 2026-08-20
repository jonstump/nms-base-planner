package normalize

import (
	"fmt"
	"path/filepath"

	"github.com/jonstump/nms-base-planner/internal/domain"
)

// Governing: ADR-0001 (two-tier NMS data ingestion), ADR-0005 (multiple
// recipes per output), SPEC-0004 REQ "Recipe Graph Construction",
// REQ "Identifier Policy", REQ "Display Name Resolution",
// REQ "Excluded Content"

// Sources names the decompiled tables the recipe graph is built from.
type Sources struct {
	// Products is nms_reality_gcproducttable.MXML.
	Products string
	// Substances is nms_reality_gcsubstancetable.MXML.
	Substances string
	// Recipes is nms_reality_gcrecipetable.MXML — refining and cooking, one
	// table distinguished by a per-recipe Cooking flag.
	Recipes string
	// Localisation is the set of language/nms_loc*_english.MXML files.
	Localisation []string
}

// Graph is what the reality tables yield: the artifact's items and recipes,
// plus the counts a reader needs to tell a complete extraction from a
// quietly partial one.
type Graph struct {
	Items   []domain.Item
	Recipes []domain.Recipe

	// SelfReferentialOmitted counts recipes dropped for naming their own
	// output among their ingredients.
	//
	// Governing: SPEC-0004 REQ "Recipe Graph Construction"
	SelfReferentialOmitted int

	// UnnamedOmitted lists items dropped because no English table defines
	// their name key, sorted. Every one is checked to be unreferenced.
	UnnamedOmitted []string

	// LocalisationFiles records which tables the name resolution read.
	//
	// Governing: SPEC-0004 REQ "Search Boundaries Are Recorded"
	LocalisationFiles []string
}

// BuildGraph parses the reality tables into the artifact's items and recipes.
//
// Identifiers are the game's own, verbatim: ULTRAPROD2, PLANT_SNOW. They are
// never normalized or case-folded, because they are what save files carry
// and what ADR-0002's import will join against, and a bespoke scheme would
// have to be re-derived and re-verified on every regeneration.
//
// Only structure and quantities are read. Description, Subtitle, Hint and
// asset paths are never touched — per ADR-0001 that text is Hello Games'
// creative expression, and exclusion by construction beats exclusion by
// filtering.
func BuildGraph(src Sources) (*Graph, error) {
	loc, err := LoadLocalisation(src.Localisation)
	if err != nil {
		return nil, err
	}

	subItems, err := parseSubstances(src.Substances, loc)
	if err != nil {
		return nil, err
	}
	prodItems, craft, skipped, err := parseProducts(src.Products, loc)
	if err != nil {
		return nil, err
	}
	refined, selfRef, err := parseRecipes(src.Recipes)
	if err != nil {
		return nil, err
	}

	items := append(subItems, prodItems...)
	recipes := append(craft, refined...)

	resolveMethods(items, recipes)

	// Omitting an unnamed item is only safe while nothing references it.
	// Asserted rather than assumed: a game update could start using one, and
	// the failure would otherwise be a silently incomplete graph.
	if err := checkSkippedUnreferenced(skipped, recipes); err != nil {
		return nil, err
	}
	if err := checkClosed(items, recipes); err != nil {
		return nil, err
	}
	return &Graph{
		Items:                  items,
		Recipes:                recipes,
		SelfReferentialOmitted: selfRef,
		UnnamedOmitted:         sortedStrings(skipped),
		LocalisationFiles:      loc.Files(),
	}, nil
}

// parseSubstances reads the substance table. Substances have no recipe of
// their own; anything craftable from them lives in the product or recipe
// tables.
func parseSubstances(path string, loc *Localisation) ([]domain.Item, error) {
	name := filepath.Base(path)
	doc, err := readMXML(path, "cGcSubstanceTable")
	if err != nil {
		return nil, err
	}
	rows, err := doc.rows(name, "Table", "GcRealitySubstanceData")
	if err != nil {
		return nil, err
	}
	items := make([]domain.Item, 0, len(rows))
	for _, r := range rows {
		id, err := r.nonEmpty(name, r.ID, "ID")
		if err != nil {
			return nil, err
		}
		key, err := r.nonEmpty(name, id, "NameLower")
		if err != nil {
			return nil, err
		}
		display, err := loc.Resolve(name, id, key)
		if err != nil {
			return nil, err
		}
		items = append(items, domain.Item{ID: id, Name: display})
	}
	return items, nil
}

// parseProducts reads the product table, emitting one item per product and a
// craft recipe for every product that declares requirements.
//
// A product declares exactly one craft route: AltRequirements is present on
// every row and empty on all 2,144 of them. The recipe therefore takes the
// product's own ID, which is unique by construction and stable across
// regenerations — the two things SPEC-0001 REQ "Recipe Selection" needs of
// an identifier a plan can record.
func parseProducts(path string, loc *Localisation) ([]domain.Item, []domain.Recipe, []string, error) {
	name := filepath.Base(path)
	doc, err := readMXML(path, "cGcProductTable")
	if err != nil {
		return nil, nil, nil, err
	}
	rows, err := doc.rows(name, "Table", "GcProductData")
	if err != nil {
		return nil, nil, nil, err
	}
	items := make([]domain.Item, 0, len(rows))
	var recipes []domain.Recipe
	var skipped []string
	for _, r := range rows {
		id, err := r.nonEmpty(name, r.ID, "ID")
		if err != nil {
			return nil, nil, nil, err
		}
		key, err := r.nonEmpty(name, id, "NameLower")
		if err != nil {
			return nil, nil, nil, err
		}
		display, err := loc.Resolve(name, id, key)
		if err != nil {
			// A handful of products carry keys no English table defines.
			// The allowlist is enumerated and checked by ID *and* key, so a
			// game update that renames one fails here rather than being
			// skipped on a stale entry.
			if skipUnnamed(id, key) {
				skipped = append(skipped, id)
				continue
			}
			return nil, nil, nil, err
		}
		items = append(items, domain.Item{ID: id, Name: display})

		// A second craft route would need a second recipe id, and the id
		// scheme above assumes there is only one. Checked rather than
		// assumed, so a game update that starts using AltRequirements fails
		// here instead of silently colliding two recipes onto one id.
		if alt, ok := r.child("AltRequirements"); ok && len(alt.children("AltRequirements")) > 0 {
			return nil, nil, nil, Unrecognized(name, id, "AltRequirements",
				"empty, as on every product in NMS 5.97", "an alternative craft route")
		}

		reqs, ok := r.child("Requirements")
		if !ok {
			continue
		}
		inputs, err := parseRequirements(name, id, reqs)
		if err != nil {
			return nil, nil, nil, err
		}
		if len(inputs) == 0 {
			continue
		}
		// The yield is read, never assumed: 2,143 products craft one at a
		// time and exactly one crafts 25, which is precisely the shape of
		// error a default would hide.
		// Governing: SPEC-0004 REQ "Recipe Graph Construction" — "A yield
		// MUST NOT default silently to one."
		yield, err := r.int64(name, id, "DefaultCraftAmount")
		if err != nil {
			return nil, nil, nil, err
		}
		if yield <= 0 {
			return nil, nil, nil, Unrecognized(name, id, "DefaultCraftAmount", "a positive quantity", yield)
		}
		recipes = append(recipes, domain.Recipe{
			ID:     id,
			Output: id,
			Method: domain.MethodCraft,
			Inputs: inputs,
			Yield:  yield,
		})
	}
	return items, recipes, skipped, nil
}

// parseRequirements reads a product's crafting inputs.
func parseRequirements(table, row string, reqs node) ([]domain.Input, error) {
	var out []domain.Input
	for _, e := range reqs.children("Requirements") {
		id, err := e.nonEmpty(table, row, "ID")
		if err != nil {
			return nil, err
		}
		amt, err := e.int64(table, row, "Amount")
		if err != nil {
			return nil, err
		}
		if amt <= 0 {
			// A non-positive requirement is a structural surprise, not a
			// free ingredient; the rollup engine rejects it downstream and
			// the error is more useful here.
			return nil, Unrecognized(table, row, "Amount", "a positive quantity", amt)
		}
		out = append(out, domain.Input{Item: id, Quantity: amt})
	}
	return out, nil
}

// parseRecipes reads the refiner table, returning every recipe it defines
// and the count of self-referential ones omitted.
//
// One table carries both refining and cooking, distinguished by the
// per-recipe Cooking flag — which is why the design's question about whether
// cooking needs a separate source resolves to "no".
//
// Nothing is selected or deduplicated here. Per ADR-0005 the artifact
// carries every route the game defines — 261 of 403 output/method pairs have
// more than one, up to 61 — and choosing between them requires expansion
// this pass does not perform.
func parseRecipes(path string) ([]domain.Recipe, int, error) {
	name := filepath.Base(path)
	doc, err := readMXML(path, "cGcRecipeTable")
	if err != nil {
		return nil, 0, err
	}
	rows, err := doc.rows(name, "Table", "GcRefinerRecipe")
	if err != nil {
		return nil, 0, err
	}
	var out []domain.Recipe
	var selfReferential int
	for _, r := range rows {
		rid, err := r.nonEmpty(name, r.ID, "Id")
		if err != nil {
			return nil, 0, err
		}
		cooking, err := r.boolean(name, rid, "Cooking")
		if err != nil {
			return nil, 0, err
		}
		method := domain.MethodRefine
		if cooking {
			method = domain.MethodCook
		}

		result, ok := r.child("Result")
		if !ok {
			return nil, 0, Unrecognized(name, rid, "Result", "present", "absent")
		}
		outID, err := result.nonEmpty(name, rid, "Id")
		if err != nil {
			return nil, 0, err
		}
		yield, err := result.int64(name, rid, "Amount")
		if err != nil {
			return nil, 0, err
		}
		if yield <= 0 {
			return nil, 0, Unrecognized(name, rid, "Result/Amount", "a positive quantity", yield)
		}

		ing, ok := r.child("Ingredients")
		if !ok {
			return nil, 0, Unrecognized(name, rid, "Ingredients", "present", "absent")
		}
		var inputs []domain.Input
		selfRef := false
		for _, e := range ing.children("Ingredients") {
			id, err := e.nonEmpty(name, rid, "Id")
			if err != nil {
				return nil, 0, err
			}
			amt, err := e.int64(name, rid, "Amount")
			if err != nil {
				return nil, 0, err
			}
			if amt <= 0 {
				return nil, 0, Unrecognized(name, rid, "Amount", "a positive quantity", amt)
			}
			if id == outID {
				selfRef = true
			}
			inputs = append(inputs, domain.Input{Item: id, Quantity: amt})
		}
		if len(inputs) == 0 {
			return nil, 0, Unrecognized(name, rid, "Ingredients", "at least one ingredient", "none")
		}
		// A recipe naming its own output among its ingredients is a
		// doubling strategy, not a production path, and expanding it is a
		// cycle. Counted rather than silently dropped, so a change in the
		// number is visible in provenance.
		// Governing: SPEC-0004 REQ "Recipe Graph Construction".
		if selfRef {
			selfReferential++
			continue
		}
		out = append(out, domain.Recipe{
			ID:     rid,
			Output: outID,
			Method: method,
			Inputs: inputs,
			Yield:  yield,
		})
	}
	return out, selfReferential, nil
}

// resolveMethods assigns each item its default method and marks the leaves.
//
// Precedence is craft, then refine, then cook, then raw. An item with no
// recipe at all becomes a raw-obtainable terminal, which is what the rollup
// engine's terminal-node handling expects to find at the bottom of a tree.
func resolveMethods(items []domain.Item, recipes []domain.Recipe) {
	byOutput := make(map[string]map[domain.Method]bool, len(recipes))
	for _, r := range recipes {
		m, ok := byOutput[r.Output]
		if !ok {
			m = make(map[domain.Method]bool, 3)
			byOutput[r.Output] = m
		}
		m[r.Method] = true
	}
	for i := range items {
		methods := byOutput[items[i].ID]
		switch {
		case methods[domain.MethodCraft]:
			items[i].DefaultMethod = domain.MethodCraft
		case methods[domain.MethodRefine]:
			items[i].DefaultMethod = domain.MethodRefine
		case methods[domain.MethodCook]:
			items[i].DefaultMethod = domain.MethodCook
		default:
			items[i].DefaultMethod = domain.MethodRaw
			items[i].RawObtainable = true
		}
	}
}

// checkClosed verifies every recipe endpoint resolves to an item in the
// artifact, and that no two recipes for one output and method share an id.
//
// Governing: SPEC-0004 REQ "Recipe Graph Construction" — a dangling edge
// fails generation rather than being emitted, because the rollup engine
// would otherwise resolve a tree with a hole in it.
func checkClosed(items []domain.Item, recipes []domain.Recipe) error {
	known := make(map[string]bool, len(items))
	for _, it := range items {
		known[it.ID] = true
	}
	seen := make(map[string]bool, len(recipes))
	for _, r := range recipes {
		if !known[r.Output] {
			return Unresolved("recipe graph", r.Output, "output", r.Output)
		}
		// A plan records a recipe by id, so a collision would make two
		// different routes indistinguishable in saved plan state.
		// Governing: SPEC-0001 REQ "Recipe Selection".
		key := r.Output + "\x00" + string(r.Method) + "\x00" + r.ID
		if seen[key] {
			return Unrecognized("recipe graph", r.Output, "recipe id",
				"one recipe per id for an output and method", fmt.Sprintf("a second %q", r.ID))
		}
		seen[key] = true
		for _, in := range r.Inputs {
			if !known[in.Item] {
				return Unresolved("recipe graph", r.Output, "input", in.Item)
			}
		}
	}
	return nil
}

// checkSkippedUnreferenced verifies that no omitted known-unnamed item is
// named by a recipe.
//
// Governing: SPEC-0004 REQ "Display Name Resolution" — the allowlist omits
// items that have no display name. That is only defensible while they are
// unreachable; the moment one becomes an ingredient, omitting it would open
// a hole in the graph instead of trimming a leaf.
func checkSkippedUnreferenced(skipped []string, recipes []domain.Recipe) error {
	if len(skipped) == 0 {
		return nil
	}
	omitted := make(map[string]bool, len(skipped))
	for _, id := range skipped {
		omitted[id] = true
	}
	for _, r := range recipes {
		if omitted[r.Output] {
			return Unrecognized("recipe graph", r.Output, "output",
				"a named item, or no recipe at all", "a recipe producing a known-unnamed item")
		}
		for _, in := range r.Inputs {
			if omitted[in.Item] {
				return Unrecognized("recipe graph", r.Output, "input",
					"a named item", "a known-unnamed item used as an ingredient")
			}
		}
	}
	return nil
}
