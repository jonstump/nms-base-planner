import { expect, test, type Page } from "@playwright/test";

import { MAX_PLACE_BYTES, MEASURED_PLACE_BYTES, SCHEMA_VERSION } from "../../src/store";

/*
 * Governing: ADR-0008 (durable user data, local-first), SPEC-0009
 *
 * The store, in a real browser. IndexedDB exists nowhere else, and a fake
 * would be a test of the fake.
 *
 * Each test uses its own database name so they run in parallel without
 * sharing state. The store is a singleton per origin in production and
 * deliberately not here.
 */

const FIXTURE = "/tests/fixtures/store.html";

let counter = 0;
function freshDatabase(): string {
  counter += 1;
  return `test-store-${String(counter)}-${String(Math.floor(performance.now()))}`;
}

async function openStore(page: Page, database: string, now?: string): Promise<void> {
  const opened = await page.evaluate(
    async ([db, at]) => window.__store.open(db, at || undefined),
    [database, now ?? ""] as const,
  );
  expect(opened.kind, `opening the store failed`).toBe("ok");
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "load" });
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

/* ----------------------------------------------------------------------
 * The workspace and its reserved fields
 * ------------------------------------------------------------------- */

test("a device that has never used the store gets an empty workspace, not a failure", async ({
  page,
}) => {
  const database = freshDatabase();
  await openStore(page, database);

  const loaded = await page.evaluate((db) => window.__store.load(db), database);
  expect(loaded.kind).toBe("ok");
  if (loaded.kind !== "ok") return;

  expect(loaded.value.places).toEqual([]);
  expect(loaded.value.workspace.schemaVersion).toBe(SCHEMA_VERSION);
});

test("ownerId is present and null, not absent", async ({ page }) => {
  /*
   * The distinction SPEC-0009 REQ "A Workspace Owns Places" requires.
   * ADR-0008's migration works because sign-in attaches an owner to a
   * workspace that already carries the field; a field added in version 2
   * cannot do that for data written under version 1.
   */
  const database = freshDatabase();
  await openStore(page, database);
  await page.evaluate(
    (db) => window.__store.putPlace(db, { id: "p1", kind: "base", name: "Verdant" }),
    database,
  );

  const shape = await page.evaluate(async (db) => {
    const loaded = await window.__store.load(db);
    if (loaded.kind !== "ok") return null;
    return {
      hasOwnerId: "ownerId" in loaded.value.workspace,
      ownerId: loaded.value.workspace.ownerId,
    };
  }, database);

  expect(shape?.hasOwnerId, "ownerId must be a present field").toBe(true);
  expect(shape?.ownerId).toBeNull();
});

test("updatedAt and revision are written even though nothing reads them", async ({
  page,
}) => {
  /*
   * Reserved by ADR-0008 for the sync ADR it defers to. A reviewer who has
   * not read ADR-0008 will
   * reasonably ask why three unused fields exist, so this asserts them
   * rather than leaving it to judgement: a store that adds ordering later
   * cannot order edits made before it existed.
   */
  const database = freshDatabase();
  await openStore(page, database, "2026-08-28T06:00:00.000Z");

  const written = await page.evaluate(
    (db) => window.__store.putPlace(db, { id: "p1", kind: "base" }),
    database,
  );

  expect(written.kind).toBe("ok");
  if (written.kind !== "ok") return;
  expect(written.value.updatedAt).toBe("2026-08-28T06:00:00.000Z");
  expect(written.value.revision).toBe(1);
  expect(written.value.schemaVersion).toBe(SCHEMA_VERSION);
});

test("revision advances on every write", async ({ page }) => {
  const database = freshDatabase();
  await openStore(page, database);

  const revisions = await page.evaluate(async (db) => {
    const out: number[] = [];
    for (const name of ["first", "second", "third"]) {
      const result = await window.__store.putPlace(db, { id: "p1", kind: "base", name });
      if (result.kind === "ok") out.push(result.value.revision);
    }
    return out;
  }, database);

  expect(revisions).toEqual([1, 2, 3]);
});

test("a place id is stable, not derived from its contents", async ({ page }) => {
  /*
   * SPEC-0009: the id is generated at creation, independent of any save
   * file. Re-importing a base from a changed save must not produce a second
   * record — which is what a content-derived id would do.
   */
  const database = freshDatabase();
  await openStore(page, database);

  const result = await page.evaluate(async (db) => {
    await window.__store.putPlace(db, { id: "p1", kind: "base", name: "Original" });
    await window.__store.putPlace(db, { id: "p1", kind: "base", name: "Renamed" });
    const loaded = await window.__store.load(db);
    return loaded.kind === "ok"
      ? { count: loaded.value.places.length, name: loaded.value.places[0]?.name }
      : null;
  }, database);

  expect(result?.count, "a changed name created a second record").toBe(1);
  expect(result?.name).toBe("Renamed");
});

test("all three kinds are one record type", async ({ page }) => {
  const database = freshDatabase();
  await openStore(page, database);

  const kinds = await page.evaluate(async (db) => {
    for (const kind of ["base", "freighter", "settlement"] as const) {
      await window.__store.putPlace(db, { id: kind, kind });
    }
    const loaded = await window.__store.load(db);
    return loaded.kind === "ok"
      ? loaded.value.places.map((place) => place.kind).sort()
      : [];
  }, database);

  expect(kinds).toEqual(["base", "freighter", "settlement"]);
});

/* ----------------------------------------------------------------------
 * Versioning
 * ------------------------------------------------------------------- */

test("a future workspace version loads nothing and names both versions", async ({
  page,
}) => {
  const database = freshDatabase();
  await openStore(page, database);
  await page.evaluate(
    (db) => window.__store.putPlace(db, { id: "p1", kind: "base" }),
    database,
  );

  const failed = await page.evaluate(async (db) => {
    await window.__store.plant(db, "workspace", "self", {
      schemaVersion: 99,
      ownerId: null,
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    return window.__store.load(db);
  }, database);

  expect(failed.kind).toBe("failed");
  if (failed.kind !== "failed") return;
  expect(failed.code).toBe("UNSUPPORTED_VERSION");
  expect(failed.message).toContain("99");
  expect(failed.message).toContain(String(SCHEMA_VERSION));
});

test("one unreadable place fails the whole load, not just that record", async ({
  page,
}) => {
  /*
   * The case that tempts a partial load. A workspace missing four of
   * eleven bases is indistinguishable to the player from a complete one,
   * and they plan against what is there.
   */
  const database = freshDatabase();
  await openStore(page, database);

  const failed = await page.evaluate(async (db) => {
    await window.__store.putPlace(db, { id: "good", kind: "base" });
    await window.__store.plant(db, "places", null, {
      id: "future",
      kind: "base",
      schemaVersion: 99,
      updatedAt: "2026-08-28T00:00:00.000Z",
      revision: 1,
    });
    return window.__store.load(db);
  }, database);

  expect(failed.kind, "a readable subset was returned").toBe("failed");
  if (failed.kind !== "failed") return;
  expect(failed.code).toBe("UNSUPPORTED_VERSION");
});

test("places without a workspace record are a failure, not an empty store", async ({
  page,
}) => {
  /*
   * The bug this test found on its first run.
   *
   * `load()` treated a missing workspace record as "a device that has never
   * used the store" and returned an empty workspace — dropping every
   * planted place silently. That is worse than the partial load SPEC-0009
   * forbids: it is a total one, reported as success.
   */
  const database = freshDatabase();
  await openStore(page, database);

  const failed = await page.evaluate(async (db) => {
    await window.__store.plant(db, "places", null, {
      id: "orphan",
      kind: "base",
      schemaVersion: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
      revision: 1,
    });
    return window.__store.load(db);
  }, database);

  expect(failed.kind, "places were dropped and the store reported success").toBe(
    "failed",
  );
  if (failed.kind !== "failed") return;
  expect(failed.code).toBe("MALFORMED_RECORD");
});

test("a malformed record is distinguishable from an unsupported version", async ({
  page,
}) => {
  const database = freshDatabase();
  await openStore(page, database);

  const failed = await page.evaluate(async (db) => {
    await window.__store.putPlace(db, { id: "good", kind: "base" });
    await window.__store.plant(db, "places", null, { id: "broken", kind: "base" });
    return window.__store.load(db);
  }, database);

  expect(failed.kind).toBe("failed");
  if (failed.kind !== "failed") return;
  expect(failed.code).toBe("MALFORMED_RECORD");
});

/* ----------------------------------------------------------------------
 * Size bound
 * ------------------------------------------------------------------- */

test("the bound is set from the recorded measurements, with headroom", () => {
  /*
   * SPEC-0009 § Request Body Size Limits requires the value be derived from
   * measurement rather than guessed, and recorded with the sizes it came
   * from. This asserts the relationship rather than the number, so changing
   * the bound without revisiting the measurements fails here.
   */
  expect(MEASURED_PLACE_BYTES.heavy).toBeGreaterThan(
    MEASURED_PLACE_BYTES.everyPartTicked,
  );
  expect(MEASURED_PLACE_BYTES.everyPartTicked).toBeGreaterThan(
    MEASURED_PLACE_BYTES.typical,
  );
  expect(
    MAX_PLACE_BYTES / MEASURED_PLACE_BYTES.heavy,
    "the bound should leave an order of magnitude over the heaviest measured place",
  ).toBeGreaterThan(10);
});

test("an oversized place is refused before it is written", async ({ page }) => {
  const database = freshDatabase();
  await openStore(page, database);

  const result = await page.evaluate(
    async ([db, limit]) => {
      const notes = "x".repeat(Number(limit) + 1000);
      const refused = await window.__store.putPlace(db, {
        id: "huge",
        kind: "base",
        notes,
      });
      const loaded = await window.__store.load(db);
      return {
        refused,
        stored: loaded.kind === "ok" ? loaded.value.places.length : -1,
      };
    },
    [database, String(MAX_PLACE_BYTES)] as const,
  );

  expect(result.refused.kind).toBe("failed");
  if (result.refused.kind !== "failed") return;
  expect(result.refused.code).toBe("PLACE_TOO_LARGE");
  expect(result.stored, "the oversized place was written anyway").toBe(0);
});

test("a place at the heaviest measured size is comfortably accepted", async ({
  page,
}) => {
  /*
   * The companion. A bound that refused real data would pass the test above
   * and make the store unusable.
   */
  const database = freshDatabase();
  await openStore(page, database);

  const result = await page.evaluate(
    async ([db, size]) => {
      const notes = "x".repeat(Number(size));
      return window.__store.putPlace(db, { id: "heavy", kind: "base", notes });
    },
    [database, String(MEASURED_PLACE_BYTES.heavy)] as const,
  );

  expect(result.kind).toBe("ok");
});

/* ----------------------------------------------------------------------
 * Transactions and connection lifecycle
 * ------------------------------------------------------------------- */

test("a place and the workspace move together", async ({ page }) => {
  const database = freshDatabase();
  await openStore(page, database, "2026-08-28T07:00:00.000Z");

  const after = await page.evaluate(async (db) => {
    await window.__store.putPlace(db, { id: "p1", kind: "base" });
    const loaded = await window.__store.load(db);
    return loaded.kind === "ok"
      ? {
          places: loaded.value.places.length,
          workspaceUpdatedAt: loaded.value.workspace.updatedAt,
        }
      : null;
  }, database);

  expect(after?.places).toBe(1);
  expect(after?.workspaceUpdatedAt).toBe("2026-08-28T07:00:00.000Z");
});

test("a write that fails partway leaves the store as it was", async ({ page }) => {
  /*
   * A place with no id violates the object store's keyPath, which throws
   * inside the transaction and aborts it. The assertion is that the
   * workspace's timestamp did not move either — if the two were separate
   * transactions, it would have.
   */
  const database = freshDatabase();
  await openStore(page, database, "2026-08-28T07:00:00.000Z");

  const state = await page.evaluate(async (db) => {
    await window.__store.putPlace(db, { id: "p1", kind: "base" });
    const before = await window.__store.load(db);

    const broken = await window.__store.putPlace(db, { kind: "base" } as unknown as {
      id: string;
      kind: "base";
    });

    const after = await window.__store.load(db);
    return {
      broken,
      beforeCount: before.kind === "ok" ? before.value.places.length : -1,
      afterCount: after.kind === "ok" ? after.value.places.length : -1,
      beforeStamp: before.kind === "ok" ? before.value.workspace.updatedAt : "",
      afterStamp: after.kind === "ok" ? after.value.workspace.updatedAt : "",
    };
  }, database);

  expect(state.broken.kind).toBe("failed");
  expect(state.afterCount, "the failed write changed the place set").toBe(
    state.beforeCount,
  );
  expect(state.afterStamp, "the failed write moved the workspace timestamp").toBe(
    state.beforeStamp,
  );
});

test("another tab's upgrade is not blocked by this connection", async ({ page }) => {
  /*
   * The failure SPEC-0009 names because its symptom points nowhere near its
   * cause: an unhandled versionchange leaves the other tab's open pending
   * forever, and the application presents as hanging on load rather than as
   * a storage error.
   */
  const database = freshDatabase();
  await openStore(page, database);

  const outcome = await page.evaluate((db) => window.__store.upgrade(db, 2), database);
  expect(outcome, "the open connection blocked the upgrade").toBe("upgraded");
});

/* ----------------------------------------------------------------------
 * Errors and deletion
 * ------------------------------------------------------------------- */

test("a quota failure reaches the caller as the quota sentinel", async ({ page }) => {
  /*
   * Tested through the pure classifier rather than by filling a disk.
   * Provoking a real quota exhaustion is not a test anyone runs twice, and
   * the question worth answering — does QuotaExceededError arrive as
   * QUOTA_EXCEEDED rather than UNCLASSIFIED — is answerable here.
   *
   * The end-to-end path is asserted by the size bound above, which SPEC-0009
   * requires precisely so a quota failure is not how a player finds out.
   */
  const codes = await page.evaluate(() =>
    [
      "QuotaExceededError",
      "InvalidStateError",
      "SecurityError",
      "NotFoundError",
      "TypeError",
    ].map((name) => window.__store.classify(name)),
  );

  expect(codes).toEqual([
    "QUOTA_EXCEEDED",
    "STORAGE_UNAVAILABLE",
    "STORAGE_UNAVAILABLE",
    "RECORD_NOT_FOUND",
    "UNCLASSIFIED",
  ]);
});

test("operations on an unopened store fail rather than throwing", async ({ page }) => {
  const failed = await page.evaluate(() => window.__store.load("never-opened"));
  expect(failed.kind).toBe("failed");
  if (failed.kind !== "failed") return;
  expect(failed.code).toBe("STORAGE_UNAVAILABLE");
});

test("deletion removes everything and leaves the designed empty state", async ({
  page,
}) => {
  const database = freshDatabase();
  await openStore(page, database);

  const after = await page.evaluate(async (db) => {
    await window.__store.putPlace(db, { id: "p1", kind: "base" });
    await window.__store.putPlace(db, { id: "p2", kind: "freighter" });
    await window.__store.putPreferences(db, { groupSeparator: "," });

    const deleted = await window.__store.deleteAll(db);
    const loaded = await window.__store.load(db);
    return {
      deleted,
      loaded,
      places: loaded.kind === "ok" ? loaded.value.places.length : -1,
    };
  }, database);

  expect(after.deleted.kind).toBe("ok");
  expect(after.loaded.kind, "deletion left the store in an error state").toBe("ok");
  expect(after.places).toBe(0);
});

/*
 * SPEC-0011 REQ "An Assignment Naming an Absent Place Is Unassigned":
 * WHEN three leaves are assigned to a place and that place is deleted
 * THEN the plan survives, the three leaves appear in the unassigned group,
 * and no dangling identifier is rendered.
 *
 * The store's half is the first clause: removing one place leaves the rest
 * of the workspace exactly as it was. The second clause is the view's and is
 * asserted in tests/canvas/assignment.spec.ts, where the assignment lives.
 */
test("deleting one place leaves the others and the workspace intact", async ({
  page,
}) => {
  const database = freshDatabase();
  await openStore(page, database);

  const after = await page.evaluate(async (db) => {
    await window.__store.putPlace(db, { id: "keep-1", kind: "base", name: "Alpha" });
    await window.__store.putPlace(db, { id: "gone", kind: "base", name: "Beta" });
    await window.__store.putPlace(db, { id: "keep-2", kind: "freighter" });
    await window.__store.putPreferences(db, { groupSeparator: "," });

    const deleted = await window.__store.deletePlace(db, "gone");
    const loaded = await window.__store.load(db);
    return {
      deleted,
      ids: loaded.kind === "ok" ? loaded.value.places.map((place) => place.id) : [],
      separator:
        loaded.kind === "ok"
          ? loaded.value.workspace.preferences?.["groupSeparator"]
          : null,
    };
  }, database);

  expect(after.deleted.kind).toBe("ok");
  expect(after.ids.toSorted()).toEqual(["keep-1", "keep-2"]);
  // The workspace record survives with it: deleting a place is not a reset.
  expect(after.separator).toBe(",");
});

test("deleting a place that is not there succeeds", async ({ page }) => {
  const database = freshDatabase();
  await openStore(page, database);

  /*
   * The caller asked for a state and that state already holds. Reporting a
   * failure would make a double click an error, and would make deletion the
   * one operation a player has to get right first time.
   */
  const deleted = await page.evaluate(
    (db) => window.__store.deletePlace(db, "never-existed"),
    database,
  );
  expect(deleted.kind).toBe("ok");
});

/*
 * SPEC-0011 REQ "A Place Is Creatable by Hand":
 * WHEN a place is created with a name and nothing else
 * THEN it persists across a reload.
 *
 * The store's half of "a name is the whole minimum": every other field is
 * optional, so a record carrying only an id, a kind and a name is a complete
 * place rather than a partial one.
 */
test("a place with only a name persists across a reload", async ({ page }) => {
  const database = freshDatabase();
  await openStore(page, database);

  await page.evaluate(
    (db) => window.__store.putPlace(db, { id: "named", kind: "base", name: "Alpha" }),
    database,
  );
  await page.evaluate((db) => {
    window.__store.close(db);
  }, database);

  await page.reload({ waitUntil: "load" });
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await openStore(page, database);

  const loaded = await page.evaluate((db) => window.__store.load(db), database);
  expect(loaded.kind).toBe("ok");
  if (loaded.kind !== "ok") return;

  const place = loaded.value.places[0];
  expect(place?.name).toBe("Alpha");
  expect(place?.id).toBe("named");
  // Nothing was invented to fill the fields the player did not supply.
  expect(place?.notes).toBeUndefined();
  expect(place?.tags).toBeUndefined();
  expect(place?.ticks).toBeUndefined();
  expect(place?.stocked).toBeUndefined();
});

test("preferences round-trip without becoming place records", async ({ page }) => {
  const database = freshDatabase();
  await openStore(page, database);

  const result = await page.evaluate(async (db) => {
    await window.__store.putPreferences(db, {
      groupSeparator: ",",
      showUnverified: true,
    });
    const loaded = await window.__store.load(db);
    return loaded.kind === "ok"
      ? {
          preferences: loaded.value.workspace.preferences,
          places: loaded.value.places.length,
        }
      : null;
  }, database);

  expect(result?.preferences).toEqual({ groupSeparator: ",", showUnverified: true });
  expect(result?.places, "preferences created a place record").toBe(0);
});
