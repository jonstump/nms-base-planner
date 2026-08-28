import { defineConfig, devices } from "@playwright/test";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Token Discipline",
 * REQ "Component Styling Discipline"
 *
 * A real browser, not jsdom.
 *
 * Two of the three things this suite has to prove are invisible to a DOM
 * emulator. `filter: brightness()` on :hover needs a real pointer. The
 * selection ring's paint order needs a real compositor — jsdom has no
 * stacking contexts and no pixels, so a jsdom test asserting the ring is
 * "above" the badge would be asserting the test author's belief rather than
 * the browser's behaviour, which is exactly the failure mode SPEC-0005 REQ
 * "Component Styling Discipline" exists to prevent.
 *
 * The dev server is the fixture host. `vite preview` would serve the built
 * app under its CSP, but these tests exercise stylesheets rather than the
 * shipped bundle, and dev serves the CSS sources directly so a failure
 * points at the line that caused it.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    // Screenshots are sampled pixel by pixel in tests/selection-ring.spec.ts.
    // A scale factor other than 1 would put the sampled coordinate somewhere
    // other than the CSS pixel the test computed.
    deviceScaleFactor: 1,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], deviceScaleFactor: 1 } },
  ],
  webServer: {
    // --host is pinned rather than left to vite's default `localhost`, which
    // resolves to ::1 on some machines and 127.0.0.1 on others. Playwright's
    // readiness probe uses the literal URL below, so the two have to agree.
    command: "npm run dev -- --host 127.0.0.1 --port 5174 --strictPort",
    url: "http://127.0.0.1:5174/tests/fixtures/discipline.html",
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
