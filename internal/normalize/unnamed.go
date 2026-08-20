package normalize

// Governing: SPEC-0004 REQ "Display Name Resolution", REQ "Search Boundaries
// Are Recorded"
//
// A small number of products carry a NameLower key that no English
// localisation table defines. Verified against NMS 5.97 by raw byte grep
// across all sixteen English tables (nms_loc{1,4,5,6,7,8,9}_english,
// nms_update3_english, and their usenglish counterparts): 18 of 2,144
// products, and zero of 111 substances.
//
// SPEC-0004 forbids falling back to the raw key or the ID, because an
// artifact full of UI_STARCHART_BUILDER_NAME_L loads cleanly and looks like
// data. An enumerated allowlist is not that fallback: it is a reviewed,
// finite set that a reader can check, and anything outside it still fails.
//
// Every entry here is unreferenced — no recipe and no product requirement
// names any of them — so omitting them leaves the graph closed. That is
// asserted at runtime rather than assumed, because it is the property that
// makes omission safe and a game update could change it.
//
// The set is dominated by U_CR* crew/frigate items plus two apparently
// unreleased entries. If a game update names them, they simply stop being
// skipped; if it adds new unnamed items, generation fails and this list is
// the place to record the decision.
var knownUnnamed = map[string]string{
	"CHART_BUILDER": "UI_STARCHART_BUILDER_NAME_L",
	"WORLDSMB_SOUL": "UI_WORLDSMB_SOUL_NAME_L",
	"U_CRFIGHT1":    "UT_CR_FIGHT_NAME_L",
	"U_CRFIGHT2":    "UT_CR_FIGHT_NAME_L",
	"U_CRFIGHT3":    "UT_CR_FIGHT_NAME_L",
	"U_CRFIGHT4":    "UT_CR_FIGHT_NAME_L",
	"U_CRMINE1":     "UT_CR_MINE_NAME_L",
	"U_CRMINE2":     "UT_CR_MINE_NAME_L",
	"U_CRMINE3":     "UT_CR_MINE_NAME_L",
	"U_CRMINE4":     "UT_CR_MINE_NAME_L",
	"U_CRSCI1":      "UT_CR_SCI_NAME_L",
	"U_CRSCI2":      "UT_CR_SCI_NAME_L",
	"U_CRSCI3":      "UT_CR_SCI_NAME_L",
	"U_CRSCI4":      "UT_CR_SCI_NAME_L",
	"U_CRTRADE1":    "UT_CR_TRADE_NAME_L",
	"U_CRTRADE2":    "UT_CR_TRADE_NAME_L",
	"U_CRTRADE3":    "UT_CR_TRADE_NAME_L",
	"U_CRTRADE4":    "UT_CR_TRADE_NAME_L",
}

// skipUnnamed reports whether an item whose name key did not resolve is a
// known-unnamed entry that may be omitted.
//
// The key must match too: an ID on the list whose key has changed is a
// different situation — the game moved something — and must fail rather
// than be silently skipped on the strength of a stale entry.
func skipUnnamed(id, key string) bool {
	want, ok := knownUnnamed[id]
	return ok && want == key
}

// KnownUnnamedCount reports the size of the allowlist, for reporting.
func KnownUnnamedCount() int { return len(knownUnnamed) }
