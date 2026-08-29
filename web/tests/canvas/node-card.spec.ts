import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

/*
 * What a node says about itself.
 *
 * Governing: SPEC-0006 REQ "Node Card", REQ "Yield and Application Display",
 * REQ "Provenance Display", Accessibility Requirements
 *
 * Split across two drivers, because the requirements are.
 *
 * The application is where the real payload is, and it is the only place
 * `5/6` arrives from the engine rather than from a fixture author. But it
 * resolves 36 nodes with 0 unverified and cannot assign a leaf to a base
 * until a later story wires the entry point, so the provenance marker and
 * five of the six identity slots are unreachable there. Those run against
 * the fixture, which mounts the same component through the same ReactFlow.
 *
 * Each half is checked for the thing that would make it vacuous: the
 * application half asserts the real payload actually carried the figures,
 * and the fixture half asserts the fixture actually rendered the states.
 */

const CANVAS = { name: "Dependency tree" } as const;
const FIXTURE = "/tests/fixtures/node-card.html";

async function resolve(page: Page, target: string): Promise<void> {
  await page.getByLabel("Target").fill(target);
  await page.getByRole("button", { name: "Recompute" }).click();
  await expect(
    page.getByRole("region", CANVAS).locator(".node-card").first(),
  ).toBeVisible({ timeout: 30_000 });
}

function card(page: Page, name: string): Locator {
  return page
    .getByRole("region", CANVAS)
    .locator(".node-card")
    .filter({ has: page.locator(".node-name", { hasText: new RegExp(`^${name}$`) }) });
}

/* ----------------------------------------------------------------------
 * Against the real application.
 * ------------------------------------------------------------------- */

test.describe("the real payload", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("the method is a glyph and a word, not a colour", async ({ page }) => {
    await resolve(page, "ANTIMATTER");

    const badges = page.getByRole("region", CANVAS).locator(".node-method");
    await expect(badges.first()).toBeVisible();

    /*
     * SPEC-0006: the badge carries "both a glyph and a text label". The
     * glyph is aria-hidden — a screen reader announcing "white down-pointing
     * triangle raw" is worse than "raw" — so the word is what the
     * accessible name must contain, and the glyph is what must be on screen.
     */
    for (const badge of await badges.all()) {
      /* What is left after the aria-hidden glyph is removed — which is what
       * a screen reader is left with too. */
      const word = (await badge.locator("span:not([aria-hidden])").innerText()).trim();
      expect(word, "a method badge rendered without its word").toMatch(
        /^(raw|craft|refine)$/i,
      );
      await expect(badge.locator(".node-method-glyph")).toHaveCount(1);
    }

    /* All three methods are on this tree, so the table is exercised, and
     * all three glyphs are distinct — one glyph reused for every method
     * would satisfy the per-badge assertion above. */
    const words = await badges.evaluateAll((nodes) =>
      nodes.map((node) =>
        (node.querySelector("span:not([aria-hidden])")?.textContent ?? "")
          .trim()
          .toLowerCase(),
      ),
    );
    expect(new Set(words)).toEqual(new Set(["raw", "craft", "refine"]));

    const glyphs = await badges.evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector(".node-method-glyph")?.textContent ?? ""),
    );
    expect(new Set(glyphs).size).toBe(3);
  });

  test("a fractional application count reaches the screen unrounded", async ({
    page,
  }) => {
    /*
     * The acceptance criterion: "A fractional application count reaches the
     * screen unrounded. This is the first surface at which a non-integer
     * domain figure is displayed."
     *
     * Chromatic Metal, in the Antimatter tree, needs 5/6 of a refine
     * application. Rounding it up to 1 would be the violation SPEC-0006
     * names, and it is exactly what a naive `Math.ceil` on "operations"
     * would produce.
     */
    await resolve(page, "ANTIMATTER");

    const chromatic = card(page, "Chromatic Metal");
    await expect(chromatic).toHaveCount(1);

    const apps = chromatic.locator(".node-figure").filter({ hasText: "apps" });
    await expect(apps).toContainText("5/6");
    await expect(apps).not.toContainText("1 ");

    /* And the yield, which the total alone does not carry. */
    const yields = chromatic.locator(".node-figure").filter({ hasText: "yield" });
    await expect(yields).toContainText("30");
  });

  test("a yield of exactly one is not printed as if it were a fact", async ({ page }) => {
    /*
     * SPEC-0006 requires a yield "other than 1" be visible. The negative
     * half matters as much: Antimatter crafts one per application, and a
     * card that printed "yield 1" on every crafted node would satisfy the
     * requirement's letter while making the figure meaningless.
     */
    await resolve(page, "ANTIMATTER");

    const antimatter = card(page, "Antimatter");
    await expect(antimatter).toHaveCount(1);
    await expect(
      antimatter.locator(".node-figure").filter({ hasText: "yield" }),
    ).toHaveCount(0);
    /* But it does carry its application count, so this is not just an
     * absent figures row. */
    await expect(
      antimatter.locator(".node-figure").filter({ hasText: "apps" }),
    ).toHaveCount(1);
  });

  test("a terminal has no yield or application count, because the payload sends none", async ({
    page,
  }) => {
    await resolve(page, "ANTIMATTER");

    const silver = card(page, "Silver");
    await expect(silver).toHaveCount(1);
    await expect(silver.locator(".node-figure")).toHaveCount(0);
    /* It is still a card with a name, a total and a method. */
    await expect(silver.locator(".node-total")).not.toBeEmpty();
    await expect(silver.locator(".node-method")).toContainText("raw");
  });

  test("every leaf is unassigned, and says so in more than its border", async ({
    page,
  }) => {
    /*
     * Nothing can assign a leaf until SPEC-0006 REQ "Leaf Assignment to
     * Bases" is wired, so every terminal here is unassigned — which is the
     * truth rather than a placeholder. The assertion worth making is that
     * the state is carried by something other than the dashed border.
     */
    await resolve(page, "ANTIMATTER");

    const unassigned = page
      .getByRole("region", CANVAS)
      .locator('.node-card[data-identity="unassigned"]');
    await expect(unassigned).toHaveCount(4); /* four terminals in this tree */

    for (const leaf of await unassigned.all()) {
      await expect(leaf).toHaveClass(/identity-unassigned/);
      await expect(leaf.locator(".node-unassigned")).toContainText(/unassigned/i);
      await expect(leaf.locator(".node-warning-dot")).toHaveCount(1);
    }

    /* A non-leaf gets the 1px neutral border and none of that. */
    const antimatter = card(page, "Antimatter");
    await expect(antimatter).toHaveClass(/node-card-plain/);
    await expect(antimatter.locator(".node-unassigned")).toHaveCount(0);
  });

  test("a card can actually be pointed at", async ({ page }) => {
    /*
     * React Flow turns pointer events off across the node layer when nodes
     * are neither draggable, selectable nor connectable — which this canvas
     * sets, for reasons unrelated to pointing at a card. The effect was that
     * `elementsFromPoint` over a node returned the pane, `:hover` never
     * matched, and the card — a `<button>` — could not be clicked.
     *
     * Nothing looked wrong. SPEC-0006 REQ "Node Card" requires hover be a
     * brightness filter, and a filter that can never apply is a rule kept by
     * nobody. The method control in a later story would have been the first
     * thing to notice, by not opening.
     */
    await resolve(page, "ANTIMATTER");

    const first = page.getByRole("region", CANVAS).locator(".node-card").first();
    const before = await first.evaluate((el) => getComputedStyle(el).filter);
    expect(before, "the card was already filtered before any hover").toBe("none");

    /* No `force`: the point is that the pointer reaches it unaided. */
    await first.hover({ timeout: 5_000 });

    expect(await first.evaluate((el) => el.matches(":hover"))).toBe(true);
    expect(
      await first.evaluate((el) => getComputedStyle(el).filter),
      "hover is not expressed as a filter on the card",
    ).not.toBe("none");

    /* And the card is the topmost thing at its own centre. */
    const topmost = await first.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return hit === el || el.contains(hit);
    });
    expect(topmost, "something is painted over the card").toBe(true);
  });

  test("nothing in the real artifact is unverified, which is why the fixture exists", async ({
    page,
  }) => {
    /*
     * Not a requirement — a guard on the split. design.md records that the
     * normalizer never emits `"verified": false`, so the provenance tests
     * below run against a fixture. If that ever changes, this goes red and
     * the split should be revisited rather than silently kept.
     */
    await resolve(page, "ULTRAPROD2");
    await expect(
      page.getByRole("region", CANVAS).locator(".node-provenance"),
    ).toHaveCount(0);
    await expect(page.getByRole("region", CANVAS).locator(".node-card")).toHaveCount(36);
  });
});

/* ----------------------------------------------------------------------
 * Against the fixture, for the states the artifact cannot produce.
 * ------------------------------------------------------------------- */

test.describe("the states the artifact cannot reach", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE, { waitUntil: "load" });
    await expect(page.locator(".node-card").first()).toBeVisible({ timeout: 20_000 });
  });

  test("each base slot puts its own colour on the border", async ({ page }) => {
    /*
     * Asserted on the rendered result, not the class list — the acceptance
     * criterion says so, and a class-list assertion passes against a
     * stylesheet that has stopped defining the slot.
     */
    const slots = await page
      .locator('.node-card[data-identity]:not([data-identity="unassigned"])')
      .evaluateAll((cards) =>
        cards.map((el) => {
          const cs = getComputedStyle(el);
          return {
            slot: (el as HTMLElement).dataset["identity"] ?? "",
            color: cs.borderTopColor,
            width: cs.borderTopWidth,
            style: cs.borderTopStyle,
          };
        }),
      );

    expect(slots.length, "the fixture rendered no assigned leaves").toBe(6);
    for (const slot of slots) {
      expect(slot.width, `slot ${slot.slot} is not a 3px frame`).toBe("3px");
      expect(slot.style).toBe("solid");
    }
    /* Six slots, six distinct colours — a palette that collapsed to one
     * colour would satisfy every per-slot assertion above. */
    expect(new Set(slots.map((s) => s.color)).size).toBe(6);
  });

  test("base identity survives hover, focus and selection at once", async ({ page }) => {
    /*
     * The scenario SPEC-0006 names, and the reason the interaction
     * primitives are shaped the way they are: "WHEN a leaf node is assigned
     * to a base and is simultaneously hovered, focused and selected THEN its
     * border still shows the base's colour, and hover, focus and selection
     * are shown by filter, outline and overlay ring respectively."
     */
    const leaf = page.locator('.node-card[data-identity="6"]');
    await expect(leaf).toHaveCount(1);

    const before = await leaf.evaluate((el) => getComputedStyle(el).borderTopColor);

    await leaf.hover();
    await leaf.evaluate((el) => {
      (el as HTMLElement).focus();
      el.setAttribute("data-selected", "true");
    });

    const after = await leaf.evaluate((el) => {
      const cs = getComputedStyle(el);
      const ring = getComputedStyle(el, "::after");
      return {
        border: cs.borderTopColor,
        width: cs.borderTopWidth,
        filter: cs.filter,
        outlineWidth: cs.outlineWidth,
        outlineStyle: cs.outlineStyle,
        ringWidth: ring.borderTopWidth,
        ringContent: ring.content,
      };
    });

    expect(after.border, "the border stopped carrying base identity").toBe(before);
    expect(after.width).toBe("3px");
    expect(after.filter, "hover is not a filter").not.toBe("none");
    expect(after.outlineStyle, "focus is not an outline").not.toBe("none");
    expect(after.ringContent, "selection is not an overlay ring").not.toBe("none");
    expect(after.ringWidth).not.toBe("0px");
  });

  test("the unassigned state survives colour being removed entirely", async ({
    page,
  }) => {
    /*
     * The acceptance criterion is worded as a removal, so this removes it:
     * every colour on the page is forced to one value, and the state must
     * still be readable. The dashed border and the word both survive that;
     * the warning dot does not, which is why it is the reinforcement and
     * not the carrier.
     */
    const unassigned = page.locator('.node-card[data-identity="unassigned"]');
    /* Two of them: one verified, one not. Provenance and assignment are
     * separate facts and the fixture keeps them separable. */
    await expect(unassigned).toHaveCount(2);
    const leaf = unassigned.filter({
      has: page.locator(".node-name", { hasText: /^Silver$/ }),
    });
    await expect(leaf).toHaveCount(1);

    await page.addStyleTag({
      content: `*, *::before, *::after {
        color: rgb(128, 128, 128) !important;
        border-color: rgb(128, 128, 128) !important;
        background-color: rgb(0, 0, 0) !important;
        fill: rgb(128, 128, 128) !important;
      }`,
    });

    const state = await leaf.evaluate((el) => ({
      style: getComputedStyle(el).borderTopStyle,
      width: getComputedStyle(el).borderTopWidth,
      text: (el.textContent ?? "").toLowerCase(),
    }));

    expect(state.style, "the dashed frame was the only carrier").toBe("dashed");
    expect(state.width).toBe("3px");
    expect(state.text).toContain("unassigned");
  });

  test("the provenance marker states what it means, on every node in the span", async ({
    page,
  }) => {
    /*
     * SPEC-0006: the marker must state "that the data is community-sourced
     * and not verified in-game". A chip reading only "unverified" leaves
     * the player to guess whether they did something wrong.
     *
     * Three nodes, because SPEC-0001 propagates the flag to every ancestor
     * and design.md is explicit that the real shape is a spine rather than
     * a pair.
     */
    const marked = page.locator(".node-provenance");
    await expect(marked).toHaveCount(3);

    for (const chip of await marked.all()) {
      await expect(chip).toContainText(/not verified in-game/i);
      await expect(chip).toContainText(/community data/i);
    }
  });

  test("provenance is not the treatment reserved for something to fix", async ({
    page,
  }) => {
    /*
     * "WHEN a node carries the provenance marker THEN it is not styled with
     * the error or warning treatment reserved for conditions the player must
     * resolve." Checked against both rather than asserted, per the
     * acceptance criterion — the comparison is to the tokens those
     * treatments actually use, read off the document rather than restated
     * here, so a token whose value changes cannot make this pass by drift.
     */
    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const resolve = (name: string): string => {
        const probe = document.createElement("span");
        probe.style.color = cs.getPropertyValue(name).trim();
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };
      return { warn: resolve("--warn"), danger: resolve("--danger") };
    });

    const chip = page.locator(".node-provenance").first();
    const painted = await chip.evaluate((el) => {
      const cs = getComputedStyle(el);
      const badge = el.querySelector(".status-badge");
      return {
        border: cs.borderTopColor,
        borderStyle: cs.borderTopStyle,
        text: badge === null ? "" : getComputedStyle(badge).color,
      };
    });

    expect(painted.text).not.toBe(tokens.warn);
    expect(painted.text).not.toBe(tokens.danger);
    expect(painted.border).not.toBe(tokens.warn);
    expect(painted.border).not.toBe(tokens.danger);
    /* And it is the dashed hairline the design drew, not a fill. */
    expect(painted.borderStyle).toBe("dashed");

    /* The control: the unassigned dot IS the warning token, so "not warn"
     * above is a distinction this page can actually draw. */
    const dot = await page
      .locator(".node-warning-dot")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(dot, "nothing on this page uses --warn, so the check proves nothing").toBe(
      tokens.warn,
    );
  });

  test("a tree with an unverified span still passes a WCAG 2.1 AA audit", async ({
    page,
  }) => {
    /*
     * The acceptance criterion asks that "a tree with a long unverified span
     * stays readable". Legibility is not entirely mechanical, but contrast
     * is, and the fixture is the only place the marker, all six identity
     * frames and the fractional figure appear at once.
     */
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    expect(
      results.violations.map(
        (violation) =>
          `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join("; ")}`,
      ),
    ).toEqual([]);
  });
});
