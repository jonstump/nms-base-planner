import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { durabilityClaims, sharingControls } from "../helpers/claim-checks";
import type { PlaceRecord } from "../../src/store";

/*
 * Governing: ADR-0008 (durable user data), SPEC-0009 REQ "Deletion Is a
 * First-Class Operation", REQ "Storage Is Evictable and the Application
 * Must Not Imply Otherwise", REQ "Screenshots Are Local-Only"
 *
 * Three requirements about custody rather than storage: what the player is
 * told about their data, and what they can do about it.
 *
 * Against the real application at "/", because two of the three are claims
 * about what reaches the player. A fixture could satisfy them while the
 * shipped page said something else.
 */

const DATABASE = "nms-planner";

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

/** What is actually on disk, read past the application. */
async function storedCounts(page: Page): Promise<{ places: number; workspace: number }> {
  return page.evaluate(
    (database) =>
      new Promise<{ places: number; workspace: number }>((resolve, reject) => {
        const opening = indexedDB.open(database);
        opening.onsuccess = () => {
          const db = opening.result;
          if (!db.objectStoreNames.contains("places")) {
            db.close();
            resolve({ places: 0, workspace: 0 });
            return;
          }
          const transaction = db.transaction(["places", "workspace"], "readonly");
          const places = transaction.objectStore("places").count();
          const workspace = transaction.objectStore("workspace").count();
          transaction.oncomplete = () => {
            db.close();
            resolve({ places: places.result, workspace: workspace.result });
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? new Error("count failed"));
          };
        };
        opening.onerror = () => {
          reject(opening.error ?? new Error("count open failed"));
        };
      }),
    DATABASE,
  );
}

/**
 * Wait until a preference change has actually reached the store.
 *
 * Polls the record rather than the `data-saving` attribute. That attribute
 * reads "false" before the write effect runs as well as after it settles,
 * so a wait on it can be satisfied by the state preceding the write — which
 * is how the same helper in stored-preferences.spec.ts passed locally and
 * failed twice in CI.
 */
async function preferencePersisted(
  page: Page,
  expected: Record<string, unknown>,
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
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
                  const record = got.result as {
                    preferences?: Record<string, unknown>;
                  };
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
        ),
      { timeout: 10_000 },
    )
    .toMatchObject(expected);
}

const AURORA: PlaceRecord = {
  id: "aurora",
  kind: "base",
  schemaVersion: 1,
  name: "Aurora Flats",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 1,
};

async function withStoredPlace(page: Page): Promise<void> {
  await page.goto("/");
  await plant(page, [AURORA]);
  await page.reload();
  await expect(page.getByText("Aurora Flats")).toBeVisible();
}

/* ----------------------------------------------------------------------
 * The checkers, against text they must and must not catch
 * ------------------------------------------------------------------- */

test("the claim checker catches the claims the storage cannot make", () => {
  expect(durabilityClaims("Your bases are backed up.")).toHaveLength(1);
  expect(durabilityClaims("Changes are synced across your devices.")).toHaveLength(1);
  expect(durabilityClaims("Saved to the cloud")).toHaveLength(1);
  expect(durabilityClaims("You'll never lose your progress")).toHaveLength(1);
  expect(durabilityClaims("Stored safely on our servers")).toHaveLength(1);
  expect(durabilityClaims("Your data is always available")).toHaveLength(1);
});

test("the claim checker leaves accurate wording alone", () => {
  /*
   * The companion. A checker that matched everything would satisfy every
   * assertion above and force the interface into silence.
   *
   * "Saved" is deliberately allowed. It is the ordinary word for what
   * happened, and banning it would push the copy toward circumlocution,
   * which reads as evasive rather than as honest. What is banned is the
   * claim that the data is somewhere else as well, or that it cannot be
   * lost.
   */
  expect(durabilityClaims("Kept on this device, in this browser.")).toEqual([]);
  expect(durabilityClaims("Saved on this device.")).toEqual([]);
  expect(
    durabilityClaims(
      "Clearing site data removes it, and a browser short of space can remove it on its own.",
    ),
  ).toEqual([]);
});

test("the sharing checker separates handing over a file from transmitting it", () => {
  expect(sharingControls(["Share screenshot"])).toHaveLength(1);
  expect(sharingControls(["Upload image"])).toHaveLength(1);
  expect(sharingControls(["Copy link to this base"])).toHaveLength(1);
  expect(sharingControls(["Publish"])).toHaveLength(1);

  /*
   * Neither of these transmits anything. ADR-0013 is owed a decision about
   * sharing images; handing the player their own file is not that.
   */
  expect(sharingControls(["Export as JSON", "Download", "Delete stored data"])).toEqual(
    [],
  );
});

/* ----------------------------------------------------------------------
 * The application
 * ------------------------------------------------------------------- */

test("nothing on the page claims the data is backed up or synchronized", async ({
  page,
}) => {
  await withStoredPlace(page);

  const text = await page.locator("body").innerText();
  expect(
    text.length,
    "the page rendered nothing, so nothing was checked",
  ).toBeGreaterThan(50);
  expect(durabilityClaims(text), "the page overpromises").toEqual([]);
});

test("the page is accurate about the scope, rather than merely silent", async ({
  page,
}) => {
  /*
   * The requirement is that where the application indicates data is stored,
   * the indication is accurate about its scope. A page that said nothing at
   * all would pass the check above and leave the player with no idea their
   * data is one cache clear from gone.
   */
  await page.goto("/");
  const custody = page.getByRole("region", { name: "Your data" });
  await expect(custody).toContainText(/this device/i);
  await expect(custody).toContainText(/remove/i);
});

test("no control anywhere would share or upload", async ({ page }) => {
  await withStoredPlace(page);

  const names = await page
    .getByRole("button")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  const links = await page
    .getByRole("link")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));

  expect(names.length, "no controls were found, so nothing was checked").toBeGreaterThan(
    0,
  );
  expect(sharingControls([...names, ...links])).toEqual([]);
});

test("deletion is reachable without developer tools", async ({ page }) => {
  await withStoredPlace(page);
  await expect(page.getByRole("button", { name: "Delete stored data" })).toBeVisible();
});

test("deletion is confirmed before anything is removed", async ({ page }) => {
  await withStoredPlace(page);

  await page.getByRole("button", { name: "Delete stored data" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  /*
   * The half that matters. A confirmation that has already deleted by the
   * time it asks is not a confirmation.
   */
  expect(await storedCounts(page)).toEqual({ places: 1, workspace: 1 });
  await expect(page.getByText("Aurora Flats")).toBeVisible();
});

test("dismissing the confirmation removes nothing", async ({ page }) => {
  await withStoredPlace(page);

  await page.getByRole("button", { name: "Delete stored data" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await storedCounts(page)).toEqual({ places: 1, workspace: 1 });
});

test("confirming removes the workspace and every place, and leaves the empty state", async ({
  page,
}) => {
  await withStoredPlace(page);

  await page.getByRole("button", { name: "Delete stored data" }).click();
  await page.getByRole("button", { name: "Delete everything" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);

  const saved = page.getByRole("region", { name: "Saved places" });
  await expect(saved.getByText(/Nothing saved on this device yet/)).toBeVisible();

  /*
   * The designed empty state, not an error state. Deleting your data is a
   * thing you chose, not a fault.
   */
  await expect(saved.getByText(/could not|failed|error|unavailable/i)).toHaveCount(0);

  await expect
    .poll(async () => storedCounts(page), { timeout: 5000 })
    .toEqual({ places: 0, workspace: 0 });
});

test("deletion does not immediately recreate the workspace it just removed", async ({
  page,
}) => {
  /*
   * Preferences live on the workspace record, so the reset that follows
   * deletion could write a fresh one back one tick later. That would be
   * silent, and the player would have been told their data was gone.
   *
   * A preference is changed away from its default first, and that is the
   * whole test rather than setup. Without it the post-deletion reset is a
   * no-op, the write effect sees no difference, and the test passes against
   * an implementation that has no protection at all — which is exactly what
   * it did until removing the guard failed to turn it red.
   */
  await withStoredPlace(page);
  await page.getByLabel("Group digits").uncheck();
  await preferencePersisted(page, { groupSeparator: "" });
  expect(await storedCounts(page)).toEqual({ places: 1, workspace: 1 });

  await page.getByRole("button", { name: "Delete stored data" }).click();
  await page.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect
    .poll(async () => storedCounts(page), { timeout: 5000 })
    .toEqual({ places: 0, workspace: 0 });

  await page.reload();
  await expect(
    page.getByRole("region", { name: "Saved places" }).getByText(/Nothing saved/),
  ).toBeVisible();
  expect(await storedCounts(page)).toEqual({ places: 0, workspace: 0 });
});

test("the confirmation returns focus to the control that opened it", async ({ page }) => {
  /*
   * Every close route, because that is where this breaks. #82's trap
   * restores in the effect cleanup so all three converge; a bespoke dialog
   * would restore in its Escape handler and leave the other two stranded.
   */
  await withStoredPlace(page);
  const opener = page.getByRole("button", { name: "Delete stored data" });

  for (const close of [
    async () => {
      await page.keyboard.press("Escape");
    },
    async () => {
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    },
  ]) {
    await opener.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await close();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
});

test("the confirmation traps focus while it is open", async ({ page }) => {
  await withStoredPlace(page);
  await page.getByRole("button", { name: "Delete stored data" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    await expect(
      dialog.locator(":focus"),
      "focus left the dialog on tab " + String(i),
    ).toHaveCount(1);
  }
});

test("the data custody surface passes the accessibility audit", async ({ page }) => {
  await withStoredPlace(page);
  await page.getByRole("button", { name: "Delete stored data" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});
