import { expect, test, type Page, type Request } from "@playwright/test";

import { openPlanner } from "../helpers/surfaces";

/*
 * Governing: ADR-0001 (two-tier ingestion — Tier 2 is hand-maintained),
 * ADR-0004 (React view layer), SPEC-0005 REQ "Module Loading", SPEC-0006
 * REQ "Leaf Assignment to Bases"
 *
 * The shipped application's end of the curated set.
 *
 * tests/boundary/curated.spec.ts proves the file loads and the engine takes
 * it. This proves the application is the thing that asks for it — which is
 * the whole of what was missing: both consumers took `Curated` as a prop
 * from a caller that did not exist, so the code paths were complete and
 * inert.
 */

const TIER2 = "**/tier2.json";

function recordCuratedRequests(page: Page): { at: number }[] {
  const seen: { at: number }[] = [];
  page.on("request", (request: Request) => {
    if (request.url().includes("tier2.json")) seen.push({ at: Date.now() });
  });
  return seen;
}

test("the application asks for the curated set, and asks once", async ({ page }) => {
  const requests = recordCuratedRequests(page);

  await page.goto("/", { waitUntil: "load" });

  await expect
    .poll(() => requests.length, {
      message: "the application never fetched the curated set",
    })
    .toBeGreaterThan(0);

  /*
   * Once. The file does not change while the page is open, and a fetch per
   * consumer is two places for one set of constants to disagree with
   * itself — which is why the shell owns it rather than the hooks that need
   * it. Switching surfaces is the cheapest way to make a second fetch show
   * up if one is going to.
   */
  await openPlanner(page);
  expect(requests).toHaveLength(1);
});

test("the entry surface is complete with the curated set never arriving", async ({
  page,
}) => {
  /*
   * The load is an effect, so it cannot block the first render — but "does
   * not block" is a claim about behaviour, and this is the behaviour.
   * SPEC-0011 REQ "The Shell Opens on Bases and Renders Without the Domain"
   * requires the entry surface to be complete "with no error and no loading
   * state standing in for its content", and the curated set is domain data
   * the bases surface has no use for.
   */
  await page.route(TIER2, (route) => route.abort());
  await page.goto("/", { waitUntil: "load" });

  const bases = page.getByRole("region", { name: "Bases", exact: true });
  await expect(bases).toBeVisible();
  await expect(bases.getByText(/CONSTANTS_/)).toHaveCount(0);

  await page.getByLabel("New place").fill("Cobalt Flats");
  await page.getByRole("button", { name: "Create place" }).click();
  await expect(page.getByText("Cobalt Flats", { exact: true })).toBeVisible();
});

test("a curated set that does not arrive is reported as a fetch failure", async ({
  page,
}) => {
  await page.route(TIER2, (route) => route.fulfill({ status: 503, body: "" }));
  await page.goto("/", { waitUntil: "load" });
  await openPlanner(page);

  await expect(page.getByText("CONSTANTS_FETCH_FAILED")).toBeVisible();
});

test("a curated set that will not parse is reported as an editing problem", async ({
  page,
}) => {
  /*
   * The distinction the two codes exist for. Tier 2 is hand-maintained, so
   * a bad edit is the expected failure and "the planner could not be
   * loaded" would send someone looking at the wrong thing entirely.
   */
  await page.route(TIER2, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"constants":{"biodomeCropSlots":{"value":"0"}}}',
    }),
  );
  await page.goto("/", { waitUntil: "load" });
  await openPlanner(page);

  await expect(page.getByText("CONSTANTS_INVALID")).toBeVisible();
});

test("the planner surface is silent about the curated set when it loads", async ({
  page,
}) => {
  /*
   * The badge is for a failure, not for the loading window. A curated set
   * that is merely still in flight has nothing to say: the figures it feeds
   * already present their own pending state, and a second one beside them
   * would be noise on every cold load.
   */
  await page.goto("/", { waitUntil: "load" });
  await openPlanner(page);

  await expect(page.getByText(/CONSTANTS_/)).toHaveCount(0);
});
