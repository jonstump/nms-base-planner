// Command nmsextract unpacks No Man's Sky .pak archives.
//
// The .pak files under GAMEDATA/PCBANKS are HGPAK archives — not PSARC,
// despite what most community documentation still says. MBINCompiler works
// on already-unpacked .MBIN files, so this covers the step before it.
//
// Governing: ADR-0001 (two-tier NMS data ingestion) — stage 1, "locate +
// extract PAKs". SPEC-0003 REQ "Pipeline Fitness".
//
//	nmsextract list    <archive.pak> [substring]
//	nmsextract extract <archive.pak> <outdir> [substring]
//
// The optional substring filters by path, case-insensitively — useful
// because a PCBANKS archive holds tens of thousands of entries and the
// recipe tables are a handful of them:
//
//	nmsextract list    "$PCBANKS/NMSARC.Precache.pak" reality/tables
//	nmsextract extract "$PCBANKS/NMSARC.Precache.pak" ./out metadata/reality/tables/
package main

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/jonstump/nms-base-planner/internal/hgpak"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		// Structured logging so a failure carries its fields rather than a
		// prose string a caller has to parse (SPEC-0003 REQ "Error Handling
		// Standards").
		log := slog.New(slog.NewTextHandler(os.Stderr, nil))
		attrs := []any{"err", err}
		var se *hgpak.StructureError
		if errors.As(err, &se) {
			attrs = append(attrs, se.LogAttrs()...)
		}
		switch {
		case errors.Is(err, hgpak.ErrNotHGPAK):
			attrs = append(attrs, "cause", "not an HGPAK archive")
		case errors.Is(err, hgpak.ErrUnsupportedVersion):
			attrs = append(attrs, "cause", "unsupported container version")
		case errors.Is(err, hgpak.ErrMalformed):
			attrs = append(attrs, "cause", "malformed archive")
		case errors.Is(err, hgpak.ErrEntryNotFound):
			attrs = append(attrs, "cause", "entry not found")
		case errors.Is(err, hgpak.ErrUnsafePath):
			attrs = append(attrs, "cause", "unsafe extraction path")
		}
		log.Error("nmsextract failed", attrs...)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) < 2 {
		usage()
		return fmt.Errorf("expected a subcommand and an archive")
	}
	cmd, path := args[0], args[1]

	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}

	a, err := hgpak.Open(f, st.Size())
	if err != nil {
		return fmt.Errorf("opening %s: %w", filepath.Base(path), err)
	}
	defer a.Close()

	switch cmd {
	case "list":
		filter := ""
		if len(args) > 2 {
			filter = args[2]
		}
		return list(a, filter)
	case "extract":
		if len(args) < 3 {
			return fmt.Errorf("extract needs an output directory")
		}
		filter := ""
		if len(args) > 3 {
			filter = args[3]
		}
		return extract(a, args[2], filter)
	default:
		usage()
		return fmt.Errorf("unknown subcommand %q", cmd)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `usage:
  nmsextract list    <archive.pak> [substring]
  nmsextract extract <archive.pak> <outdir> [substring]

The substring filters paths case-insensitively.
`)
}

func storageLabel(a *hgpak.Archive) string {
	if a.Stored() {
		return "stored"
	}
	return "zstd blocks"
}

func list(a *hgpak.Archive, filter string) error {
	paths, err := a.Paths()
	if err != nil {
		return err
	}
	fmt.Printf("HGPAK v%d  %s  %d entries  %d blocks\n\n",
		a.Version(), storageLabel(a), len(paths), a.BlockCount())

	var shown int
	var total uint64
	for i, p := range paths {
		if !hgpak.Matches(p, filter) {
			continue
		}
		// Manifest entry 0 is not a file, so entry i+1 owns path i.
		e, err := a.Entry(i + 1)
		if err != nil {
			return err
		}
		fmt.Printf("%12d  %s\n", e.Size, p)
		shown++
		total += e.Size
	}
	fmt.Printf("\n%d entries, %d bytes uncompressed\n", shown, total)
	if filter != "" {
		fmt.Printf("(filtered by %q)\n", filter)
	}
	return nil
}

func extract(a *hgpak.Archive, outDir, filter string) error {
	res, err := a.ExtractTo(outDir, filter)
	if err != nil {
		return err
	}
	fmt.Printf("extracted %d entries, %d bytes, to %s\n", res.Files, res.Bytes, outDir)
	if res.Files == 0 && filter != "" {
		fmt.Printf("(nothing matched %q — try `list` first)\n", filter)
	}
	return nil
}
