//go:build ignore

// Command gen builds the committed real-archive excerpt used by the hgpak
// tests. It is not part of the package build; run it explicitly:
//
//	go run testdata/gen.go -src "$PCBANKS/NMSARC.globals.pak" -out testdata/excerpt.pak
//
// Governing: SPEC-0003 REQ "Real-Archive Verification" — the fixture must be
// a structurally faithful excerpt carrying real header layout, real block
// framing, real alignment, and real manifest formatting, and must span at
// least two blocks so that omitting 16-byte block alignment or treating
// entry offsets as stream-relative both fail the suite.
package main

import (
	"bytes"
	"crypto/md5"
	"encoding/binary"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"

	"github.com/jonstump/nms-base-planner/internal/hgpak"
	"github.com/klauspost/compress/zstd"
)

func main() {
	src := flag.String("src", "", "path to a real NMSARC .pak")
	out := flag.String("out", "testdata/excerpt.pak", "output fixture path")
	min := flag.Int("min", 70000, "minimum decompressed stream bytes (must exceed 65536 to span two blocks)")
	flag.Parse()
	if *src == "" {
		log.Fatal("-src is required")
	}
	if err := run(*src, *out, *min); err != nil {
		log.Fatal(err)
	}
}

func run(src, out string, min int) error {
	f, err := os.Open(src)
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
		return err
	}
	defer a.Close()

	manifest, err := a.Manifest()
	if err != nil {
		return err
	}
	paths := strings.Split(string(bytes.TrimSuffix(manifest, []byte("\r\n"))), "\r\n")
	if len(paths) != a.Len()-1 {
		return fmt.Errorf("manifest has %d paths, archive has %d entries", len(paths), a.Len())
	}

	// Pick the smallest entries first so the excerpt stays as close to the
	// two-block minimum as possible — the fixture exists to exercise
	// structure, not to ship game data.
	type cand struct {
		idx  int
		path string
		size uint64
	}
	var cands []cand
	for i := 1; i < a.Len(); i++ {
		e, err := a.Entry(i)
		if err != nil {
			return err
		}
		cands = append(cands, cand{i, paths[i-1], e.Size})
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].size < cands[j].size })

	var picked []cand
	total := 0
	for _, c := range cands {
		if total >= min {
			break
		}
		picked = append(picked, c)
		total += int(c.size)
	}
	if total < min {
		return fmt.Errorf("source archive only yields %d bytes, need %d", total, min)
	}
	sort.Slice(picked, func(i, j int) bool { return picked[i].path < picked[j].path })

	bodies := make([][]byte, len(picked))
	for i, c := range picked {
		b, err := a.ReadEntry(c.idx)
		if err != nil {
			return err
		}
		bodies[i] = b
	}
	names := make([]string, len(picked))
	for i, c := range picked {
		names[i] = c.path
	}

	blob, err := build(names, bodies)
	if err != nil {
		return err
	}
	if err := os.WriteFile(out, blob, 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %s: %d entries (+manifest), %d bytes on disk, %d bytes decompressed\n",
		out, len(picked), len(blob), total)
	return nil
}

// align rounds n up to the next multiple of a.
func align(n, a int) int {
	if r := n % a; r != 0 {
		return n + a - r
	}
	return n
}

// build assembles a valid HGPAK from the given paths and bodies, mirroring
// the real container's layout exactly: 16-byte aligned entries within the
// decompressed stream, 65536-byte blocks, 16-byte aligned compressed blocks,
// a CRLF-terminated manifest at entry 0, and MD5-of-lowercase-path hashes.
func build(names []string, bodies [][]byte) ([]byte, error) {
	var manifest bytes.Buffer
	for _, n := range names {
		manifest.WriteString(strings.ToLower(n))
		manifest.WriteString("\r\n")
	}

	entries := append([][]byte{manifest.Bytes()}, bodies...)
	paths := append([]string{""}, names...)

	// Lay the entries out in the decompressed stream, 16-byte aligned.
	var stream bytes.Buffer
	offsets := make([]int, len(entries))
	for i, e := range entries {
		if pad := align(stream.Len(), 16) - stream.Len(); pad > 0 {
			stream.Write(make([]byte, pad))
		}
		offsets[i] = stream.Len()
		stream.Write(e)
	}

	// Split into fixed 65536-byte blocks and compress each.
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		return nil, err
	}
	defer enc.Close()
	raw := stream.Bytes()
	var blocks [][]byte
	for i := 0; i < len(raw); i += hgpak.BlockSize {
		end := min2(i+hgpak.BlockSize, len(raw))
		blocks = append(blocks, enc.EncodeAll(raw[i:end], nil))
	}
	if len(blocks) < 2 {
		return nil, fmt.Errorf("stream is %d bytes: fixture must span at least two blocks", len(raw))
	}

	dataStart := align(0x30+32*len(entries)+8*len(blocks), 16)

	buf := make([]byte, dataStart)
	copy(buf, []byte("HGPAK\x00\x00\x00"))
	binary.LittleEndian.PutUint64(buf[0x08:], hgpak.SupportedVersion)
	binary.LittleEndian.PutUint64(buf[0x10:], uint64(len(entries)))
	binary.LittleEndian.PutUint64(buf[0x18:], uint64(len(blocks)))
	binary.LittleEndian.PutUint64(buf[0x20:], 1)
	binary.LittleEndian.PutUint64(buf[0x28:], uint64(dataStart))

	for i, e := range entries {
		rec := buf[0x30+i*32:]
		if i == 0 {
			// The manifest's own hash is not derivable from a path; real
			// archives carry an opaque value here, so mirror that with the
			// MD5 of the manifest bytes.
			sum := md5.Sum(e)
			copy(rec[:16], sum[:])
		} else {
			sum := md5.Sum([]byte(strings.ToLower(paths[i])))
			copy(rec[:16], sum[:])
		}
		// Offsets address the virtual image of the file, so dataStart is
		// added to the stream position.
		binary.LittleEndian.PutUint64(rec[16:], uint64(dataStart+offsets[i]))
		binary.LittleEndian.PutUint64(rec[24:], uint64(len(e)))
	}
	for i, b := range blocks {
		binary.LittleEndian.PutUint64(buf[0x30+32*len(entries)+i*8:], uint64(len(b)))
	}

	// Blocks start on 16-byte boundaries.
	for _, b := range blocks {
		if pad := align(len(buf), 16) - len(buf); pad > 0 {
			buf = append(buf, make([]byte, pad)...)
		}
		buf = append(buf, b...)
	}
	return buf, nil
}

func min2(a, b int) int {
	if a < b {
		return a
	}
	return b
}
