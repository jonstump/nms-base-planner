// Command nmsextract unpacks No Man's Sky .pak archives.
//
// The .pak files under GAMEDATA/PCBANKS are PSARC archives. MBINCompiler
// works on already-unpacked .MBIN files, so this covers the step before it.
//
// Governing: ADR-0001 (two-tier NMS data ingestion) — stage 1, "locate +
// extract PAKs".
//
//	nmsextract list    <archive.pak> [substring]
//	nmsextract extract <archive.pak> <outdir> [substring]
//
// The optional substring filters by path, case-insensitively — useful
// because a PCBANKS archive holds tens of thousands of entries and the
// recipe tables are a handful of them:
//
//	nmsextract list NMSARC.515F1D3.pak TABLE
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jonstump/nms-base-planner/internal/psarc"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "nmsextract: %v\n", err)
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

	a, err := psarc.Open(f, st.Size())
	if err != nil {
		return fmt.Errorf("opening %s: %w", filepath.Base(path), err)
	}

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

func list(a *psarc.Archive, filter string) error {
	fmt.Printf("PSARC v%d.%d  %s  block %d  %d entries\n\n",
		a.VersionMajor, a.VersionMinor, a.Compression, a.BlockSize, len(a.Names()))

	var shown int
	var bytes int64
	for _, e := range a.Entries() {
		if !matches(e.Name, filter) {
			continue
		}
		fmt.Printf("%12d  %s\n", e.UncompressedSize, e.Name)
		shown++
		bytes += e.UncompressedSize
	}
	fmt.Printf("\n%d entries, %d bytes uncompressed\n", shown, bytes)
	if filter != "" {
		fmt.Printf("(filtered by %q)\n", filter)
	}
	return nil
}

func extract(a *psarc.Archive, outDir, filter string) error {
	var n int
	var total int64
	for _, e := range a.Entries() {
		if !matches(e.Name, filter) {
			continue
		}

		// Archive paths are untrusted input. Reject anything that escapes
		// the output directory rather than writing through it.
		dest := filepath.Join(outDir, filepath.FromSlash(e.Name))
		rel, err := filepath.Rel(outDir, dest)
		if err != nil || strings.HasPrefix(rel, "..") {
			return fmt.Errorf("refusing path %q: escapes the output directory", e.Name)
		}

		data, err := a.ReadFile(e.Name)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dest, data, 0o644); err != nil {
			return err
		}
		n++
		total += int64(len(data))
	}
	fmt.Printf("extracted %d entries, %d bytes, to %s\n", n, total, outDir)
	if n == 0 && filter != "" {
		fmt.Printf("(nothing matched %q — try `list` first)\n", filter)
	}
	return nil
}

func matches(name, filter string) bool {
	return filter == "" || strings.Contains(strings.ToLower(name), strings.ToLower(filter))
}
