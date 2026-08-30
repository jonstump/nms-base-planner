import { expect, test, type Page } from "@playwright/test";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Boundary Client",
 * REQ "Module Loading"
 *
 * The branches a healthy module never takes.
 *
 * A module reporting the wrong contract version, an artifact that fails to
 * validate, a binary that will not load, a call arriving before readiness —
 * these are precisely the states SPEC-0005 requires the client to tell apart,
 * and precisely the states the shipped module never enters. So they are
 * driven from tests/fixtures/fake, which publishes the same namespace with a
 * scripted answer.
 *
 * tests/boundary/integration.spec.ts covers the same client against the real
 * module, so nothing here can pass by testing the stand-in rather than the
 * code.
 */

const FIXTURE = "/tests/fixtures/boundary.html";

const FAKE = {
  shim: "/tests/fixtures/fake/shim.js",
  wasm: "/tests/fixtures/fake/empty.wasm",
  artifact: "/tier1.json",
} as const;

interface Failure {
  kind: string;
  code?: string;
  message?: string;
  expected?: string;
  received?: string;
}

/**
 * Make one of the boundary's fetches fail for real.
 *
 * Pointing a path at a file that does not exist does not work: vite's dev
 * server answers any unmatched path with index.html and a 200, so the fetch
 * succeeds and the client is handed a web page. The three "missing file"
 * tests below all passed against that — two of them for the wrong reason,
 * because HTML happens not to be valid WebAssembly either. Aborting the
 * request produces the network failure the code is actually branching on.
 */
async function abortRequestsFor(page: Page, fragment: string): Promise<void> {
  await page.route(
    (url) => url.pathname.includes(fragment),
    async (route) => route.abort("failed"),
  );
}

async function loadFake(
  page: Page,
  script: Record<string, unknown>,
  paths: Record<string, string> = FAKE,
): Promise<Failure> {
  await page.goto(FIXTURE, { waitUntil: "load" });
  return page.evaluate(
    async ([fakeScript, fakePaths]) => {
      Object.assign(window, { __fake: fakeScript });
      const scoped = window.__boundary.withPaths(fakePaths as never);
      await scoped.start();
      const readiness = scoped.peek();
      return readiness.kind === "unavailable"
        ? readiness.outcome
        : { kind: readiness.kind };
    },
    [script, paths] as const,
  );
}

test("a module reporting another contract version is refused, naming both", async ({
  page,
}) => {
  const outcome = await loadFake(page, { contractVersion: "9.9.9" });

  expect(outcome.kind).toBe("version-mismatch");
  expect(outcome.received).toBe("9.9.9");
  expect(outcome.expected).toBe("1.3.0");
});

test("a contract mismatch does not even fetch the artifact", async ({ page }) => {
  /*
   * "does not consume the payload", checked at the strongest reading
   * available: the payload was never requested. A module on another contract
   * may well accept the artifact and answer in a shape this view would
   * misread, so the check has to happen before anything is asked of it.
   */
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("tier1.json")) requested.push(request.url());
  });

  await loadFake(page, { contractVersion: "0.1.0" });
  expect(requested).toEqual([]);
});

test("an artifact that fails to validate is reported as the module's own code", async ({
  page,
}) => {
  const outcome = await loadFake(page, { loadFails: true });

  expect(outcome.kind).toBe("failed");
  expect(outcome.code).toBe("INVALID_ARTIFACT");
});

test("a module that will not load is reported distinctly from a bad artifact", async ({
  page,
}) => {
  /*
   * SPEC-0005 REQ "Module Loading" requires these two to be distinguishable.
   * The pair of assertions is the requirement: not that each has a code, but
   * that the codes differ.
   */
  await abortRequestsFor(page, "empty.wasm");
  const missingBinary = await loadFake(page, {});
  expect(missingBinary.kind).toBe("failed");
  expect(missingBinary.code).toBe("MODULE_LOAD_FAILED");

  await page.unrouteAll();

  const badArtifact = await loadFake(page, { loadFails: true });
  expect(badArtifact.code).toBe("INVALID_ARTIFACT");
  expect(missingBinary.code).not.toBe(badArtifact.code);
});

test("an unreachable shim is a module failure, not an artifact failure", async ({
  page,
}) => {
  await abortRequestsFor(page, "fake/shim.js");
  const outcome = await loadFake(page, {});
  expect(outcome.code).toBe("MODULE_LOAD_FAILED");
});

test("a shim that never publishes the namespace is a module failure", async ({
  page,
}) => {
  const outcome = await loadFake(page, { neverPublish: true });
  expect(outcome.code).toBe("MODULE_LOAD_FAILED");
});

test("an artifact that cannot be fetched is neither of the other two", async ({
  page,
}) => {
  await abortRequestsFor(page, "tier1.json");
  const outcome = await loadFake(page, {});
  expect(outcome.code).toBe("ARTIFACT_FETCH_FAILED");
});

test("a NOT_READY answer is retried once without the caller reissuing", async ({
  page,
}) => {
  /*
   * "WHEN a call is made before the module has loaded its artifact THEN the
   * view presents a loading state rather than a failure, and retries once
   * readiness resolves."
   *
   * One call is made. The stand-in answers NOT_READY the first time and
   * succeeds the second. Nothing in the test reissues it.
   */
  await page.goto(FIXTURE, { waitUntil: "load" });

  const outcome = await page.evaluate(
    async ([paths]) => {
      Object.assign(window, { __fake: { notReadyTimes: 1 } });
      const scoped = window.__boundary.withPaths(paths);
      return (await scoped.resolve({ target: "ANTIMATTER", quantity: "1" })) as {
        kind: string;
      };
    },
    [FAKE] as const,
  );

  expect(outcome.kind).toBe("ok");
});

test("a module that is never ready reports rather than hanging", async ({ page }) => {
  /*
   * The companion to the retry. One retry, not a loop: a module that answers
   * NOT_READY forever has to become a message, and a loop would make it a
   * spinner that never stops.
   */
  await page.goto(FIXTURE, { waitUntil: "load" });

  const outcome = await page.evaluate(
    async ([paths]) => {
      Object.assign(window, { __fake: { notReadyTimes: 99 } });
      const scoped = window.__boundary.withPaths(paths);
      return (await scoped.resolve({ target: "ANTIMATTER", quantity: "1" })) as {
        kind: string;
        code?: string;
      };
    },
    [FAKE] as const,
  );

  expect(outcome.kind).toBe("failed");
  expect(outcome.code).toBe("NOT_READY");
});
