import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { networkCalls, syncMarkers } from "../helpers/source-checks";

/*
 * Governing: ADR-0008 (durable user data, local-first), SPEC-0009 REQ
 * "Stage 1 Reaches No Network", REQ "Nothing Is Marked for Synchronization"
 *
 * Two requirements that are both absences.
 *
 * `tests/boundary/discipline.spec.ts` established why that needs its own
 * treatment: exercising a path shows that the paths someone thought of
 * behave, and the failure mode is always the path nobody thought of. The
 * same argument, with a second layer — these absences are also checked at
 * runtime, because a request can be issued through a reference no regex can
 * see, and a field can be written under a computed key no source scan reads.
 *
 * The network requirement is checked three ways, and the ordering matters:
 *
 *   1. A quiet page runs every store call path and records no attempt of
 *      any kind. This is the assertion with teeth and it needs no stack.
 *   2. A page with unrelated traffic records that traffic and still
 *      attributes nothing to a store path — the requirement's second
 *      scenario, and the reason the check is phrased against call paths
 *      rather than against the bundle.
 *   3. The source scan, which names the offending line when 1 goes red.
 */

const FIXTURE = "/tests/fixtures/store-discipline.html";
const STORE = path.join(import.meta.dirname, "..", "..", "src", "store");

let counter = 0;
function freshDatabase(): string {
  counter += 1;
  return `discipline-${String(counter)}-${String(Math.floor(performance.now()))}`;
}

/** The one record written, or a failure naming the fact that none was. */
function only(
  records: Record<string, unknown>[],
  label: string,
): Record<string, unknown> {
  const [record] = records;
  if (!record) throw new Error(`no ${label} was written, so nothing was checked`);
  return record;
}

function sourcesIn(directory: string): { file: string; source: string }[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      file: name,
      source: readFileSync(path.join(directory, name), "utf8"),
    }));
}

async function exercise(page: Page, database: string): Promise<string[]> {
  const outcomes = await page.evaluate(
    (db) => window.__discipline.exercise(db),
    database,
  );
  /*
   * Every operation has to have succeeded. A store that failed to open
   * issues no requests either, and would satisfy the network assertion
   * while proving nothing at all.
   */
  for (const outcome of outcomes) {
    expect(outcome, `a store operation failed: ${outcome}`).toMatch(/:ok$/);
  }
  return outcomes;
}

/* ----------------------------------------------------------------------
 * The source half
 * ------------------------------------------------------------------- */

test("the store sources exist and were actually read", () => {
  /*
   * Every scan below is satisfied by an empty directory. This is what
   * separates "nothing is wrong" from "nothing was looked at".
   */
  expect(sourcesIn(STORE).length).toBeGreaterThanOrEqual(5);
});

test("no store source reaches for a network primitive", () => {
  for (const { file, source } of sourcesIn(STORE)) {
    expect(networkCalls(file, source), `store/${file} issues a request`).toEqual([]);
  }
});

test("no store source marks a record for synchronization", () => {
  for (const { file, source } of sourcesIn(STORE)) {
    expect(syncMarkers(file, source), `store/${file} marks a record`).toEqual([]);
  }
});

test("the checks reject source broken on purpose", () => {
  /*
   * A checker that has quietly stopped matching passes every assertion
   * above forever. These are the snippets it exists to catch.
   */
  expect(networkCalls("x.ts", `const r = await fetch("/api/places");`)).toHaveLength(1);
  expect(networkCalls("x.ts", `const x = new XMLHttpRequest();`)).toHaveLength(1);
  expect(networkCalls("x.ts", `const s = new WebSocket("wss://sync");`)).toHaveLength(1);
  expect(networkCalls("x.ts", `const e = new EventSource("/stream");`)).toHaveLength(1);
  expect(networkCalls("x.ts", `navigator.sendBeacon("/telemetry", body);`)).toHaveLength(
    1,
  );
  expect(networkCalls("x.ts", `await axios.post("/places", record);`)).toHaveLength(1);

  expect(syncMarkers("x.ts", `const record = { ...place, synced: true };`)).toHaveLength(
    1,
  );
  expect(syncMarkers("x.ts", `record.pendingUpload = true;`)).toHaveLength(1);
  expect(syncMarkers("x.ts", `return { ...place, isShared: false };`)).toHaveLength(1);
  expect(syncMarkers("x.ts", `const next = { syncState: "dirty" };`)).toHaveLength(1);
});

test("the checks do not fire on legitimate code", () => {
  /*
   * The companion. A checker that matched everything would satisfy every
   * assertion above and make the suite useless.
   */
  expect(networkCalls("x.ts", `const cached = prefetched.get(key);`)).toEqual([]);
  expect(networkCalls("x.ts", `const body = new Request(url);`)).toEqual([]);
  expect(networkCalls("x.ts", `const socket = pipe.connect(target);`)).toEqual([]);

  /*
   * The reserved fields. ADR-0008 reserves `updatedAt` and `revision` for
   * the sync ADR it defers to, and SPEC-0009 requires they be written from
   * version 1 even though nothing reads them — so a checker that read a
   * reserved field as a marked one would be arguing with the schema rather
   * than enforcing it.
   */
  expect(
    syncMarkers("x.ts", `const record = { ...place, updatedAt: now, revision };`),
  ).toEqual([]);
  expect(
    syncMarkers("x.ts", `return { schemaVersion, ownerId: null, updatedAt };`),
  ).toEqual([]);
});

/* ----------------------------------------------------------------------
 * The runtime half
 * ------------------------------------------------------------------- */

test.describe("in a real browser", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE, { waitUntil: "load" });
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    await page.evaluate(() => {
      window.__discipline.reset();
    });
  });

  test("every store call path runs and nothing goes out", async ({ page }) => {
    const outcomes = await exercise(page, freshDatabase());

    /*
     * Named rather than counted, so a refactor that silently stops
     * exercising a path fails here instead of narrowing the test.
     */
    expect(outcomes.map((entry) => entry.split(":")[0])).toEqual([
      "open",
      "load",
      "putPlace",
      "putPreferences",
      "reload",
      "deleteAll",
    ]);

    const attempts = await page.evaluate(() => window.__discipline.attempts());
    expect(attempts, "the store reached the network").toEqual([]);
  });

  test("the recorder is live, and unrelated traffic is not the store's", async ({
    page,
  }) => {
    /*
     * The requirement's second scenario, and the reason the assertion is
     * phrased against call paths. Once ADR-0008 stage 2 ships, the page
     * will contain network code by design; a check that counted every
     * request would have to be weakened then, and would go on reporting a
     * guarantee it had stopped making.
     */
    await page.evaluate(() => window.__discipline.unrelated());

    const afterUnrelated = await page.evaluate(() => window.__discipline.attempts());
    expect(
      afterUnrelated.length,
      "the recorder saw nothing, so it is not wired to anything",
    ).toBeGreaterThan(0);
    expect(
      afterUnrelated.some((attempt) => attempt.fromHarness),
      "no attempt was attributed to the code that made it",
    ).toBe(true);

    await exercise(page, freshDatabase());

    const attempts = await page.evaluate(() => window.__discipline.attempts());
    expect(attempts.filter((attempt) => attempt.fromStore)).toEqual([]);
    expect(
      attempts.length,
      "the unrelated request went missing, so the window is wrong",
    ).toBeGreaterThan(0);
  });

  test("no written record is marked shared, synced, or pending upload", async ({
    page,
  }) => {
    /*
     * Read raw, past the store's own reader. The criterion is about what
     * ends up written: a field set by a code path the source scan did not
     * read is still a field that was set, and a field the store's reader
     * drops on the way out is still on disk.
     */
    const database = freshDatabase();
    const seeded = await page.evaluate((db) => window.__discipline.seed(db), database);
    for (const outcome of seeded) {
      expect(outcome, `seeding failed: ${outcome}`).toMatch(/:ok$/);
    }

    const places = (await page.evaluate(
      (db) => window.__discipline.raw(db, "places"),
      database,
    )) as Record<string, unknown>[];
    const workspaces = (await page.evaluate(
      (db) => window.__discipline.raw(db, "workspace"),
      database,
    )) as Record<string, unknown>[];

    expect(places.length, "nothing was written, so nothing was checked").toBe(1);
    expect(workspaces.length).toBe(1);

    const FORBIDDEN =
      /^(?:isShared|shared|isSynced|synced|syncState|syncedAt|pendingUpload|pendingSync|needsUpload|needsSync|uploadedAt|remoteId|publishedAt)$/;
    for (const record of [...places, ...workspaces]) {
      const marked = Object.keys(record).filter((key) => FORBIDDEN.test(key));
      expect(marked, `a written record carries ${marked.join(", ")}`).toEqual([]);
    }
  });

  test("the fields reserved for later stages are present and unset", async ({ page }) => {
    /*
     * SPEC-0009: "Where the schema carries fields serving stages 2 and 3
     * they MUST be present and unset rather than absent." Absent would make
     * sign-in a migration over records written before the field existed —
     * which is the case ADR-0008 settled ownership early to avoid.
     */
    const database = freshDatabase();
    const seeded = await page.evaluate((db) => window.__discipline.seed(db), database);
    for (const outcome of seeded) {
      expect(outcome, `seeding failed: ${outcome}`).toMatch(/:ok$/);
    }

    const place = only(
      (await page.evaluate(
        (db) => window.__discipline.raw(db, "places"),
        database,
      )) as Record<string, unknown>[],
      "place",
    );
    const workspace = only(
      (await page.evaluate(
        (db) => window.__discipline.raw(db, "workspace"),
        database,
      )) as Record<string, unknown>[],
      "workspace",
    );

    expect(Object.hasOwn(workspace, "ownerId"), "ownerId is absent").toBe(true);
    expect(workspace["ownerId"], "ownerId is set in stage 1").toBeNull();

    expect(Object.hasOwn(place, "updatedAt")).toBe(true);
    expect(Object.hasOwn(place, "revision")).toBe(true);
    expect(place["revision"]).toBe(1);
  });
});
