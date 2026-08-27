import { expect, test, type Page, type Request } from "@playwright/test";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Module Loading"
 *
 * "WHEN the application first paints THEN the shell is interactive and the
 * WASM module has not been fetched", verified by network timing rather than
 * by inspection.
 *
 * Inspection is what makes this rule rot. A source that has no top-level
 * import of the module today acquires one through a barrel file next month,
 * and every reviewer reads the import list rather than the request waterfall.
 * So this watches the requests and compares their timestamps against the
 * browser's own first-contentful-paint entry.
 */

const FIXTURE = "/tests/fixtures/boundary.html";

/** The three files the boundary fetches, and nothing else. */
const MODULE_ASSETS = ["planner.wasm", "wasm_exec.js", "tier1.json"];

function isModuleAsset(request: Request): boolean {
  return MODULE_ASSETS.some((name) => request.url().includes(name));
}

interface Timed {
  readonly name: string;
  readonly at: number;
}

function recordModuleRequests(page: Page): Timed[] {
  const seen: Timed[] = [];
  page.on("request", (request) => {
    if (isModuleAsset(request)) {
      seen.push({
        name: request.url().split("/").pop() ?? request.url(),
        at: Date.now(),
      });
    }
  });
  return seen;
}

/** Absolute epoch milliseconds of first contentful paint, from the page. */
async function firstContentfulPaint(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const read = (): number | null => {
      const entry = performance.getEntriesByName("first-contentful-paint")[0];
      return entry ? performance.timeOrigin + entry.startTime : null;
    };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const at = read();
      if (at !== null) return at;
      await new Promise((resume) => setTimeout(resume, 20));
    }
    throw new Error("the page never reported a first contentful paint");
  });
}

test("nothing the module needs is fetched before first paint", async ({ page }) => {
  const requests = recordModuleRequests(page);

  await page.goto(FIXTURE, { waitUntil: "load" });
  await expect(page.locator("body")).toHaveAttribute("data-painted", "true");
  const paintedAt = await firstContentfulPaint(page);

  expect(
    requests.map((request) => request.name),
    "the module was fetched during first paint",
  ).toEqual([]);

  /* Belt and braces: nothing fetched later slipped in before the paint. */
  for (const request of requests) {
    expect(
      request.at,
      `${request.name} was requested before first paint`,
    ).toBeGreaterThan(paintedAt);
  }
});

test("the shell is interactive while nothing has been loaded", async ({ page }) => {
  await page.goto(FIXTURE);

  const counter = page.locator("#counter");
  await counter.click();
  await counter.click();
  await expect(counter).toHaveText("clicked 2");

  const readiness = await page.evaluate(() => window.__boundary.peek());
  expect(readiness.kind).toBe("not-started");
});

test("the module is fetched only once asked for, and after the paint", async ({
  page,
}) => {
  const requests = recordModuleRequests(page);

  await page.goto(FIXTURE, { waitUntil: "load" });
  const paintedAt = await firstContentfulPaint(page);
  expect(requests).toEqual([]);

  await page.evaluate(() => window.__boundary.start());

  const names = requests.map((request) => request.name).sort();
  expect(names).toEqual([...MODULE_ASSETS].sort());
  for (const request of requests) {
    expect(request.at, `${request.name} arrived before the paint`).toBeGreaterThan(
      paintedAt,
    );
  }

  const readiness = await page.evaluate(() => window.__boundary.peek());
  expect(readiness.kind).toBe("ready");
});

test("two callers share one load", async ({ page }) => {
  const requests = recordModuleRequests(page);
  await page.goto(FIXTURE, { waitUntil: "load" });

  await page.evaluate(async () => {
    await Promise.all([
      window.__boundary.start(),
      window.__boundary.start(),
      window.__boundary.start(),
    ]);
  });

  const wasm = requests.filter((request) => request.name === "planner.wasm");
  expect(wasm, "the binary was fetched more than once").toHaveLength(1);
});
