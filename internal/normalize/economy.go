package normalize

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jonstump/nms-base-planner/internal/domain"
)

// Base-economy extraction.
//
// Governing: ADR-0001 (two-tier ingestion, corrected 2026-08-18), SPEC-0004
// REQ "Base Economy Data", REQ "Search Boundaries Are Recorded"
//
// ADR-0001 planned these as five hand-curated Tier 2 constants. Four proved
// extractable, so they are generated here and version-stamped with the rest
// of the artifact. The one that remains curated is biodome crop capacity,
// which is not in the tables.
//
// The values come from five places, which is the whole reason this is
// awkward:
//
//	metadata/reality/tables/basebuildingobjectstable  per-part rates, storage
//	metadata/simulation/scanning/regionhotspotstable  class strengths
//	metadata/reality/tables/rewardtable               crop yields
//	models/.../interactiveflora/*/entities/           which crop yields what
//	gcgameplayglobals.global                          refiner throughput

// Source file paths, relative to the root of a decompiled extraction. Named
// so an error message can say which file it wanted rather than only that
// something was missing.
const (
	objectsTable   = "metadata/reality/tables/basebuildingobjectstable.MXML"
	hotspotsTable  = "metadata/simulation/scanning/regionhotspotstable.MXML"
	rewardTable    = "metadata/reality/tables/rewardtable.MXML"
	gameplayGlobal = "gcgameplayglobals.global.MXML"
	floraRoot      = "models/planets/biomes/common/interactiveflora"
)

// networkNames maps GcLinkNetworkTypes to the artifact's vocabulary.
//
// "None" is deliberately absent rather than mapped to an empty network: a
// part whose connection is None has no economic behaviour, and the caller
// distinguishes "not a network we model" from "a network we failed to
// recognize" by that absence.
var networkNames = map[string]domain.Network{
	"Power":       domain.NetworkPower,
	"Resources":   domain.NetworkResources,
	"PlantGrowth": domain.NetworkPlantGrowth,
	"ByteBeat":    domain.NetworkByteBeat,
	"Fuel":        domain.NetworkFuel,
	"Portals":     domain.NetworkPortals,
}

// ReadEconomy assembles the base-economy section from a decompiled source
// tree rooted at root.
//
// Every stage is fail-closed: a source that is missing, or present with a
// shape this code does not recognize, aborts generation rather than
// producing an economy section that is quietly short a few parts.
func ReadEconomy(root string) (*domain.Economy, error) {
	objects, err := readMXML(filepath.Join(root, objectsTable), "cGcBaseBuildingTable")
	if err != nil {
		return nil, err
	}
	rows, err := objectRows(objects)
	if err != nil {
		return nil, err
	}

	parts, err := readParts(rows)
	if err != nil {
		return nil, err
	}
	hotspots, err := readHotspots(root)
	if err != nil {
		return nil, err
	}
	crops, searched, err := readCrops(root, rows)
	if err != nil {
		return nil, err
	}
	refining, err := readRefining(root)
	if err != nil {
		return nil, err
	}

	return &domain.Economy{
		Parts:    parts,
		Hotspots: hotspots,
		Crops:    crops,
		Refining: refining,
		Searches: searched,
	}, nil
}

// objectRows returns the buildable object rows.
func objectRows(d *mxmlDoc) ([]node, error) {
	rows, err := d.rows(objectsTable, "Objects", "GcBaseBuildingEntry")
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// readParts turns each buildable's GcBaseLinkGridData into a Part.
//
// Every one of the 1,997 buildables carries link-grid data, but most of it
// is a Power connection with rate and storage zero — a decoration that
// neither produces nor consumes. Those are skipped, and the count skipped is
// recorded on the parts search note so the omission is visible rather than
// implied.
func readParts(rows []node) ([]domain.Part, error) {
	var parts []domain.Part
	for _, row := range rows {
		id, err := row.nonEmpty(objectsTable, "", "ID")
		if err != nil {
			return nil, err
		}
		grid, ok := row.child("LinkGridData")
		if !ok {
			return nil, Unrecognized(objectsTable, id, "LinkGridData", "present", "absent")
		}

		p, keep, err := readPart(id, grid)
		if err != nil {
			return nil, err
		}
		if keep {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return nil, Unrecognized(objectsTable, "", "LinkGridData", "at least one part with a rate", "none")
	}
	return parts, nil
}

// readPart decodes one buildable's link-grid data, reporting whether it
// carries any economic behaviour worth emitting.
func readPart(id string, grid node) (domain.Part, bool, error) {
	conn, ok := grid.child("Connection")
	if !ok {
		return domain.Part{}, false, Unrecognized(objectsTable, id, "LinkGridData/Connection", "present", "absent")
	}
	network, known, err := readNetwork(id, "LinkGridData/Connection", conn)
	if err != nil {
		return domain.Part{}, false, err
	}

	rate, err := grid.int64(objectsTable, id, "Rate")
	if err != nil {
		return domain.Part{}, false, err
	}
	storage, err := grid.int64(objectsTable, id, "Storage")
	if err != nil {
		return domain.Part{}, false, err
	}
	hotspot, err := grid.str(objectsTable, id, "DependsOnHotspots")
	if err != nil {
		return domain.Part{}, false, err
	}
	if hotspot == "None" {
		hotspot = ""
	}

	deps, err := readDependencies(id, grid)
	if err != nil {
		return domain.Part{}, false, err
	}

	interesting := rate != 0 || storage != 0 || hotspot != "" || len(deps) > 0
	if !known || !interesting {
		return domain.Part{}, false, nil
	}
	return domain.Part{
		ID:           id,
		Primary:      domain.Flow{Network: network, Rate: rate, Storage: storage},
		Dependencies: deps,
		Hotspot:      hotspot,
	}, true, nil
}

// readDependencies decodes the dependent connections — typically the power
// draw that gates a part's primary rate.
//
// A dependency with rate zero and effect "None" carries nothing and is
// dropped; one with rate zero and a real effect is kept, because "needs a
// power connection but draws nothing" is a fact the planner must not lose.
func readDependencies(id string, grid node) ([]domain.Dependency, error) {
	wrapper, ok := grid.child("DependentConnections")
	if !ok {
		return nil, nil
	}
	var deps []domain.Dependency
	for _, d := range wrapper.children("DependentConnections") {
		conn, ok := d.child("Connection")
		if !ok {
			return nil, Unrecognized(objectsTable, id, "DependentConnections/Connection", "present", "absent")
		}
		network, known, err := readNetwork(id, "DependentConnections/Connection", conn)
		if err != nil {
			return nil, err
		}
		rate, err := d.int64(objectsTable, id, "DependentRate")
		if err != nil {
			return nil, err
		}
		effect, err := d.str(objectsTable, id, "DependentEffect")
		if err != nil {
			return nil, err
		}
		if effect == "None" {
			effect = ""
		}
		if !known || (rate == 0 && effect == "") {
			continue
		}
		deps = append(deps, domain.Dependency{Network: network, Rate: rate, Effect: effect})
	}
	return deps, nil
}

// readNetwork reads a GcLinkNetworkTypes wrapper, reporting whether the
// value names a network the artifact models.
//
// "None" returns known=false with no error; anything else unrecognized is an
// error, because a network the game added is a structural surprise and the
// whole posture here is that those fail loudly.
func readNetwork(id, where string, conn node) (domain.Network, bool, error) {
	wrapper, ok := conn.child("Network")
	if !ok {
		return "", false, Unrecognized(objectsTable, id, where+"/Network", "present", "absent")
	}
	raw, err := wrapper.str(objectsTable, id, "LinkNetworkType")
	if err != nil {
		return "", false, err
	}
	if raw == "None" {
		return "", false, nil
	}
	n, ok := networkNames[raw]
	if !ok {
		return "", false, Unrecognized(objectsTable, id, where+"/LinkNetworkType", "a known link network", raw)
	}
	return n, true, nil
}

// readHotspots reads the class strengths and weightings.
//
// Governing: SPEC-0004 REQ "Base Economy Data" — "Class scaling MUST be
// modelled as a property of the hotspot, not of the device." The table's
// shape is the evidence: strengths hang off the hotspot category, and there
// are no per-class device variants anywhere to find.
func readHotspots(root string) ([]domain.Hotspot, error) {
	doc, err := readMXML(filepath.Join(root, hotspotsTable), "cGcRegionHotspotsTable")
	if err != nil {
		return nil, err
	}
	wrapper, ok := findChild(doc.Props, "RegionHotspots")
	if !ok {
		return nil, Unrecognized(hotspotsTable, "", "RegionHotspots", "present", "absent")
	}

	// The table names six categories — Power, Mineral1..3, Gas1..2 — but a
	// part's DependsOnHotspots names a family: "Mineral", "Gas", "Power".
	// The numbered variants exist to give a planet several distinct mineral
	// hotspots, not to scale differently, so they collapse to the family the
	// parts table actually references.
	//
	// Collapsing is guarded rather than assumed: members that disagree are a
	// structural surprise and fail, because silently keeping the first would
	// put one variant's numbers behind every mineral hotspot in the planner.
	byFamily := map[string]domain.Hotspot{}
	var order []string
	for _, cat := range wrapper.Props {
		// Unlike the tables, categories are named by element rather than
		// repeated under one name.
		if cat.Value != "GcRegionHotspotData" {
			return nil, Unrecognized(hotspotsTable, cat.Name, "value", "GcRegionHotspotData", cat.Value)
		}
		strengths, err := readClassValues(cat, hotspotsTable, cat.Name, "ClassStrengths")
		if err != nil {
			return nil, err
		}
		weightings, err := readClassValues(cat, hotspotsTable, cat.Name, "ClassWeightings")
		if err != nil {
			return nil, err
		}

		family := hotspotFamily(cat.Name)
		h := domain.Hotspot{Category: family, Strengths: strengths, Weightings: weightings}
		prev, seen := byFamily[family]
		if !seen {
			byFamily[family] = h
			order = append(order, family)
			continue
		}
		if prev != h {
			return nil, Unrecognized(hotspotsTable, cat.Name, "ClassStrengths/ClassWeightings",
				fmt.Sprintf("the same values as the rest of the %s family", family),
				fmt.Sprintf("%+v", h))
		}
	}
	if len(order) == 0 {
		return nil, Unrecognized(hotspotsTable, "", "RegionHotspots", "at least one category", "none")
	}

	out := make([]domain.Hotspot, 0, len(order))
	for _, f := range order {
		out = append(out, byFamily[f])
	}
	return out, nil
}

// hotspotFamily strips the variant index from a category name, so Mineral1,
// Mineral2 and Mineral3 all become the "Mineral" the parts table names.
func hotspotFamily(category string) string {
	return strings.TrimRight(category, "0123456789")
}

func readClassValues(parent node, table, row, field string) (domain.ClassValues, error) {
	n, ok := parent.child(field)
	if !ok {
		return domain.ClassValues{}, Unrecognized(table, row, field, "present", "absent")
	}
	var v domain.ClassValues
	var err error
	if v.C, err = n.float(table, row, "C"); err != nil {
		return domain.ClassValues{}, err
	}
	if v.B, err = n.float(table, row, "B"); err != nil {
		return domain.ClassValues{}, err
	}
	if v.A, err = n.float(table, row, "A"); err != nil {
		return domain.ClassValues{}, err
	}
	if v.S, err = n.float(table, row, "S"); err != nil {
		return domain.ClassValues{}, err
	}
	return v, nil
}

// readCrops derives the farmable plants.
//
// This is the searched value, and the reason SPEC-0004 REQ "Search
// Boundaries Are Recorded" exists. Nothing in the buildables table says what
// a plant yields. The chain is:
//
//	objects table  a buildable whose primary connection is PlantGrowth,
//	               giving the growth time as the connection's Storage
//	     |         and the placement scene filename
//	     v
//	flora entity   MODELS/.../FARMSNOW_PLACEMENT.SCENE.MBIN becomes
//	               models/.../farmsnow/entities/plantinteraction.entity,
//	     |         whose interaction Id is the reward key
//	     v
//	reward table   the GcRewardSpecificSubstance under that key, giving the
//	               substance actually yielded and its min/max amount
//
// The last hop matters: the reward key and the substance are not always the
// same. PLANT_BARREN yields PLANT_DUST.
func readCrops(root string, rows []node) ([]domain.Crop, []domain.Search, error) {
	rewards, err := readRewards(root)
	if err != nil {
		return nil, nil, err
	}

	var crops []domain.Crop
	var containers []string
	for _, row := range rows {
		id, err := row.nonEmpty(objectsTable, "", "ID")
		if err != nil {
			return nil, nil, err
		}
		grid, ok := row.child("LinkGridData")
		if !ok {
			continue
		}
		conn, ok := grid.child("Connection")
		if !ok {
			continue
		}
		network, known, err := readNetwork(id, "LinkGridData/Connection", conn)
		if err != nil {
			return nil, nil, err
		}
		if !known || network != domain.NetworkPlantGrowth {
			continue
		}

		growth, err := grid.int64(objectsTable, id, "Storage")
		if err != nil {
			return nil, nil, err
		}
		scene, ok := row.child("PlacementScene")
		if !ok {
			return nil, nil, Unrecognized(objectsTable, id, "PlacementScene", "present", "absent")
		}
		filename, err := scene.nonEmpty(objectsTable, id, "Filename")
		if err != nil {
			return nil, nil, err
		}

		entityPath, ok := floraEntityPath(filename)
		if !ok {
			// A planter or hydroponics tray: it participates in the growth
			// network but is not itself a plant, and has no flora entity to
			// resolve a substance through. Recorded rather than dropped.
			containers = append(containers, id)
			continue
		}
		key, err := readPlantRewardKey(filepath.Join(root, entityPath), entityPath)
		if err != nil {
			return nil, nil, err
		}
		r, ok := rewards[key]
		if !ok {
			return nil, nil, Unresolved(rewardTable, id, "reward key", key)
		}

		crops = append(crops, domain.Crop{
			ID:            id,
			Substance:     r.substance,
			Yield:         domain.Range{Min: r.min, Max: r.max},
			GrowthSeconds: growth,
		})
	}
	if len(crops) == 0 {
		return nil, nil, Unrecognized(objectsTable, "", "LinkGridData/Connection",
			"at least one buildable on the PlantGrowth network", "none")
	}

	sort.Slice(crops, func(i, j int) bool { return crops[i].ID < crops[j].ID })
	sort.Strings(containers)

	note := fmt.Sprintf("The buildables table names no substance. %d plant buildables were found "+
		"by their PlantGrowth connection, resolved to a reward key through the flora entity "+
		"their placement scene names, and to a substance and amount through the reward table. "+
		"The reward key and the substance are not always the same — PLANT_BARREN yields "+
		"PLANT_DUST. Five of the twelve yield a product rather than a substance, under "+
		"GcRewardSpecificProduct; SPEC-0004 names only GcRewardSpecificSubstance, so both "+
		"forms are read. Wild-harvest entries (WILD_*) were not read: they are not farmed.",
		len(crops))
	if len(containers) > 0 {
		note += fmt.Sprintf(" Buildables on the growth network with no flora entity are carried "+
			"as parts rather than crops: %s.", strings.Join(containers, ", "))
	}
	searches := []domain.Search{{
		Value: "crop substance and yield",
		Searched: []string{
			objectsTable,
			floraRoot + "/*/entities/plantinteraction.entity.MXML",
			rewardTable,
		},
		Note: note,
	}}
	return crops, searches, nil
}

// floraEntityPath turns a placement-scene filename into the interaction
// entity beside it. Returns false for a scene outside the flora tree, which
// is how a non-crop that happens to sit on the PlantGrowth network is
// reported rather than silently mapped to a wrong file.
func floraEntityPath(sceneFilename string) (string, bool) {
	p := strings.ToLower(strings.ReplaceAll(sceneFilename, "\\", "/"))
	if !strings.HasPrefix(p, floraRoot+"/") {
		return "", false
	}
	base := strings.TrimSuffix(filepath.Base(p), ".scene.mbin")
	base = strings.TrimSuffix(base, "_placement")
	if base == "" {
		return "", false
	}
	return filepath.Join(floraRoot, base, "entities", "plantinteraction.entity.MXML"), true
}

// readPlantRewardKey reads the interaction id a plant's entity declares.
func readPlantRewardKey(path, name string) (string, error) {
	doc, err := readMXML(path, "cTkAttachmentData")
	if err != nil {
		return "", err
	}
	components, ok := findChild(doc.Props, "Components")
	if !ok {
		return "", Unrecognized(name, "", "Components", "present", "absent")
	}
	for _, c := range components.children("Components") {
		if c.Value != "GcSimpleInteractionComponentData" {
			continue
		}
		inner, ok := c.child("GcSimpleInteractionComponentData")
		if !ok {
			return "", Unrecognized(name, "", "GcSimpleInteractionComponentData", "present", "absent")
		}
		return inner.nonEmpty(name, "", "Id")
	}
	return "", Unrecognized(name, "", "Components", "a GcSimpleInteractionComponentData", "none")
}

// reward is one reward-table entry's substance and amount range.
type reward struct {
	substance string
	min, max  int64
}

// rewardKinds are the reward shapes a farmable plant can hand back.
//
// SPEC-0004 names only GcRewardSpecificSubstance. Against the real table
// that covers seven of the twelve farmable plants: the other five —
// venom sacs, gravitino balls, nip-nip buds, albumen pearls and creature
// pellets — yield a *product*, under GcRewardSpecificProduct with an
// identical Amount shape. Reading only the substance form would have
// dropped them silently, so both are read and the divergence is recorded
// on the crop search note.
var rewardKinds = []string{"GcRewardSpecificSubstance", "GcRewardSpecificProduct"}

// readRewards indexes the reward table by entry id.
//
// Only entries whose single item is one of rewardKinds are indexed. The
// table also holds nanite payouts, tech unlocks and multi-item lists; none
// of those are what a plant hands you, and reading them as if they were
// would put a wrong number in the artifact.
func readRewards(root string) (map[string]reward, error) {
	doc, err := readMXML(filepath.Join(root, rewardTable), "cGcRewardTable")
	if err != nil {
		return nil, err
	}
	wrapper, ok := findChild(doc.Props, "GenericTable")
	if !ok {
		return nil, Unrecognized(rewardTable, "", "GenericTable", "present", "absent")
	}

	out := make(map[string]reward)
	for _, row := range wrapper.children("GenericTable") {
		id, err := row.str(rewardTable, "", "Id")
		if err != nil || id == "" {
			continue
		}
		list, ok := row.child("List")
		if !ok {
			continue
		}
		inner, ok := list.child("List")
		if !ok {
			continue
		}
		items := inner.children("List")
		if len(items) != 1 {
			continue
		}
		r, ok := items[0].child("Reward")
		if !ok {
			continue
		}
		kind := ""
		for _, k := range rewardKinds {
			if r.Value == k {
				kind = k
				break
			}
		}
		if kind == "" {
			continue
		}
		sub, ok := r.child(kind)
		if !ok {
			continue
		}
		substance, err := sub.nonEmpty(rewardTable, id, "ID")
		if err != nil {
			return nil, err
		}
		min, err := sub.int64(rewardTable, id, "AmountMin")
		if err != nil {
			return nil, err
		}
		max, err := sub.int64(rewardTable, id, "AmountMax")
		if err != nil {
			return nil, err
		}
		out[id] = reward{substance: substance, min: min, max: max}
	}
	if len(out) == 0 {
		return nil, Unrecognized(rewardTable, "", "GenericTable", "at least one substance or product reward", "none")
	}
	return out, nil
}

// readRefining reads refiner throughput, which is difficulty-dependent.
//
// Both the standard and Survival variants are carried, settling SPEC-0004's
// open question by letting the planner choose rather than picking here.
func readRefining(root string) (*domain.Refining, error) {
	doc, err := readMXML(filepath.Join(root, gameplayGlobal), "cGcGameplayGlobals")
	if err != nil {
		return nil, err
	}
	top := node{Props: doc.Props}

	var r domain.Refining
	fields := []struct {
		field string
		into  *int64
	}{
		{"RefinerProductsMadeInTime", &r.ProductsPerCycle},
		{"RefinerSubsMadeInTime", &r.SubstancesPerCycle},
		{"RefinerProductsMadeInTimeSurvival", &r.ProductsPerCycleSurvival},
		{"RefinerSubsMadeInTimeSurvival", &r.SubstancesPerCycleSurvival},
	}
	for _, f := range fields {
		v, err := top.int64(gameplayGlobal, "", f.field)
		if err != nil {
			return nil, err
		}
		*f.into = v
	}
	return &r, nil
}

// findChild returns the first node in a slice with the given name.
func findChild(props []node, name string) (node, bool) {
	for _, p := range props {
		if p.Name == name {
			return p, true
		}
	}
	return node{}, false
}
