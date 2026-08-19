package hgpak_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/jonstump/nms-base-planner/internal/hgpak"
)

// Governing: SPEC-0003 REQ "Safe Extraction to Disk", REQ "Pipeline Fitness".
//
// These build crafted archives rather than using the real-archive excerpt:
// no shipping archive contains a traversal path, so the hostile cases can
// only come from a fixture built to carry them. The archives are structurally
// real (stored layout, verified against NMSARC.audioBNK.pak — see
// TestStoredArchiveLayout); only the path strings are adversarial.

// craft builds a stored archive whose entries carry the given paths verbatim,
// bypassing the normalisation a real packer would apply.
func craft(t *testing.T, paths []string, bodies [][]byte) *hgpak.Archive {
	t.Helper()
	blob := storedArchive(paths, bodies, crlf(paths), md5Paths(paths))
	a, err := hgpak.Open(bytes.NewReader(blob), int64(len(blob)))
	if err != nil {
		t.Fatalf("Open crafted archive: %v", err)
	}
	t.Cleanup(func() { a.Close() })
	return a
}

// SPEC-0003 REQ "Safe Extraction to Disk":
// WHEN an entry's path escapes the output directory
// THEN extraction fails naming that path, and nothing is written outside
// the directory.
func TestTraversalIsRefusedAndNothingEscapes(t *testing.T) {
	cases := []struct {
		name string
		path string
	}{
		{"parent traversal", "../escaped.mbin"},
		{"deep traversal", "a/b/../../../escaped.mbin"},
		{"absolute path", "/etc/escaped.mbin"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			out := filepath.Join(root, "out")
			canary := filepath.Join(root, "escaped.mbin")

			a := craft(t, []string{tc.path}, [][]byte{[]byte("payload")})
			_, err := a.ExtractTo(out, "")

			// An absolute path is rewritten as relative per the spec's
			// leading-separator rule, so it lands inside the tree rather
			// than failing. Everything else must be refused outright.
			if tc.name == "absolute path" {
				if err != nil {
					t.Fatalf("absolute path should be treated as relative, got: %v", err)
				}
				if _, statErr := os.Stat(filepath.Join(out, "etc", "escaped.mbin")); statErr != nil {
					t.Errorf("absolute path was not rewritten under the output dir: %v", statErr)
				}
			} else {
				if err == nil {
					t.Fatal("ExtractTo accepted a traversal path")
				}
				if !errors.Is(err, hgpak.ErrUnsafePath) {
					t.Errorf("error is %v, want ErrUnsafePath", err)
				}
				if !strings.Contains(err.Error(), tc.path) {
					t.Errorf("error %q does not name the offending path", err)
				}
			}
			if _, statErr := os.Stat(canary); statErr == nil {
				t.Fatalf("a file was written outside the output directory at %s", canary)
			}
		})
	}
}

// A refused path fails the extraction; it is not silently skipped.
func TestTraversalFailsTheExtractionRatherThanSkipping(t *testing.T) {
	out := t.TempDir()
	a := craft(t,
		[]string{"good/one.mbin", "../bad.mbin", "good/two.mbin"},
		[][]byte{[]byte("one"), []byte("bad"), []byte("two")})

	res, err := a.ExtractTo(out, "")
	if err == nil {
		t.Fatal("extraction succeeded despite a traversal path")
	}
	if !errors.Is(err, hgpak.ErrUnsafePath) {
		t.Errorf("error is %v, want ErrUnsafePath", err)
	}
	if res.Files > 1 {
		t.Errorf("wrote %d files; extraction should stop at the offending entry", res.Files)
	}
}

// SPEC-0003 REQ "Safe Extraction to Disk": a symlink inside the output tree
// must not become a way out of it. The lexical check cannot see this; only
// resolving the path can.
func TestSymlinkEscapeIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on Windows")
	}
	root := t.TempDir()
	out := filepath.Join(root, "out")
	outside := filepath.Join(root, "outside")
	for _, d := range []string{out, outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// out/link -> ../outside, so "link/pwned.mbin" is lexically inside but
	// really outside.
	if err := os.Symlink(outside, filepath.Join(out, "link")); err != nil {
		t.Fatal(err)
	}

	a := craft(t, []string{"link/pwned.mbin"}, [][]byte{[]byte("payload")})
	_, err := a.ExtractTo(out, "")
	if err == nil {
		t.Fatal("ExtractTo followed a symlink out of the output directory")
	}
	if !errors.Is(err, hgpak.ErrUnsafePath) {
		t.Errorf("error is %v, want ErrUnsafePath", err)
	}
	if _, statErr := os.Stat(filepath.Join(outside, "pwned.mbin")); statErr == nil {
		t.Fatal("a file was written through the symlink, outside the output directory")
	}
}

// SPEC-0003 REQ "Safe Extraction to Disk":
// WHEN an entry at metadata/reality/tables/costtable.mbin is extracted
// THEN the intermediate directories are created and the file lands at the
// mirrored path.
func TestNestedPathsAreCreated(t *testing.T) {
	out := t.TempDir()
	want := []byte("cost table bytes")
	a := craft(t, []string{"metadata/reality/tables/costtable.mbin"}, [][]byte{want})

	res, err := a.ExtractTo(out, "")
	if err != nil {
		t.Fatalf("ExtractTo: %v", err)
	}
	if res.Files != 1 {
		t.Errorf("wrote %d files, want 1", res.Files)
	}
	got, err := os.ReadFile(filepath.Join(out, "metadata", "reality", "tables", "costtable.mbin"))
	if err != nil {
		t.Fatalf("reading extracted file: %v", err)
	}
	// Extraction performs no transformation on entry bytes.
	if !bytes.Equal(got, want) {
		t.Errorf("extracted %q, want %q", got, want)
	}
}

// A leading separator is tolerated and treated as relative.
func TestLeadingSeparatorIsTolerated(t *testing.T) {
	out := t.TempDir()
	a := craft(t, []string{"/metadata/thing.mbin"}, [][]byte{[]byte("x")})
	if _, err := a.ExtractTo(out, ""); err != nil {
		t.Fatalf("ExtractTo: %v", err)
	}
	if _, err := os.Stat(filepath.Join(out, "metadata", "thing.mbin")); err != nil {
		t.Errorf("leading-separator path did not land under the output dir: %v", err)
	}
}

// SPEC-0003 REQ "Pipeline Fitness": the filter narrows extraction, and
// non-matching entries are neither written nor read.
func TestFilterNarrowsExtraction(t *testing.T) {
	out := t.TempDir()
	a := craft(t,
		[]string{"metadata/reality/tables/a.mbin", "models/thing.mbin", "metadata/reality/tables/b.mbin"},
		[][]byte{[]byte("a"), []byte("m"), []byte("b")})

	res, err := a.ExtractTo(out, "REALITY/TABLES")
	if err != nil {
		t.Fatalf("ExtractTo: %v", err)
	}
	if res.Files != 2 {
		t.Errorf("wrote %d files, want 2", res.Files)
	}
	if res.Skipped != 1 {
		t.Errorf("skipped %d, want 1", res.Skipped)
	}
	if _, err := os.Stat(filepath.Join(out, "models", "thing.mbin")); err == nil {
		t.Error("a non-matching entry was written")
	}
}

func TestMatchesIsCaseInsensitiveSubstring(t *testing.T) {
	for _, tc := range []struct {
		path, filter string
		want         bool
	}{
		{"metadata/reality/tables/x.mbin", "", true},
		{"metadata/reality/tables/x.mbin", "TABLES", true},
		{"metadata/reality/tables/x.mbin", "tables", true},
		{"models/thing.mbin", "tables", false},
	} {
		if got := hgpak.Matches(tc.path, tc.filter); got != tc.want {
			t.Errorf("Matches(%q, %q) = %v, want %v", tc.path, tc.filter, got, tc.want)
		}
	}
}

// SPEC-0003 REQ "Pipeline Fitness": extraction from a real archive yields
// byte-exact MBIN files. Gated on a real install; CI never sets NMS_PCBANKS.
func TestExtractRealTablesFromPrecache(t *testing.T) {
	dir := os.Getenv("NMS_PCBANKS")
	if dir == "" {
		t.Skip("NMS_PCBANKS is not set; skipping extraction from a real install")
	}
	f, err := os.Open(filepath.Join(dir, "NMSARC.Precache.pak"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	a, err := hgpak.Open(f, st.Size())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	out := t.TempDir()
	res, err := a.ExtractTo(out, "metadata/reality/tables/")
	if err != nil {
		t.Fatalf("ExtractTo: %v", err)
	}
	if res.Files != 54 {
		t.Errorf("extracted %d tables, want 54", res.Files)
	}

	written, err := filepath.Glob(filepath.Join(out, "metadata", "reality", "tables", "*.mbin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != res.Files {
		t.Errorf("%d files on disk, extraction reported %d", len(written), res.Files)
	}
	for _, p := range written {
		head := make([]byte, 4)
		fh, err := os.Open(p)
		if err != nil {
			t.Fatal(err)
		}
		_, err = fh.Read(head)
		fh.Close()
		if err != nil {
			t.Fatalf("reading %s: %v", p, err)
		}
		// MBIN magic. Anything else means the bytes were mangled on the way
		// out, and MBINCompiler would reject them.
		if !bytes.Equal(head, []byte{0xcc, 0xcc, 0xcc, 0xcc}) {
			t.Errorf("%s begins %x, want cccccccc", filepath.Base(p), head)
		}
	}
	if !strings.Contains(strings.Join(written, " "), "nms_reality_gcproducttable.mbin") {
		t.Error("the product table is missing from the extraction")
	}
}

// Regression: the manifest index was keyed by the raw path while Lookup
// normalized its query, so any manifest path not already lowercase and
// slash-free was unreachable by its own name — contradicting SPEC-0003 REQ
// "Manifest and Path Resolution" ("MUST expose every entry by its path").
//
// No shipping archive triggers it: all 184,823 paths across the install are
// already normalized, which is why the asymmetry survived. A crafted archive
// is the only way to see it.
func TestEveryManifestPathIsReachableByItsOwnName(t *testing.T) {
	paths := []string{"/leading/slash.mbin", "metadata/plain.mbin"}
	bodies := [][]byte{[]byte("one"), []byte("two")}
	a := craft(t, paths, bodies)

	got, err := a.Paths()
	if err != nil {
		t.Fatalf("Paths: %v", err)
	}
	for i, p := range got {
		body, err := a.ReadPath(p)
		if err != nil {
			t.Errorf("ReadPath(%q) — a path the archive itself lists: %v", p, err)
			continue
		}
		if !bytes.Equal(body, bodies[i]) {
			t.Errorf("ReadPath(%q) = %q, want %q", p, body, bodies[i])
		}
	}
}

// SPEC-0003 REQ "Safe Extraction to Disk": the resolved destination must not
// fall outside the output directory, and nothing may be written outside it.
//
// A symlink at the destination *file* is a distinct escape from a symlink
// among its parent directories: the parent chain resolves cleanly, and
// os.WriteFile follows the final link. Lstat is what sees it.
func TestSymlinkAtDestinationFileIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on Windows")
	}
	root := t.TempDir()
	out := filepath.Join(root, "out")
	outside := filepath.Join(root, "outside")
	for _, d := range []string{out, outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	victim := filepath.Join(outside, "victim.txt")
	if err := os.WriteFile(victim, []byte("ORIGINAL"), 0o644); err != nil {
		t.Fatal(err)
	}
	// out/pwned.mbin is already a symlink to a file outside the tree.
	if err := os.Symlink(victim, filepath.Join(out, "pwned.mbin")); err != nil {
		t.Fatal(err)
	}

	a := craft(t, []string{"pwned.mbin"}, [][]byte{[]byte("PAYLOAD")})
	if _, err := a.ExtractTo(out, ""); err == nil {
		t.Fatal("ExtractTo wrote through a symlink at the destination")
	} else if !errors.Is(err, hgpak.ErrUnsafePath) {
		t.Errorf("error is %v, want ErrUnsafePath", err)
	}

	got, err := os.ReadFile(victim)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "ORIGINAL" {
		t.Errorf("file outside the output directory was clobbered: %q", got)
	}
}

// SPEC-0003 REQ "Safe Extraction to Disk": "nothing is written outside the
// directory" covers directories too. Containment is therefore checked before
// MkdirAll runs — checking afterwards refuses the write but has already
// built a tree through the symlink.
func TestNoDirectoriesAreCreatedOutsideTheOutputTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on Windows")
	}
	root := t.TempDir()
	out := filepath.Join(root, "out")
	outside := filepath.Join(root, "outside")
	for _, d := range []string{out, outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(out, "link")); err != nil {
		t.Fatal(err)
	}

	a := craft(t, []string{"link/sub/deep/pwned.mbin"}, [][]byte{[]byte("PAYLOAD")})
	if _, err := a.ExtractTo(out, ""); err == nil {
		t.Fatal("ExtractTo accepted a path through a symlinked parent")
	} else if !errors.Is(err, hgpak.ErrUnsafePath) {
		t.Errorf("error is %v, want ErrUnsafePath", err)
	}

	if _, err := os.Stat(filepath.Join(outside, "sub")); err == nil {
		t.Error("directories were created outside the output directory")
	}
}

// SPEC-0003 REQ "Safe Extraction to Disk": nothing is written outside the
// output directory. A hardlink at the destination is the third variant of
// that escape, after the symlinked parent and the symlinked destination.
//
// It is invisible to the symlink check the other two use: a hardlink reports
// as a regular file, and os.WriteFile writes straight through to the shared
// inode. Before the fix this modified a file outside the tree and ExtractTo
// returned nil — reporting success while clobbering the victim.
func TestHardlinkAtDestinationIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("hardlink semantics differ on Windows")
	}
	root := t.TempDir()
	out := filepath.Join(root, "out")
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(root, "victim.txt")
	original := []byte("ORIGINAL CONTENTS")
	if err := os.WriteFile(victim, original, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(victim, filepath.Join(out, "x.mbin")); err != nil {
		t.Skipf("hardlinks unsupported on this filesystem: %v", err)
	}

	a := craft(t, []string{"x.mbin"}, [][]byte{[]byte("PAYLOAD")})
	_, err := a.ExtractTo(out, "")
	if err == nil {
		t.Fatal("ExtractTo wrote through a hardlink instead of refusing")
	}
	if !errors.Is(err, hgpak.ErrUnsafePath) {
		t.Errorf("error is %v, want ErrUnsafePath", err)
	}
	if !strings.Contains(err.Error(), "x.mbin") {
		t.Errorf("error %q does not name the offending path", err)
	}
	after, readErr := os.ReadFile(victim)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if !bytes.Equal(after, original) {
		t.Errorf("a file outside the output tree was modified: victim = %q, want %q", after, original)
	}
}

// Re-extracting over an existing output directory overwrites plain files
// cleanly. The destination guards refuse links, not ordinary re-runs.
func TestReExtractionIsIdempotent(t *testing.T) {
	out := t.TempDir()
	a := craft(t, []string{"metadata/thing.mbin"}, [][]byte{[]byte("contents")})
	for i := range 2 {
		res, err := a.ExtractTo(out, "")
		if err != nil {
			t.Fatalf("ExtractTo run %d: %v", i+1, err)
		}
		if res.Files != 1 {
			t.Errorf("run %d wrote %d files, want 1", i+1, res.Files)
		}
	}
	got, err := os.ReadFile(filepath.Join(out, "metadata", "thing.mbin"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, []byte("contents")) {
		t.Errorf("after re-extraction file is %q, want %q", got, "contents")
	}
}
