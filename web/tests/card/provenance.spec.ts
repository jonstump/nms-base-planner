import { expect, test } from "@playwright/test";

/*
 * Governing: SPEC-0007 REQ "Duration Display", REQ "Provenance on Displayed
 * Figures", REQ "Absent Data Is Absent"
 *
 * Three rules that apply across the whole card rather than to one section,
 * which is why they are one story: implementing them per-section is how one
 * section ends up disagreeing with another.
 */

const FIXTURE = "/tests/fixtures/card-provenance.html";
const ALL = '[data-base="Everything Unverified"]';
const MIXED = '[data-base="Mixed Provenance"]';

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "load" });
});

test("every duration on the card reads as an estimate", async ({ page }) => {
  const durations = page.locator(`${ALL} [data-duration]`);
  // Growth, fill, cycle, process — every kind the card can show.
  await expect(durations).toHaveCount(4);

  const count = await durations.count();
  for (let i = 0; i < count; i += 1) {
    const text = await durations.nth(i).innerText();
    expect(text).toContain("≈");
    expect(text).toContain("est.");
  }
});

test("no duration is rendered in a unit the payload did not use", async ({ page }) => {
  /*
   * The payload's durations are seconds. A card converting to minutes or
   * hours would be doing the arithmetic REQ "Duration Display" forbids —
   * the discipline scan rules out the arithmetic itself; this rules out a
   * converted figure reaching the screen by some other route.
   */
  const text = await page.locator(`${ALL} [data-section]`).first().innerText();
  expect(text).not.toMatch(/\bmin\b|\bminutes\b|\bhours?\b/i);
});

test("a row marker and the base marker are both surfaced", async ({ page }) => {
  const card = page.locator(ALL);
  await expect(card.locator('[data-provenance="row"]').first()).toBeVisible();
  await expect(card.locator('[data-provenance="base"]')).toHaveCount(1);
});

test("neither marker substitutes for the other", async ({ page }) => {
  /*
   * A verified base carrying an unverified row. The row is marked and the
   * base is not — a card summarising rows into the base marker would mark
   * both, and one substituting the base's flag for its rows' would mark
   * neither.
   */
  const card = page.locator(MIXED);
  await expect(card.locator('[data-provenance="row"]').first()).toBeVisible();
  await expect(card.locator('[data-provenance="base"]')).toHaveCount(0);
});

test("the card stays legible with the marker on everything", async ({ page }) => {
  const card = page.locator(ALL);

  /*
   * This is the real condition, not an edge case: no curated constant has a
   * verified date, so every producer row is marked. The requirement says the
   * treatment "MUST NOT rely on rarity for its restraint".
   */
  const rows = await card.locator("[data-row]").count();
  const markers = await card.locator('[data-provenance="row"]').count();
  expect(markers).toBe(rows);
  expect(rows).toBeGreaterThan(4);

  // The card still reads: its name and its figures are not crowded out.
  await expect(card.locator(".card-name")).toContainText("Everything Unverified");
  await expect(card.locator('[data-row="farm"]')).toContainText("Plants");

  // And nothing overflows horizontally under that many markers.
  const overflow = await card.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(overflow).toBe(false);
});

test("the marker is distinct from the warning and error treatments", async ({ page }) => {
  const marker = page.locator(`${ALL} [data-provenance="row"]`).first();
  await expect(marker).toHaveClass(/status-unverified/);
  // Not the warning treatment, and not the error one.
  await expect(marker).not.toHaveClass(/status-warning/);
  await expect(marker).not.toHaveClass(/status-danger/);

  const glyph = await marker.innerText();
  expect(glyph).toContain("?");
  expect(glyph).not.toContain("⚠");
  expect(glyph).not.toContain("✕");

  // It is named, so the distinction survives not seeing the colour.
  await expect(marker).toHaveAttribute("aria-label", "Unverified");
});

test("no environment or location field renders a placeholder", async ({ page }) => {
  /*
   * Planet type, biome, hazards, sentinel level, economy, star class and
   * portal address have no source in the artifact, the domain, or any
   * accepted spec. A missing detail is an omitted element — not an empty
   * one, and not a dash.
   */
  const text = await page.locator(ALL).innerText();
  for (const field of [
    "planet",
    "biome",
    "hazard",
    "sentinel",
    "economy",
    "star class",
    "portal",
  ]) {
    expect(text.toLowerCase()).not.toContain(field);
  }
  expect(text).not.toMatch(/—\s*$/m);
});

test("no control implying persistence exists anywhere on the card", async ({ page }) => {
  /*
   * ADR-0008 is accepted, which discharges the requirement's "until a
   * governing decision" clause — but SPEC-0009 has no implementation reached
   * from here, so there is still nothing to persist into. The v2 prototype's
   * checkable build list, storage tracker, notes and screenshot slot all
   * stay out.
   */
  const card = page.locator(ALL);
  await expect(card.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(card.locator("textarea")).toHaveCount(0);
  await expect(card.locator('input[type="file"]')).toHaveCount(0);

  const names = await card
    .locator("button, input, select, textarea")
    .evaluateAll((nodes) =>
      nodes.map((n) => `${n.getAttribute("aria-label") ?? ""} ${n.textContent ?? ""}`),
    );
  for (const name of names) {
    expect(name.toLowerCase()).not.toMatch(/save|remember|note|screenshot|upload|keep/);
  }
});
