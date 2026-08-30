/*
 * Reaching a surface in the shell.
 *
 * Governing: SPEC-0011 REQ "The Shell Opens on Bases and Renders Without
 * the Domain", REQ "Surfaces Are Shell View State"
 *
 * The entry surface is bases, so a test that wants the plan form has to
 * switch first. This exists so that fact lives in one place: when the
 * surface set changes again, the suite follows from here rather than from
 * ten separate `goto` calls.
 */

import { expect, type Page } from "@playwright/test";

export async function openSurface(page: Page, name: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Surfaces" })
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
}

/** The surface carrying the target control, the figures and the canvas. */
export async function openPlanner(page: Page): Promise<void> {
  await openSurface(page, "Planner");
}
