import { expect, test, type Page } from "@playwright/test";

import { fromStored, toStored, differ } from "../../src/state/preferences";
import { INITIAL_VIEW_STATE } from "../../src/state/view-state";
import {
  ABSENT,
  ABSENT_DISPLAY,
  present,
  storedQuantity,
  storedTick,
} from "../../src/store/absence";
import type { PlaceRecord } from "../../src/store";

/*
 * Governing: ADR-0008 (durable user data), SPEC-0009 REQ "View Preferences
 * Survive a Reload", REQ "An Empty Store Is a Designed State"
 *
 * Against the real application at "/", not a fixture. The requirement is
 * that a preference survives a reload, and a test that called the restore
 * function directly would be asserting that a function it just called does
 * what it says — which is true of every function, including a broken one
 * that nothing ever calls.
 *
 * Playwright gives each test its own browser context, so IndexedDB starts
 * empty per test and the reload is a real one within that context.
 */

/** The preferences as they actually sit in IndexedDB. */
async function storedPreferences(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    (database) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const opening = indexedDB.open(database);
        opening.onsuccess = () => {
          const db = opening.result;
          if (!db.objectStoreNames.contains("workspace")) {
            db.close();
            resolve({});
            return;
          }
          const read = db.transaction("workspace", "readonly");
          const got = read.objectStore("workspace").get("self");
          got.onsuccess = () => {
            db.close();
            const record = got.result as { preferences?: Record<string, unknown> };
            resolve(record?.preferences ?? {});
          };
          got.onerror = () => {
            db.close();
            resolve({});
          };
        };
        opening.onerror = () => {
          resolve({});
        };
      }),
    DATABASE,
  );
}

/**
 * Wait until the write has actually reached the store.
 *
 * Not politeness, and deliberately not a poll on `data-saving`. That
 * attribute is false before the write effect runs as well as after it
 * finishes, so waiting for false can be satisfied by the state *preceding*
 * the write — which is what the first version did. It passed locally on
 * timing luck and failed in CI, twice, which is exactly the failure mode a
 * flag-based wait has.
 *
 * Polling the record itself has no such window: it is the thing the
 * requirement is about.
 */
async function persisted(page: Page, expected: Record<string, unknown>): Promise<void> {
  await expect
    .poll(async () => storedPreferences(page), { timeout: 10_000 })
    .toMatchObject(expected);
}

/** The database AppShell uses when no store is injected. */
const DATABASE = "nms-planner";

/**
 * Plant a workspace and a place straight into IndexedDB.
 *
 * Both, always. A store holding places with no workspace record is not a
 * fresh device — it is a store whose halves disagree — and `load` reports
 * MALFORMED_RECORD rather than silently dropping the places.
 */
async function plant(page: Page, places: PlaceRecord[]): Promise<void> {
  await page.evaluate(
    ([database, records]) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open(database, 1);
        opening.onupgradeneeded = () => {
          const db = opening.result;
          if (!db.objectStoreNames.contains("workspace"))
            db.createObjectStore("workspace");
          if (!db.objectStoreNames.contains("places"))
            db.createObjectStore("places", { keyPath: "id" });
        };
        opening.onsuccess = () => {
          const db = opening.result;
          const transaction = db.transaction(["workspace", "places"], "readwrite");
          transaction
            .objectStore("workspace")
            .put(
              { schemaVersion: 1, ownerId: null, updatedAt: "2026-01-01T00:00:00.000Z" },
              "self",
            );
          for (const record of records) transaction.objectStore("places").put(record);
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? new Error("plant failed"));
          };
        };
        opening.onerror = () => {
          reject(opening.error ?? new Error("plant open failed"));
        };
      }),
    [DATABASE, places] as const,
  );
}

/* ----------------------------------------------------------------------
 * The contract, as pure functions
 * ------------------------------------------------------------------- */

test("absent and zero are different values", () => {
  const place: PlaceRecord = {
    id: "p1",
    kind: "base",
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    stocked: { copper: "0" },
  };

  /*
   * The distinction the requirement is about. A player who has looked at
   * their copper and found none has stored "0"; a player who has never
   * looked has stored nothing, and the two must not render the same.
   */
  expect(storedQuantity(place, "copper")).toEqual(present("0"));
  expect(storedQuantity(place, "ferrite")).toEqual(ABSENT);
  expect(storedQuantity(place, "ferrite").present).toBe(false);
});

test("an unticked part and a part never seen are different", () => {
  const place: PlaceRecord = {
    id: "p1",
    kind: "base",
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    ticks: { "part-1": false },
  };
  expect(storedTick(place, "part-1")).toEqual(present(false));
  expect(storedTick(place, "part-2")).toEqual(ABSENT);
});

test("a stored preference of the wrong type falls back rather than coercing", () => {
  /*
   * `"false"` is truthy. A decode that trusted it would flip a preference
   * the player had switched off, and would do it silently on every load.
   */
  const decoded = fromStored({ showUnverified: "false", groupSeparator: " " });
  expect(decoded.showUnverified).toBe(INITIAL_VIEW_STATE.preferences.showUnverified);
  expect(decoded.groupSeparator).toBe(" ");
});

test("one unreadable preference does not discard the other", () => {
  const decoded = fromStored({ showUnverified: false, groupSeparator: true });
  expect(decoded.showUnverified).toBe(false);
  expect(decoded.groupSeparator).toBe(INITIAL_VIEW_STATE.preferences.groupSeparator);
});

test("an empty separator survives the round trip, because it is a real setting", () => {
  /*
   * "" is "leave the digits ungrouped", not "unset". A decode using `||`
   * rather than a type check would turn it back into a comma.
   */
  const round = fromStored(toStored({ groupSeparator: "", showUnverified: false }));
  expect(round).toEqual({ groupSeparator: "", showUnverified: false });
});

test("an absent workspace record yields the initial preferences", () => {
  expect(fromStored(undefined)).toEqual(INITIAL_VIEW_STATE.preferences);
});

test("differ is what stops an unchanged preference writing", () => {
  const base = INITIAL_VIEW_STATE.preferences;
  expect(differ(base, { ...base })).toBe(false);
  expect(differ(base, { ...base, showUnverified: !base.showUnverified })).toBe(true);
});

/* ----------------------------------------------------------------------
 * The application
 * ------------------------------------------------------------------- */

test("a device with no prior data reaches the empty state and reports no failure", async ({
  page,
}) => {
  await page.goto("/");
  const saved = page.getByRole("region", { name: "Saved places" });

  await expect(saved.getByText(/Nothing saved on this device yet/)).toBeVisible();

  /*
   * The half that matters. Empty is ordinary — cleared storage, a fresh
   * device, a private window all produce it — and an application that
   * reported it as a fault would be telling the player something is wrong
   * on their very first visit.
   */
  await expect(saved.getByText(/could not|failed|error|unavailable/i)).toHaveCount(0);
});

test("a preference set, then reloaded, is as the player left it", async ({ page }) => {
  await page.goto("/");
  const group = page.getByLabel("Group digits");

  await expect(group).toBeChecked();
  await group.uncheck();
  await expect(group).not.toBeChecked();
  await persisted(page, { groupSeparator: "" });

  /*
   * A real reload. The whole requirement is that the value survives the
   * page going away, and calling a restore function proves nothing about
   * that.
   */
  await page.reload();

  await expect(page.getByLabel("Group digits")).not.toBeChecked();
});

test("both preferences survive, not just the one that was changed last", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Group digits").uncheck();
  await page.getByLabel("Show unverified").uncheck();
  await persisted(page, { groupSeparator: "", showUnverified: false });

  await page.reload();

  await expect(page.getByLabel("Group digits")).not.toBeChecked();
  await expect(page.getByLabel("Show unverified")).not.toBeChecked();
});

test("a place with no stocked quantity renders absent, not zero", async ({ page }) => {
  await page.goto("/");
  await plant(page, [
    {
      id: "aurora",
      kind: "base",
      schemaVersion: 1,
      name: "Aurora Flats",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
      /* Deliberately no `stocked` at all. */
    },
  ]);
  await page.reload();

  await page.getByLabel("Target").fill("ANTIMATTER");

  const row = page
    .getByRole("region", { name: "Saved places" })
    .getByRole("listitem")
    .filter({ hasText: "Aurora Flats" });

  await expect(row).toBeVisible();
  await expect(row).toContainText(ABSENT_DISPLAY);
  /*
   * The defect this exists to prevent, spelled out: `?? 0` reads as a
   * careful default and renders a stock level for an item the player has
   * never looked at.
   */
  await expect(row).not.toContainText("0");
});

test("a stocked zero is shown as zero, because the player entered it", async ({
  page,
}) => {
  /*
   * The companion. A surface that rendered every quantity as an em dash
   * would satisfy the test above and be useless.
   */
  await page.goto("/");
  await plant(page, [
    {
      id: "ridge",
      kind: "base",
      schemaVersion: 1,
      name: "Ridge Station",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
      stocked: { ANTIMATTER: "0" },
    },
  ]);
  await page.reload();

  await page.getByLabel("Target").fill("ANTIMATTER");

  const row = page
    .getByRole("region", { name: "Saved places" })
    .getByRole("listitem")
    .filter({ hasText: "Ridge Station" });

  await expect(row).toContainText("0");
  await expect(row).not.toContainText(ABSENT_DISPLAY);
});

test("a planted place reaches the list, so the empty state is not the only path", async ({
  page,
}) => {
  await page.goto("/");
  await plant(page, [
    {
      id: "aurora",
      kind: "base",
      schemaVersion: 1,
      name: "Aurora Flats",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    },
  ]);
  await page.reload();

  const saved = page.getByRole("region", { name: "Saved places" });
  await expect(saved.getByText(/Nothing saved on this device yet/)).toHaveCount(0);
  await expect(saved.getByText("Aurora Flats")).toBeVisible();
});
