import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  decodePlanFromHash,
  encodePlanToHash,
  validatePlan,
  type Plan,
} from "../../src/boundary";
import { asQuantity } from "../../src/boundary/quantity";

/*
 * Governing: ADR-0008 (durable user data lives in a local-first store),
 * ADR-0010 (places first and the shell), SPEC-0011 REQ "The Hash Owns the
 * Plan, the Store Owns the Player", REQ "Signing In Is Not a Sync Trigger"
 *
 * Two mechanisms now exist and each is individually a plausible home for the
 * same value, which is what makes the drift silent. The boundary is: the
 * hash carries the plan — target, quantity, methods, recipes, assignments —
 * and the store carries the player: places, notes, ticks, preferences.
 *
 * The direction worth guarding hardest is the second scenario. Leaking a
 * note into a link is visible the first time someone reads a link. A decoded
 * hash quietly authoring a place record is not visible at all, and it is the
 * change someone makes while trying to make sharing "work better".
 */

const STORE_FIXTURE = "/tests/fixtures/store.html";
const DISCIPLINE_FIXTURE = "/tests/fixtures/store-discipline.html";

function q(value: string): NonNullable<ReturnType<typeof asQuantity>> {
  const quantity = asQuantity(value);
  if (quantity === null) throw new Error(`${value} is not a quantity`);
  return quantity;
}

const FULL_PLAN: Plan = {
  target: "STASIS_DEVICE",
  quantity: q("3"),
  methods: { CAVE2: "REFINE" },
  recipes: { OXYGEN: "OXYGEN_REFINE" },
  assignments: { FERRITE_DUST: "base-2", COBALT: "base-5" },
};

/** A place with every player-authored field populated. */
const PLACE = {
  id: "aurora",
  kind: "base" as const,
  name: "Aurora Flats",
  notes: "Landing pad on the north ridge. Watch the sentinels near the copper.",
  tags: ["copper", "temperate"],
  ticks: { "part-1": true, "part-7": true },
  stocked: { COBALT: "120" },
};

let counter = 0;
function freshDatabase(): string {
  counter += 1;
  return `ownership-${String(counter)}-${String(Math.floor(performance.now()))}`;
}

/* ----------------------------------------------------------------------
 * The hash carries the plan, and only the plan
 * ------------------------------------------------------------------- */

test("a hash encoded while the store is full carries no player-authored value", async ({
  page,
}) => {
  /*
   * The acceptance criterion is explicit that the test "needs notes and
   * ticks present, or it proves nothing" — a hash encoded from an empty
   * session contains no note for the trivial reason that there was none.
   */
  await page.goto(STORE_FIXTURE, { waitUntil: "load" });
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");

  const database = freshDatabase();
  const opened = await page.evaluate((db) => window.__store.open(db), database);
  expect(opened.kind).toBe("ok");
  const written = await page.evaluate(
    ([db, place]) => window.__store.putPlace(db, place),
    [database, PLACE] as const,
  );
  expect(written.kind, "the place was not stored, so nothing was at risk").toBe("ok");

  const hash = encodePlanToHash(FULL_PLAN);
  const decoded = Buffer.from(
    hash.split("=")[1]?.replaceAll("-", "+").replaceAll("_", "/") ?? "",
    "base64",
  ).toString("utf8");

  for (const leaked of [
    PLACE.name,
    PLACE.notes,
    "part-1",
    "ticks",
    "notes",
    "tags",
    "stocked",
    "aurora",
  ]) {
    expect(decoded, `the hash carries ${leaked}`).not.toContain(leaked);
  }

  /* And it does carry the plan, so the assertions above are not vacuous. */
  expect(decoded).toContain("STASIS_DEVICE");
  expect(decoded).toContain("base-2");
});

test("the hash carries assignments, because a link without them shares a plan that lands nowhere", () => {
  const restored = decodePlanFromHash(encodePlanToHash(FULL_PLAN));
  expect(restored.plan.assignments).toEqual(FULL_PLAN.assignments);
  expect(restored.plan.methods).toEqual(FULL_PLAN.methods);
  expect(restored.plan.recipes).toEqual(FULL_PLAN.recipes);
});

test("a hash carrying player-authored fields drops them rather than rejecting", () => {
  /*
   * Dropped, not rejected: SPEC-0005 requires an undecodable hash produce
   * the empty plan, and a hash that is a *valid* plan plus extra keys is not
   * undecodable. What matters is that the extra keys have nowhere to go, so
   * the value never reaches a Plan and cannot be written anywhere.
   */
  const result = validatePlan({
    target: "STASIS_DEVICE",
    quantity: "1",
    ticks: { "part-1": true },
    notes: "a note someone put in a link",
    places: [{ id: "aurora", name: "Aurora Flats" }],
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(Object.keys(result.plan).sort()).toEqual([
    "assignments",
    "methods",
    "quantity",
    "recipes",
    "target",
  ]);
  expect(JSON.stringify(result.plan)).not.toContain("part-1");
  expect(JSON.stringify(result.plan)).not.toContain("Aurora");
});

test("the hash codec names no player-authored field", () => {
  /*
   * Mechanical, because the leak this guards is a field someone adds to the
   * encoder while making a link "more useful". The codec should have no
   * vocabulary for a note or a tick at all.
   */
  const codec = readFileSync(
    path.join(import.meta.dirname, "..", "..", "src", "boundary", "plan-hash.ts"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

  for (const owned of ["ticks", "notes", "tags", "stocked", "places", "preferences"]) {
    expect(codec.includes(owned), `plan-hash.ts knows about ${owned}`).toBe(false);
  }
});

/* ----------------------------------------------------------------------
 * Decoding authors nothing
 * ------------------------------------------------------------------- */

async function storedPlaces(page: Page, database: string): Promise<unknown[]> {
  return page.evaluate(
    (db) =>
      new Promise<unknown[]>((resolve) => {
        const opening = indexedDB.open(db);
        opening.onsuccess = () => {
          const store = opening.result;
          if (!store.objectStoreNames.contains("places")) {
            store.close();
            resolve([]);
            return;
          }
          const all = store
            .transaction("places", "readonly")
            .objectStore("places")
            .getAll();
          all.onsuccess = () => {
            store.close();
            resolve(all.result);
          };
          all.onerror = () => {
            store.close();
            resolve([]);
          };
        };
        opening.onerror = () => {
          resolve([]);
        };
      }),
    database,
  );
}

test("decoding a hash carrying assignments authors no place record", async ({ page }) => {
  await page.goto(STORE_FIXTURE, { waitUntil: "load" });
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");

  const database = freshDatabase();
  await page.evaluate((db) => window.__store.open(db), database);
  await page.evaluate(([db, place]) => window.__store.putPlace(db, place), [
    database,
    PLACE,
  ] as const);

  const before = await storedPlaces(page, database);
  expect(before.length).toBe(1);

  /*
   * The assignments name bases that do not exist as records. A decoder that
   * "helpfully" created them would be authoring player data from a link,
   * which is the direction the requirement calls out.
   */
  const restored = decodePlanFromHash(encodePlanToHash(FULL_PLAN));
  expect(restored.plan.assignments).toEqual(FULL_PLAN.assignments);

  const after = await storedPlaces(page, database);
  expect(after).toEqual(before);
});

/* ----------------------------------------------------------------------
 * Signing in attaches an owner and transmits nothing
 * ------------------------------------------------------------------- */

test("attaching an owner transmits no place record", async ({ page }) => {
  /*
   * ADR-0008's boundary, carried forward by ADR-0009 §4: sign-in attaches an
   * owner and does not, by itself, send anything. There is no sign-in yet
   * and `ownerId` is the whole of what one would change, so this writes it
   * and asserts the network recorder saw nothing from a store path.
   *
   * The store's own discipline suite proves the steady state. This is the
   * moment the acceptance criterion asks for — the transition itself.
   */
  await page.goto(DISCIPLINE_FIXTURE, { waitUntil: "load" });
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    window.__discipline.reset();
  });

  const database = freshDatabase();
  const seeded = await page.evaluate((db) => window.__discipline.seed(db), database);
  for (const outcome of seeded) expect(outcome).toMatch(/:ok$/);

  const outcomes = await page.evaluate(
    (db) => window.__discipline.attachOwner(db, "player-42"),
    database,
  );
  expect(outcomes, "the owner was not attached, so nothing was tested").toContain(
    "attach:ok",
  );

  const attempts = await page.evaluate(() => window.__discipline.attempts());
  expect(attempts, "attaching an owner reached the network").toEqual([]);

  /* The places are still there, and still exactly as the player left them. */
  const workspace = (await page.evaluate(
    (db) => window.__discipline.raw(db, "workspace"),
    database,
  )) as Record<string, unknown>[];
  expect(workspace[0]?.["ownerId"]).toBe("player-42");

  const places = (await page.evaluate(
    (db) => window.__discipline.raw(db, "places"),
    database,
  )) as Record<string, unknown>[];
  expect(places.length).toBe(1);
});
