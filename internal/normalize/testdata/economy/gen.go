//go:build ignore

// Command gen builds the economy fixtures from a real decompiled extraction.
//
// Every fixture here is real game content, sliced rather than written: the
// point of testing against them is that the parser meets the shapes the game
// actually ships, and a hand-authored approximation of an MXML tree tests
// only that the parser meets my expectations. That mistake has already cost
// this project one whole subsystem.
//
// Usage, from a tree decompiled with MBINCompiler 6.45.0.1:
//
//	nmsextract extract NMSARC.Precache.pak  $SRC metadata/reality/tables/
//	nmsextract extract NMSARC.Precache.pak  $SRC metadata/simulation/scanning/
//	nmsextract extract NMSARC.Precache.pak  $SRC interactiveflora/farm
//	nmsextract extract NMSARC.globals.pak   $SRC gcgameplayglobals
//	MBINCompiler <each .mbin>
//	go run gen.go $SRC
//
// Slices kept, and why:
//
//	basebuildingobjectstable  the parts named in SPEC-0004's acceptance
//	                          criteria, one crop of each reward shape, one
//	                          growth-network container, and one part with no
//	                          rate at all to exercise the skip
//	rewardtable               the reward entries those crops resolve to,
//	                          plus one non-substance entry to exercise the
//	                          filter
//	regionhotspotstable       whole: 16 KB, and the family collapse needs
//	                          every variant present to be meaningful
//	gcgameplayglobals         the four refiner throughput properties
//	plantinteraction.entity   the interaction component the crop chain reads
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var keepObjects = []string{
	"U_EXTRACTOR_S",  // rate, storage, dependent power draw, hotspot
	"U_GENERATOR_S",  // hotspot-scaled generator
	"U_SOLAR_S",      // flat producer, no dependency
	"SNOWPLANT",      // crop, substance reward
	"BARRENPLANT",    // crop whose reward key differs from its substance
	"LUSHPLANT",      // crop, substance reward
	"SACVENOMPLANT",  // crop, product reward
	"CARBONPLANTER",  // growth network, no flora entity: a container
	"BUILD_REFINER1", // no rate, storage or dependency: must be skipped
}

var keepRewards = []string{
	"PLANT_SNOW", "PLANT_BARREN", "PLANT_LUSH", "PLANT_SACVENOM",
	"WILD_SNOW", // not farmed: must not be reachable from any crop
}

var keepFlora = []string{"farmsnow", "farmbarren", "farmlush", "farmvenomsac"}

var keepGlobals = []string{
	"RefinerProductsMadeInTime",
	"RefinerSubsMadeInTime",
	"RefinerProductsMadeInTimeSurvival",
	"RefinerSubsMadeInTimeSurvival",
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run gen.go <decompiled-source-root>")
		os.Exit(2)
	}
	src := os.Args[1]

	must(sliceRows(
		filepath.Join(src, "metadata/reality/tables/basebuildingobjectstable.MXML"),
		"metadata/reality/tables/basebuildingobjectstable.MXML",
		`<Property name="Objects" value="GcBaseBuildingEntry" _id=`, keepObjects,
		`<Data template="cGcBaseBuildingTable">`, "Objects"))

	must(sliceRows(
		filepath.Join(src, "metadata/reality/tables/rewardtable.MXML"),
		"metadata/reality/tables/rewardtable.MXML",
		`<Property name="GenericTable" value="GcGenericRewardTableEntry" _id=`, keepRewards,
		`<Data template="cGcRewardTable">`, "GenericTable"))

	must(copyFile(
		filepath.Join(src, "metadata/simulation/scanning/regionhotspotstable.MXML"),
		"metadata/simulation/scanning/regionhotspotstable.MXML"))

	must(sliceGlobals(
		filepath.Join(src, "gcgameplayglobals.global.MXML"),
		"gcgameplayglobals.global.MXML"))

	for _, f := range keepFlora {
		rel := filepath.Join("models/planets/biomes/common/interactiveflora", f,
			"entities/plantinteraction.entity.MXML")
		must(sliceInteraction(filepath.Join(src, rel), rel))
	}
}

// sliceRows keeps the named rows of a table, preserving every byte of each
// row exactly as the decompiler emitted it.
func sliceRows(src, dst, marker string, keep []string, header, wrapper string) error {
	body, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	wanted := map[string]bool{}
	for _, k := range keep {
		wanted[k] = true
	}

	lines := strings.Split(string(body), "\n")
	var out []string
	out = append(out, `<?xml version="1.0" encoding="utf-8"?>`,
		`<!--File created using MBINCompiler version (6.45.0.1)-->`,
		header, "\t"+`<Property name="`+wrapper+`">`)

	depth := 0
	var row []string
	for _, l := range lines {
		if depth == 0 {
			if !strings.Contains(l, marker) {
				continue
			}
			id := between(l, `_id="`, `"`)
			if !wanted[id] {
				continue
			}
			delete(wanted, id)
			depth, row = 1, []string{l}
			continue
		}
		row = append(row, l)
		depth += strings.Count(l, "<Property name=") - strings.Count(l, "</Property>")
		depth -= strings.Count(l, "/>")
		if depth <= 0 {
			out = append(out, row...)
			depth, row = 0, nil
		}
	}
	if len(wanted) > 0 {
		return fmt.Errorf("%s: rows not found: %v", src, wanted)
	}
	out = append(out, "\t</Property>", "</Data>", "")
	return write(dst, strings.Join(out, "\n"))
}

// sliceGlobals keeps only the refiner throughput properties.
func sliceGlobals(src, dst string) error {
	body, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	out := []string{`<?xml version="1.0" encoding="utf-8"?>`,
		`<!--File created using MBINCompiler version (6.45.0.1)-->`,
		`<Data template="cGcGameplayGlobals">`}
	found := 0
	for _, l := range strings.Split(string(body), "\n") {
		for _, f := range keepGlobals {
			if strings.Contains(l, `<Property name="`+f+`"`) {
				out = append(out, l)
				found++
			}
		}
	}
	if found != len(keepGlobals) {
		return fmt.Errorf("%s: found %d of %d refiner properties", src, found, len(keepGlobals))
	}
	out = append(out, "</Data>", "")
	return write(dst, strings.Join(out, "\n"))
}

// sliceInteraction keeps the simple-interaction component, which is the only
// part of a 46 KB entity file the crop chain reads.
func sliceInteraction(src, dst string) error {
	body, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	lines := strings.Split(string(body), "\n")
	start, end := -1, -1
	for i, l := range lines {
		if start < 0 && strings.Contains(l, `value="GcSimpleInteractionComponentData"`) {
			start = i
			continue
		}
		if start >= 0 && strings.TrimSpace(l) == "</Property>" &&
			len(l)-len(strings.TrimLeft(l, "\t")) == len(lines[start])-len(strings.TrimLeft(lines[start], "\t")) {
			end = i
			break
		}
	}
	if start < 0 || end < 0 {
		return fmt.Errorf("%s: no GcSimpleInteractionComponentData block", src)
	}
	out := append([]string{`<?xml version="1.0" encoding="utf-8"?>`,
		`<!--File created using MBINCompiler version (6.45.0.1)-->`,
		`<Data template="cTkAttachmentData">`, "\t" + `<Property name="Components">`},
		lines[start:end+1]...)
	out = append(out, "\t</Property>", "</Data>", "")
	return write(dst, strings.Join(out, "\n"))
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return write(dst, string(b))
}

func write(dst, body string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, []byte(body), 0o644)
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

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
