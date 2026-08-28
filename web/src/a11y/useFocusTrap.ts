import { useEffect, useRef, type RefObject } from "react";

/*
 * Focus containment, and the return that is the actual requirement.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 Accessibility
 * Requirements
 *
 * "Popovers and dialogs MUST trap focus while open, move focus to the first
 * focusable element on open, and return focus to the invoking element on
 * close."
 *
 * Issue #62 words the return criterion around *routes* — Escape, backdrop
 * click, the close control — because that is where this breaks in practice.
 * An implementation that restores focus inside its Escape handler works
 * perfectly until someone clicks the backdrop.
 *
 * So the restore does not live in any handler. It lives in the effect's
 * cleanup, which React runs when `open` goes false and when the component
 * unmounts, whatever caused either. Every route converges on the same line,
 * and a fourth route added next year gets the behaviour without knowing this
 * file exists. That is the whole design.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

export interface FocusTrapOptions {
  /** Called on Escape. The trap does not close anything itself. */
  readonly onEscape?: () => void;
}

/**
 * Trap focus inside the returned ref's element while `open`.
 *
 * @returns a ref to attach to the container element.
 */
export function useFocusTrap(
  open: boolean,
  options: FocusTrapOptions = {},
): RefObject<HTMLElement | null> {
  const container = useRef<HTMLElement | null>(null);

  /*
   * Held in a ref rather than in the effect's closure so the cleanup restores
   * the element focused when the trap *opened*, not one captured by a later
   * render. A re-render while open must not change where focus goes back to.
   */
  const invoker = useRef<HTMLElement | null>(null);

  /*
   * Kept in a ref and synced in an effect rather than assigned during render.
   * The trap's keydown listener is registered once per open; reading the
   * handler through a ref lets a caller pass a fresh closure every render
   * without the listener being torn down and rebuilt each time — which would
   * drop keystrokes arriving mid-swap.
   */
  const onEscape = useRef(options.onEscape);
  useEffect(() => {
    onEscape.current = options.onEscape;
  });

  useEffect(() => {
    if (!open) return;

    const element = container.current;
    if (!element) return;

    invoker.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    /*
     * First focusable, or the container itself. The container carries
     * tabindex="-1" from the component using this, so a popover with no
     * controls still takes focus rather than leaving it behind the backdrop.
     */
    const [first] = focusableWithin(element);
    (first ?? element).focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onEscape.current?.();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = focusableWithin(element);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];
      if (!firstElement || !lastElement) return;

      const active = document.activeElement;
      if (event.shiftKey && (active === firstElement || active === element)) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && active === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);

      /*
       * The return, on every route at once.
       *
       * isConnected because the invoker can be gone — a popover opened from
       * a node that the next recompute removed. Focusing a detached element
       * silently sends focus to <body>, which strands a keyboard user at the
       * top of the document with no indication anything happened.
       */
      const target = invoker.current;
      invoker.current = null;
      if (target?.isConnected) target.focus();
    };
  }, [open]);

  return container;
}
