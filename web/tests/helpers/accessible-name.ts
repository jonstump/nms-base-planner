/*
 * Computing the accessible name of a control, in the browser.
 *
 * Governing: SPEC-0005 Accessibility Requirements
 *
 * Runs as a page function rather than in Node: an accessible name comes from
 * `aria-labelledby`, `aria-label`, content, and `title` in that order, and
 * only the document can resolve the second and third.
 *
 * This exists because axe does not catch the case SPEC-0005 actually names.
 * "Icon-only controls MUST carry an aria-label" is about a control whose only
 * content is a glyph — `✕`, `⚠`, `→`. axe's `button-name` rule sees text
 * content there and calls the control named, because by the specification's
 * definition it is. It is named "✕", which a screen reader reads as "multiplication
 * X" or skips entirely, and which tells nobody what the control does.
 *
 * So the rule enforced here is narrower and stricter than the standard: a
 * control whose accessible name contains no letter and no digit is treated as
 * unlabelled.
 */

/** Returned by {@link ICON_ONLY_CONTROL_AUDIT}. */
export interface UnnamedControl {
  readonly tag: string;
  readonly text: string;
  readonly name: string;
  readonly outer: string;
}

/*
 * Serialized as a string and evaluated in the page, so it can be passed to
 * page.evaluate() from any spec without importing browser globals into Node.
 */
export const ICON_ONLY_CONTROL_AUDIT = (): UnnamedControl[] => {
  const SELECTOR = [
    "button",
    "a[href]",
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="switch"]',
  ].join(",");

  const named = (element: Element): string => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (parts.trim()) return parts;
    }

    const label = element.getAttribute("aria-label");
    if (label?.trim()) return label;

    /*
     * Content, minus anything hidden from assistive technology. A glyph
     * marked aria-hidden is correctly excluded here — which is why a badge
     * rendering "✓" hidden plus the word "OK" visible passes, and one
     * rendering only "✓" does not.
     */
    const clone = element.cloneNode(true) as Element;
    clone.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => {
      hidden.remove();
    });
    const content = clone.textContent ?? "";
    if (content.trim()) return content;

    return element.getAttribute("title") ?? "";
  };

  const out: UnnamedControl[] = [];
  document.querySelectorAll(SELECTOR).forEach((element) => {
    /* Deliberately out of the tree; nothing announces it. */
    if (element.getAttribute("aria-hidden") === "true") return;

    const name = named(element).trim();

    /*
     * A name of pure punctuation or symbols is not a name. Letters and
     * digits are what a person can be told; `✕` is not.
     */
    if (/[\p{L}\p{N}]/u.test(name)) return;

    out.push({
      tag: element.tagName.toLowerCase(),
      text: (element.textContent ?? "").trim().slice(0, 20),
      name,
      outer: element.outerHTML.slice(0, 120),
    });
  });
  return out;
};
