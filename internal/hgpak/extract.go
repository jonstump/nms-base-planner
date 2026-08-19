package hgpak

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Governing: ADR-0001 (two-tier NMS data ingestion), SPEC-0003 REQ "Safe
// Extraction to Disk", REQ "Pipeline Fitness"
//
// Archive paths come out of a file the reader does not control. Everything
// here treats them as hostile: an entry named "../../.ssh/authorized_keys"
// is a write outside the output directory unless something stops it, and
// "silently skip the bad one" is not that something — a partial extraction
// that looks complete is worse than a failed one.

// ExtractResult reports what an extraction wrote.
type ExtractResult struct {
	// Files is the number of entries written.
	Files int
	// Bytes is their total size on disk.
	Bytes int64
	// Skipped is the number of entries the filter excluded.
	Skipped int
}

// Matches reports whether an archive path satisfies a case-insensitive
// substring filter. An empty filter matches everything.
func Matches(path, filter string) bool {
	return filter == "" || strings.Contains(strings.ToLower(path), strings.ToLower(filter))
}

// ExtractTo writes every entry whose path contains filter (case-insensitively)
// into outDir, mirroring the archive's directory structure. An empty filter
// extracts the whole archive.
//
// Entry bytes are written verbatim: the only transformation between the file
// on disk and the bytes here is decompression of the containing blocks.
//
// A path that would resolve outside outDir fails the whole extraction rather
// than being skipped.
func (a *Archive) ExtractTo(outDir, filter string) (ExtractResult, error) {
	var res ExtractResult

	paths, err := a.Paths()
	if err != nil {
		return res, err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return res, fmt.Errorf("creating output directory %s: %w", outDir, err)
	}
	// Resolve the root once so per-entry containment checks compare
	// symlink-free paths on both sides.
	root, err := filepath.EvalSymlinks(outDir)
	if err != nil {
		return res, fmt.Errorf("resolving output directory %s: %w", outDir, err)
	}

	for idx, p := range paths {
		if !Matches(p, filter) {
			res.Skipped++
			continue
		}
		dest, err := safeDest(root, p)
		if err != nil {
			return res, err
		}
		// Manifest path i names entry i+1, so read by index rather than
		// round-tripping through path lookup: it is the same bytes with one
		// less map hop, and it cannot be defeated by a path the manifest
		// carries in a form Lookup would normalize differently.
		body, err := a.ReadEntry(idx + 1)
		if err != nil {
			return res, fmt.Errorf("reading %s: %w", p, err)
		}
		// Check containment BEFORE creating anything. MkdirAll happily
		// builds a tree through a symlinked parent, so checking afterwards
		// refuses the write but has already made directories outside the
		// output tree.
		if err := confinedToRoot(root, deepestExisting(filepath.Dir(dest)), p); err != nil {
			return res, err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return res, fmt.Errorf("creating directory for %s: %w", p, err)
		}
		// The directory chain now exists, so a symlink planted anywhere
		// along it is resolvable — re-check containment before writing.
		if err := confinedToRoot(root, filepath.Dir(dest), p); err != nil {
			return res, err
		}
		// The parent chain is confined, but dest itself may already exist as
		// a symlink pointing out of the tree, and os.WriteFile follows it.
		// Lstat sees the link rather than its target.
		if fi, err := os.Lstat(dest); err == nil && fi.Mode()&os.ModeSymlink != 0 {
			return res, fmt.Errorf("refusing %q: destination already exists as a symlink: %w",
				p, ErrUnsafePath)
		}
		if err := os.WriteFile(dest, body, 0o644); err != nil {
			return res, fmt.Errorf("writing %s: %w", p, err)
		}
		res.Files++
		res.Bytes += int64(len(body))
	}
	return res, nil
}

// safeDest maps an archive path to a destination under root, rejecting
// anything that escapes it.
//
// A leading separator is tolerated and treated as relative — archives are not
// consistent about it, and "/foo" plainly means foo within the archive rather
// than the filesystem root.
func safeDest(root, archivePath string) (string, error) {
	clean := strings.TrimLeft(strings.ReplaceAll(archivePath, "\\", "/"), "/")
	if clean == "" {
		return "", fmt.Errorf("entry has an empty path: %w", ErrUnsafePath)
	}
	// Reject a Windows-style drive or UNC prefix outright; filepath.Join
	// would otherwise quietly fold it into the destination on that platform.
	if vol := filepath.VolumeName(filepath.FromSlash(clean)); vol != "" {
		return "", fmt.Errorf("refusing %q: absolute path: %w", archivePath, ErrUnsafePath)
	}

	dest := filepath.Join(root, filepath.FromSlash(clean))
	rel, err := filepath.Rel(root, dest)
	if err != nil {
		return "", fmt.Errorf("refusing %q: %v: %w", archivePath, err, ErrUnsafePath)
	}
	// Compare ".." as a whole path element. A plain prefix test also rejects
	// legitimate names that merely begin with two dots.
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("refusing %q: escapes the output directory: %w", archivePath, ErrUnsafePath)
	}
	return dest, nil
}

// confinedToRoot verifies that dir, with every symlink along it resolved,
// still lives under root. safeDest is a lexical check and cannot see a
// symlink planted inside the output tree; this is the check that can.
func confinedToRoot(root, dir, archivePath string) error {
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return fmt.Errorf("resolving destination for %q: %v: %w", archivePath, err, ErrUnsafePath)
	}
	rel, err := filepath.Rel(root, real)
	if err != nil {
		return fmt.Errorf("refusing %q: %v: %w", archivePath, err, ErrUnsafePath)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("refusing %q: resolves outside the output directory via a symlink: %w",
			archivePath, ErrUnsafePath)
	}
	return nil
}

// deepestExisting returns the closest ancestor of p that exists, p included.
// EvalSymlinks needs a path that is actually there, and the whole point of
// checking before MkdirAll is that the leaf directories are not yet.
func deepestExisting(p string) string {
	for {
		if _, err := os.Lstat(p); err == nil {
			return p
		}
		parent := filepath.Dir(p)
		if parent == p {
			return p
		}
		p = parent
	}
}
