package hgpak

// Governing: ADR-0001 (two-tier NMS data ingestion), SPEC-0003 REQ "Manifest
// and Path Resolution", REQ "Selective Extraction".
//
// Entry 0 is a plaintext manifest of CRLF-separated lowercase paths, and
// manifest path n names archive entry n. Names therefore come from the
// archive alone — no external hash-to-name mapping, which is what makes this
// reader usable against an install nobody has catalogued.
//
// Each entry's 16-byte hash is the MD5 of its lowercase path. That is
// redundant with the manifest, which is exactly why it is worth checking:
// the two structures agreeing is a free consistency check, and a cheap early
// warning that a game update changed the convention. The hash is never used
// as the lookup key — doing so would reintroduce the dependency the manifest
// removes.

import (
	"bytes"
	"crypto/md5"
	"fmt"
	"strings"
)

// manifestSep separates paths in entry 0. Real archives use CRLF and
// terminate the final path as well, so the trailing separator is stripped
// before splitting rather than yielding a phantom empty path.
const manifestSep = "\r\n"

// Paths returns every entry's path in manifest order, so Paths()[n] names
// the entry at index n+1 — entry 0 is the manifest itself and has no path.
// Use Lookup or ReadPath to go from a path back to an entry.
//
// Listing decompresses only the blocks covering the manifest (SPEC-0003 REQ
// "Selective Extraction"); the rest of the archive is never touched.
func (a *Archive) Paths() ([]string, error) {
	if err := a.resolve(); err != nil {
		return nil, err
	}
	out := make([]string, len(a.paths))
	copy(out, a.paths)
	return out, nil
}

// Lookup returns the entry index for path. Manifest paths are lowercase by
// format, so the query is lowercased before matching and a caller may pass
// whichever case it has to hand.
func (a *Archive) Lookup(path string) (int, error) {
	if err := a.resolve(); err != nil {
		return 0, err
	}
	i, ok := a.byPath[normalizePath(path)]
	if !ok {
		return 0, fmt.Errorf("%q is not in this archive: %w", path, ErrEntryNotFound)
	}
	return i, nil
}

// ReadPath returns the bytes of the entry at path, decompressing only the
// blocks that entry spans.
func (a *Archive) ReadPath(path string) ([]byte, error) {
	i, err := a.Lookup(path)
	if err != nil {
		return nil, err
	}
	return a.ReadEntry(i)
}

// Path returns the path naming entry i. Entry 0 is the manifest and has no
// path of its own.
func (a *Archive) Path(i int) (string, error) {
	if err := a.resolve(); err != nil {
		return "", err
	}
	if i < 1 || i > len(a.paths) {
		return "", fmt.Errorf("entry %d has no manifest path (entries 1..%d do): %w",
			i, len(a.paths), ErrEntryNotFound)
	}
	return a.paths[i-1], nil
}

// normalizePath puts a caller-supplied path into the form the manifest uses.
func normalizePath(p string) string {
	return strings.ToLower(strings.TrimPrefix(p, "/"))
}

// resolve parses the manifest and verifies every entry hash, at most once
// per Archive. A failure is cached alongside the success: a malformed
// manifest does not become well-formed on a retry, and re-reporting it
// costs nothing.
func (a *Archive) resolve() error {
	a.pathOnce.Do(func() { a.pathErr = a.resolveManifest() })
	return a.pathErr
}

func (a *Archive) resolveManifest() error {
	blob, err := a.ReadEntry(0)
	if err != nil {
		return fmt.Errorf("reading manifest: %w", err)
	}

	paths, err := parseManifest(blob, len(a.entries))
	if err != nil {
		return err
	}

	byPath := make(map[string]int, len(paths))
	for i, p := range paths {
		// Manifest path i names entry i+1; entry 0 is the manifest.
		idx := i + 1
		want := md5.Sum([]byte(strings.ToLower(p)))
		if a.entries[idx].Hash != want {
			return malformed("entry hash", idx,
				fmt.Sprintf("%x (MD5 of %q)", want, strings.ToLower(p)),
				fmt.Sprintf("%x", a.entries[idx].Hash))
		}
		// Key by the normalized form, because Lookup normalizes its query.
		// Keying raw made any manifest path that was not already lowercase
		// and slash-free unreachable by its own name, which contradicts
		// SPEC-0003 REQ "Manifest and Path Resolution" ("MUST expose every
		// entry by its path"). No shipping archive triggers it — all 184,823
		// paths across the install are already normalized — but a crafted
		// one does, and the asymmetry was silent.
		key := normalizePath(p)
		if prev, dup := byPath[key]; dup {
			return malformed("manifest path", idx,
				fmt.Sprintf("%q to name one entry", p),
				fmt.Sprintf("entries %d and %d", prev, idx))
		}
		byPath[key] = idx
	}

	a.paths = paths
	a.byPath = byPath
	return nil
}

// parseManifest splits entry 0 into paths and checks the count against the
// entry table. The two disagreeing means the archive is not what it claims,
// so it is reported rather than reconciled.
func parseManifest(blob []byte, entryCount int) ([]string, error) {
	trimmed := bytes.TrimSuffix(blob, []byte(manifestSep))
	var paths []string
	if len(trimmed) > 0 {
		paths = strings.Split(string(trimmed), manifestSep)
	}

	if want := entryCount - 1; len(paths) != want {
		return nil, malformed("manifest path count", -1,
			fmt.Sprintf("%d (entry count %d less the manifest itself)", want, entryCount),
			len(paths))
	}
	for i, p := range paths {
		if strings.TrimSpace(p) == "" {
			return nil, malformed("manifest path", i+1, "non-empty", fmt.Sprintf("%q", p))
		}
	}
	return paths, nil
}
