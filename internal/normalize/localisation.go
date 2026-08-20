package normalize

import (
	"path/filepath"
	"sort"
)

// Governing: ADR-0001 (two-tier NMS data ingestion), SPEC-0004 REQ "Display
// Name Resolution"
//
// Reality tables carry localisation *keys*, not names. The Stasis Device's
// NameLower is UI_ULTRAPROD_2_NAME_L; the string "Stasis Device" lives in
// language/nms_loc*_english.mbin, inside a different archive from the
// product table. Searching the product table for a display name therefore
// finds nothing, which is a dead end worth failing loudly about rather than
// papering over.

// Localisation resolves localisation keys to English strings.
type Localisation struct {
	byKey map[string]string
	// files records what was read, so a failure to resolve can say where we
	// looked rather than only what was missing.
	files []string
}

// LoadLocalisation reads every localisation table matching pattern and
// indexes its entries by key.
//
// Later files do not override earlier ones: the tables partition the key
// space rather than layering, so a duplicate key across two files means the
// input set is wrong (both a base and a patch table, say) and is reported.
func LoadLocalisation(paths []string) (*Localisation, error) {
	if len(paths) == 0 {
		return nil, Missing("language/nms_loc*_english")
	}
	l := &Localisation{byKey: make(map[string]string, 64_000)}
	for _, p := range sortedStrings(paths) {
		doc, err := readMXML(p, "cTkLocalisationTable")
		if err != nil {
			return nil, err
		}
		name := filepath.Base(p)
		l.files = append(l.files, name)
		rows, err := doc.rows(name, "Table", "TkLocalisationEntry")
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			key, err := r.nonEmpty(name, r.ID, "Id")
			if err != nil {
				return nil, err
			}
			// A key present with an empty English value is a real state in
			// these tables (placeholder entries), and is kept as such: the
			// caller decides whether an empty name is acceptable, rather
			// than this layer silently dropping the key and reporting it as
			// missing later.
			val, err := r.str(name, key, "English")
			if err != nil {
				return nil, err
			}
			if prev, dup := l.byKey[key]; dup && prev != val {
				return nil, Unrecognized(name, key, "Id", "one definition per key", "a conflicting duplicate")
			}
			l.byKey[key] = val
		}
	}
	return l, nil
}

// Len reports how many keys were indexed.
func (l *Localisation) Len() int { return len(l.byKey) }

// Files reports the localisation tables that were read, in sorted order.
//
// Governing: SPEC-0004 REQ "Search Boundaries Are Recorded" — a name
// resolved by consulting several tables should be able to say which ones.
func (l *Localisation) Files() []string { return sortedStrings(l.files) }

// Resolve returns the English string for a key.
//
// A key that does not resolve fails rather than falling back to the key or
// the item ID. An artifact full of UI_ULTRAPROD_2_NAME_L loads cleanly and
// looks like data, which surfaces as a confusing UI long after the cause —
// strictly worse than failing here.
func (l *Localisation) Resolve(table, row, key string) (string, error) {
	if key == "" {
		return "", Unrecognized(table, row, "name key", "a localisation key", `""`)
	}
	v, ok := l.byKey[key]
	if !ok {
		return "", UnresolvedName(table, row, key)
	}
	if v == "" {
		return "", Unrecognized(table, row, "name", "a non-empty English string", "an empty localisation entry")
	}
	return v, nil
}

func sortedStrings(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}
