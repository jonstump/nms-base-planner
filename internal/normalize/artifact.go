package normalize

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/jonstump/nms-base-planner/internal/domain"
)

// Governing: ADR-0001 (two-tier NMS data ingestion), SPEC-0004 REQ "Source
// Provenance and Version Stamping", REQ "Deterministic Output"

// Builder accumulates the pieces of a Tier 1 artifact and emits it.
//
// Later stories fill it: the recipe graph populates Items and Recipes, the
// base-economy pass populates Economy. This story owns the envelope — what
// every artifact must carry regardless of which pass produced its contents.
type Builder struct {
	gameVersion  string
	archives     []string
	mbinCompiler string
	note         string

	items   []domain.Item
	recipes []domain.Recipe
	economy *domain.Economy
}

// NewBuilder starts an artifact for the named game build.
//
// gameVersion MUST have been read from the install. SPEC-0004 REQ "Source
// Provenance and Version Stamping" forbids emitting a guess or a
// placeholder, so an empty value is refused here rather than written and
// discovered later.
func NewBuilder(gameVersion, mbinCompiler string, archives []string) (*Builder, error) {
	if gameVersion == "" {
		return nil, fmt.Errorf("game version was not determined from the install: %w", ErrSourceMissing)
	}
	if mbinCompiler == "" {
		return nil, fmt.Errorf("MBINCompiler version was not determined: %w", ErrSourceMissing)
	}
	if len(archives) == 0 {
		return nil, fmt.Errorf("no source archives recorded: %w", ErrSourceMissing)
	}
	cp := append([]string(nil), archives...)
	return &Builder{gameVersion: gameVersion, mbinCompiler: mbinCompiler, archives: cp}, nil
}

// SetNote attaches a human-readable note to the artifact.
func (b *Builder) SetNote(note string) { b.note = note }

// AddItems appends items. Ordering is imposed at emit time, so callers need
// not sort.
func (b *Builder) AddItems(items ...domain.Item) { b.items = append(b.items, items...) }

// AddRecipes appends recipes.
func (b *Builder) AddRecipes(recipes ...domain.Recipe) { b.recipes = append(b.recipes, recipes...) }

// SetEconomy attaches the base-economy section.
func (b *Builder) SetEconomy(e *domain.Economy) { b.economy = e }

// Artifact assembles and validates the artifact.
//
// Every collection is sorted into a defined order here rather than at the
// call sites, so determinism is a property of the emitter and cannot be lost
// by a caller that happened to range over a map.
func (b *Builder) Artifact() (*domain.Tier1, error) {
	t := &domain.Tier1{
		SchemaVersion: domain.CurrentSchemaVersion,
		GameVersion:   b.gameVersion,
		Extracted:     true,
		Source:        fmt.Sprintf("%s via MBINCompiler %s", joinArchives(b.archives), b.mbinCompiler),
		Note:          b.note,
		Provenance: &domain.Provenance{
			Archives:     sortedCopy(b.archives),
			MBINCompiler: b.mbinCompiler,
		},
		Items:   append([]domain.Item(nil), b.items...),
		Recipes: append([]domain.Recipe(nil), b.recipes...),
		Economy: b.economy,
	}
	sortArtifact(t)
	if err := t.Validate(); err != nil {
		return nil, fmt.Errorf("assembling artifact: %w", err)
	}
	return t, nil
}

// sortArtifact imposes a total order on every collection.
//
// Governing: SPEC-0004 REQ "Deterministic Output" — the artifact is
// committed, so unstable ordering turns each regeneration into an
// unreviewable diff and buries real balance changes in reordering noise.
// Sort keys are chosen to be total: where one field can repeat, the
// remaining fields break the tie, so two records that sort equal are also
// byte-identical and their order cannot show in the output.
func sortArtifact(t *domain.Tier1) {
	sort.Slice(t.Items, func(i, j int) bool { return t.Items[i].ID < t.Items[j].ID })
	sort.Slice(t.Recipes, func(i, j int) bool {
		if t.Recipes[i].Output != t.Recipes[j].Output {
			return t.Recipes[i].Output < t.Recipes[j].Output
		}
		if t.Recipes[i].Method != t.Recipes[j].Method {
			return t.Recipes[i].Method < t.Recipes[j].Method
		}
		// Output and method no longer identify a recipe — many recipes share
		// a pair (ADR-0005) — so the id is what makes this key total.
		return t.Recipes[i].ID < t.Recipes[j].ID
	})
	for _, r := range t.Recipes {
		// Item alone is not total: Validate does not reject a recipe naming
		// the same input twice, and an unstable sort would then leave the
		// caller's insertion order showing through.
		sort.Slice(r.Inputs, func(i, j int) bool {
			a, b := r.Inputs[i], r.Inputs[j]
			if a.Item != b.Item {
				return a.Item < b.Item
			}
			return a.Quantity < b.Quantity
		})
	}
	if t.Economy == nil {
		return
	}
	sort.Slice(t.Economy.Parts, func(i, j int) bool { return t.Economy.Parts[i].ID < t.Economy.Parts[j].ID })
	for _, p := range t.Economy.Parts {
		// Network alone is not total. Every other collection here sorts on a
		// key Validate guarantees unique — item IDs, part IDs, hotspot
		// categories, (output, method) pairs — but nothing rejects a part
		// carrying two dependencies on one network, so the remaining fields
		// have to break the tie. Tiebreaking rather than rejecting, because
		// whether the game data ever does this has not been established, and
		// refusing to generate over an unverified assumption is the failure
		// mode this pipeline already learned once.
		sort.Slice(p.Dependencies, func(i, j int) bool {
			a, b := p.Dependencies[i], p.Dependencies[j]
			if a.Network != b.Network {
				return a.Network < b.Network
			}
			if a.Rate != b.Rate {
				return a.Rate < b.Rate
			}
			return a.Effect < b.Effect
		})
	}
	sort.Slice(t.Economy.Hotspots, func(i, j int) bool {
		return t.Economy.Hotspots[i].Category < t.Economy.Hotspots[j].Category
	})
	sort.Slice(t.Economy.Crops, func(i, j int) bool { return t.Economy.Crops[i].ID < t.Economy.Crops[j].ID })
}

// Encode marshals the artifact deterministically.
func Encode(t *domain.Tier1) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	// Struct field order is fixed by the type, and every slice was sorted by
	// sortArtifact, so this encoding is stable across runs.
	if err := enc.Encode(t); err != nil {
		return nil, fmt.Errorf("encoding artifact: %w", err)
	}
	return buf.Bytes(), nil
}

// WriteFile writes the artifact to path atomically.
//
// Governing: SPEC-0004 REQ "Structural Surprise Fails Loudly" — "no artifact
// file is left behind" when generation fails. Writing to a temporary file in
// the destination directory and renaming means a reader never observes a
// half-written artifact, and a failure partway through leaves the previous
// artifact intact rather than a truncated one.
func WriteFile(path string, t *domain.Tier1) error {
	blob, err := Encode(t)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".tier1-*.tmp")
	if err != nil {
		return fmt.Errorf("creating temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename succeeds

	if _, err := tmp.Write(blob); err != nil {
		tmp.Close()
		return fmt.Errorf("writing %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing %s: %w", tmpName, err)
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return fmt.Errorf("setting mode on %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("renaming %s to %s: %w", tmpName, path, err)
	}
	return nil
}

func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func joinArchives(a []string) string {
	s := sortedCopy(a)
	if len(s) == 1 {
		return s[0]
	}
	return fmt.Sprintf("%d archives (%s …)", len(s), s[0])
}
