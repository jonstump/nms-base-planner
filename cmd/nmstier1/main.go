// Command nmstier1 builds the Tier 1 artifact from a decompiled No Man's Sky
// install.
//
// Governing: ADR-0001 (two-tier NMS data ingestion), SPEC-0004 REQ "Source
// Provenance and Version Stamping", REQ "Deterministic Output"
//
// The artifact is committed to the repository and regenerated per game
// version; it is never hand-edited. This command is the whole of "regenerate
// it", so that reproducing a committed artifact from the same install needs
// no manual steps.
//
// Usage:
//
//	nmstier1 -src <decompiled-root> -out data/tier1.json -game-version 5.97
//
// The source root is a tree of .MXML produced by running MBINCompiler over
// what SPEC-0003's extractor unpacks:
//
//	metadata/reality/tables/          products, substances, recipes, rewards,
//	                                  base building objects
//	metadata/simulation/scanning/     region hotspots
//	language/                         nms_*_english localisation tables
//	models/.../interactiveflora/      per-crop interaction entities
//	gcgameplayglobals.global.MXML     refiner throughput
package main

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/jonstump/nms-base-planner/internal/normalize"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(); err != nil {
		var se *normalize.SourceError
		if errors.As(err, &se) {
			// Structured so the failure names the table, row and field
			// rather than only the message.
			log.Error("generation failed", se.LogAttrs()...)
		} else {
			log.Error("generation failed", "err", err)
		}
		os.Exit(1)
	}
}

func run() error {
	var (
		src     = flag.String("src", "", "root of a decompiled install (.MXML tree)")
		out     = flag.String("out", "data/tier1.json", "path to write the artifact to")
		version = flag.String("game-version", "", "the game build the source was taken from")
		mbin    = flag.String("mbincompiler", "6.45.0.1", "MBINCompiler version that produced the .MXML")
	)
	flag.Parse()

	if *src == "" || *version == "" {
		flag.Usage()
		// SPEC-0004 REQ "Source Provenance and Version Stamping" forbids
		// emitting a guessed game version, and nothing in the decompiled
		// tree states it, so it is required rather than defaulted.
		return fmt.Errorf("-src and -game-version are required")
	}

	tables := filepath.Join(*src, "metadata/reality/tables")
	loc, err := filepath.Glob(filepath.Join(*src, "language", "nms_*_english.MXML"))
	if err != nil {
		return err
	}
	if len(loc) == 0 {
		return normalize.Missing(filepath.Join(*src, "language/nms_*_english.MXML"))
	}

	graph, err := normalize.BuildGraph(normalize.Sources{
		Products:     filepath.Join(tables, "nms_reality_gcproducttable.MXML"),
		Substances:   filepath.Join(tables, "nms_reality_gcsubstancetable.MXML"),
		Recipes:      filepath.Join(tables, "nms_reality_gcrecipetable.MXML"),
		Localisation: loc,
	})
	if err != nil {
		return err
	}
	economy, err := normalize.ReadEconomy(*src)
	if err != nil {
		return err
	}

	// The archives every source above came from.
	//
	// This is a constant rather than something derived, because -src is a
	// *decompiled* tree: the .MXML files carry no record of which .pak they
	// were unpacked from, so the generator cannot observe this. It has to be
	// stated, which means it has to be kept true by hand.
	//
	// SPEC-0004 REQ "Source Provenance and Version Stamping" requires the
	// artifact to record its source archives, and the point of recording
	// them is that someone can reassemble the same tree. An incomplete list
	// fails that quietly: follow it and you get a graph with no names,
	// because the localisation tables are not where the recipe tables are.
	//
	//	NMSARC.Precache.pak     metadata/reality/tables, simulation/scanning,
	//	                        models/planets/.../interactiveflora
	//	NMSARC.globals.pak      gcgameplayglobals.global
	//	NMSARC.MetadataEtc.pak  language/nms_*_english — every display name
	b, err := normalize.NewBuilder(*version, *mbin, []string{
		"NMSARC.MetadataEtc.pak", "NMSARC.Precache.pak", "NMSARC.globals.pak",
	})
	if err != nil {
		return err
	}
	b.AddItems(graph.Items...)
	b.AddRecipes(graph.Recipes...)
	b.SetEconomy(economy)
	b.SetSelfReferentialOmitted(graph.SelfReferentialOmitted)
	b.SetNote(normalize.GenerationNote(graph))

	artifact, err := b.Artifact()
	if err != nil {
		return err
	}
	if err := normalize.WriteFile(*out, artifact); err != nil {
		return err
	}

	fmt.Printf("%s: %d items, %d recipes, %d parts, %d crops\n",
		*out, len(artifact.Items), len(artifact.Recipes),
		len(economy.Parts), len(economy.Crops))
	return nil
}
