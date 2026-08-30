import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/*
 * Governing: ADR-0010 (places are authored first, and a plan assigns leaves
 * to places that exist), SPEC-0011 REQ "A Place Is Creatable by Hand", REQ
 * "A Place Is Authored, and a Plan References It", SPEC-0009 REQ "A Place Is
 * One Record Type, Whatever Its Kind"
 *
 * Against the real application at "/", not a fixture. The requirement is
 * that "the bases surface MUST provide a route to create a place without a
 * save file" — a route that exists only in a harness is not a route, and
 * this is the one story where the shipped page is the claim.
 *
 * The identity assertion is made against IndexedDB rather than against the
 * screen. "No second identifier for a place exists anywhere in the store or
 * the domain" is checkable by reading the schema, and reading it is what
 * distinguishes a record whose id the plan uses from one carrying a plan-
 * scoped key beside it.
 */

const DATABASE = "nms-planner";

/** Every place record on disk, read past the application. */
async function storedPlaces(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    (database) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const opening = indexedDB.open(database);
        opening.onsuccess = () => {
          const db = opening.result;
          if (!db.objectStoreNames.contains("places")) {
            db.close();
            resolve([]);
            return;
          }
          const transaction = db.transaction(["places"], "readonly");
          const all = transaction.objectStore("places").getAll();
          transaction.oncomplete = () => {
            db.close();
            resolve(all.result as Record<string, unknown>[]);
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? new Error("read failed"));
          };
        };
        opening.onerror = () => {
          reject(opening.error ?? new Error("open failed"));
        };
      }),
    DATABASE,
  );
}

async function createPlace(page: Page, name: string): Promise<void> {
  await page.getByLabel("New place").fill(name);
  await page.getByRole("button", { name: "Create place" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // A clean workspace per test: the store is shared across the origin.
  await page.evaluate(
    (database) =>
      new Promise<void>((resolve) => {
        const deleting = indexedDB.deleteDatabase(database);
        deleting.onsuccess = () => {
          resolve();
        };
        deleting.onerror = () => {
          resolve();
        };
        deleting.onblocked = () => {
          resolve();
        };
      }),
    DATABASE,
  );
  await page.reload({ waitUntil: "load" });
});

/*
 * SPEC-0011 REQ "A Place Is Creatable by Hand":
 * WHEN a place is created with a name and nothing else
 * THEN it persists across a reload and a plan can assign a leaf to it.
 */
test("a name is the whole minimum, and it survives a reload", async ({ page }) => {
  await createPlace(page, "Aurora Flats");

  await page.reload({ waitUntil: "load" });
  await expect(page.getByText("Aurora Flats", { exact: true })).toBeVisible();

  const records = await storedPlaces(page);
  expect(records).toHaveLength(1);
  expect(records[0]?.["name"]).toBe("Aurora Flats");
  /*
   * Nothing else was asked for and nothing else was invented. A kind is
   * written because SPEC-0009 makes it part of the record; a site
   * configuration is not, which is what makes the place assignable while
   * unconfigured.
   */
  expect(records[0]?.["kind"]).toBe("base");
  expect(records[0]?.["notes"]).toBeUndefined();
  expect(records[0]?.["tags"]).toBeUndefined();
});

/*
 * SPEC-0011 REQ "A Place Is Authored, and a Plan References It":
 * "The application MUST NOT mint a second identifier for a place."
 *
 * Read from the schema rather than inferred from behaviour: a second
 * identifier would be a field beside `id`, and the assertion is that the
 * record carries exactly the fields SPEC-0009 defines and no key that looks
 * like a plan-scoped alias.
 */
test("a place record carries one identifier and no alias for it", async ({ page }) => {
  await createPlace(page, "Aurora Flats");

  const records = await storedPlaces(page);
  const record = records[0];
  expect(record).toBeDefined();
  if (!record) return;

  expect(typeof record["id"]).toBe("string");
  expect(String(record["id"])).not.toBe("");

  const identifierish = Object.keys(record).filter(
    (key) => key !== "id" && /(^|[a-z])(id|Id|ID|key|Key|slug|Slug)$/.test(key),
  );
  expect(
    identifierish,
    `a second identifier appeared: ${identifierish.join(", ")}`,
  ).toHaveLength(0);
});

test("two places created in one session get different ids", async ({ page }) => {
  await createPlace(page, "Aurora Flats");
  await createPlace(page, "Cinder Reach");

  const ids = (await storedPlaces(page)).map((record) => record["id"]);
  expect(new Set(ids).size).toBe(2);
});

/*
 * SPEC-0011 REQ "A Place Is Authored, and a Plan References It":
 * "The application MUST NOT ... derive a place's identity from a plan's
 * assignments." The same argument rules out deriving it from the name, and
 * that is the derivation actually within reach here — a slug of the name is
 * the obvious shortcut and it reads correctly until one of these two cases.
 *
 * Two places with the same name are two places. A name-derived id makes
 * them one: the second write lands on the first record's key and overwrites
 * it, so the player creates a place and watches another disappear.
 */
/*
 * The form is one element, not one per store state.
 *
 * `StoredPlaces` renders an empty state and a populated state. Rendering the
 * create form inside each branch put it at a different child position in
 * each, and React reconciles a fragment's children by position — so creating
 * the *first* place moved the form from index 1 to index 0 and remounted it,
 * discarding the name in its `useState`.
 *
 * That is the first-run path, every time: type the first place, submit,
 * start typing the second, and lose it the moment the write settles. The
 * button then sits disabled on an empty field with nothing to say why.
 *
 * Asserted on element identity rather than on the typed text, because the
 * text can be lost for other reasons and a remount is the specific fault:
 * a form that survives cannot have been remounted, and one that does not
 * cannot have kept its state.
 */
test("the create form is not remounted when the first place appears", async ({
  page,
}) => {
  const field = page.getByLabel("New place");

  await field.evaluate((element) => {
    (element as HTMLElement & { dataset: DOMStringMap }).dataset["probe"] = "first";
  });

  await createPlace(page, "Aurora Flats");

  await expect(
    field,
    "the create form was remounted, so anything typed into it was discarded",
  ).toHaveAttribute("data-probe", "first");
});

test("two places with the same name are two places", async ({ page }) => {
  await page.getByLabel("New place").fill("Aurora Flats");
  await page.getByRole("button", { name: "Create place" }).click();
  await page.getByLabel("New place").fill("Aurora Flats");
  await page.getByRole("button", { name: "Create place" }).click();

  await expect(page.getByText("Aurora Flats", { exact: true })).toHaveCount(2);

  const records = await storedPlaces(page);
  expect(records, "the second place overwrote the first").toHaveLength(2);
  expect(new Set(records.map((record) => record["id"])).size).toBe(2);
});

/*
 * And the id carries no trace of the name, because a rename must not change
 * it. An id derived from the name changes when the player renames the
 * place, which silently reassigns every leaf that pointed at it — the exact
 * fragmentation ADR-0010 rejected the side-table for.
 */
test("a place id is not derived from its name", async ({ page }) => {
  await createPlace(page, "Aurora Flats");

  const id = String((await storedPlaces(page))[0]?.["id"]);
  expect(id.toLowerCase()).not.toContain("aurora");
  expect(id.toLowerCase()).not.toContain("flats");
});

/*
 * SPEC-0011 REQ "An Assignment Naming an Absent Place Is Unassigned":
 * deleting a place removes the record and nothing else. The plan is the
 * expensive artifact and it is not the store's to edit.
 */
test("deleting a place removes it and leaves the workspace usable", async ({ page }) => {
  await createPlace(page, "Aurora Flats");
  await createPlace(page, "Cinder Reach");

  await page.getByRole("button", { name: "Delete Aurora Flats" }).click();

  await expect(page.getByText("Aurora Flats", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Cinder Reach", { exact: true })).toBeVisible();

  const names = (await storedPlaces(page)).map((record) => record["name"]);
  expect(names).toEqual(["Cinder Reach"]);
});

test("an empty name creates nothing", async ({ page }) => {
  await page.getByLabel("New place").fill("   ");
  await expect(page.getByRole("button", { name: "Create place" })).toBeDisabled();
  expect(await storedPlaces(page)).toHaveLength(0);
});

/*
 * SPEC-0011 Accessibility Requirements, and SPEC-0005's baseline: the route
 * has to be operable without a pointing device, since it is the only way to
 * bring a place into existence.
 */
test("a place is creatable with the keyboard alone", async ({ page }) => {
  await page.getByLabel("New place").focus();
  await page.keyboard.type("Keyboard Only");
  await page.keyboard.press("Enter");

  await expect(page.getByText("Keyboard Only", { exact: true })).toBeVisible();
  expect((await storedPlaces(page)).map((record) => record["name"])).toEqual([
    "Keyboard Only",
  ]);
});

test("the places panel has no accessibility violations", async ({ page }) => {
  await createPlace(page, "Aurora Flats");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations).toEqual([]);
});
