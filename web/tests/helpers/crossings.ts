/*
 * Counting boundary crossings, and capturing what came back.
 *
 * Governing: SPEC-0006 REQ "Graph Rendering From the Boundary Payload"
 *
 * "WHEN the canvas renders a resolved plan of 36 nodes THEN exactly one
 * `resolve` crossing produced it" — and the acceptance criterion is
 * explicit that this be "verified by counting crossings rather than by
 * inspection". A test that counted rendered nodes would pass just as
 * happily against a canvas that made one call per node.
 *
 * The count is taken at the module's own global rather than at the client,
 * because that is the actual boundary. A wrapper on the client would miss a
 * second client, and constructing a second client is exactly the shape the
 * requirement forbids.
 *
 * The module assigns `globalThis.nmsPlanner` when the WASM binary runs, so
 * the counter is installed as a property setter beforehand and wraps the
 * value on the way in.
 */

import type { Page } from "@playwright/test";

export interface Crossings {
  readonly resolve: number;
  readonly rollup: number;
  readonly power: number;
  /** SPEC-0011 § Rate Limiting: not one per keystroke. */
  readonly catalogue: number;
}

declare global {
  interface Window {
    __crossings: { resolve: number; rollup: number; power: number; catalogue: number };
    /** The raw payload of the last resolve, for order comparisons. */
    __lastResolve: unknown;
  }
}

export async function countCrossings(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__crossings = { resolve: 0, rollup: 0, power: 0, catalogue: 0 };
    window.__lastResolve = null;

    let real: unknown = undefined;
    Object.defineProperty(window, "nmsPlanner", {
      configurable: true,
      get: () => real,
      set: (value: unknown) => {
        real =
          value === null || typeof value !== "object"
            ? value
            : new Proxy(value as Record<string, unknown>, {
                get(target, property, receiver) {
                  const inner: unknown = Reflect.get(target, property, receiver);
                  const key = property as keyof Window["__crossings"];
                  if (typeof inner !== "function" || !(key in window.__crossings)) {
                    return inner;
                  }
                  return (...args: unknown[]): unknown => {
                    window.__crossings[key] += 1;
                    const answer: unknown = (inner as (...a: unknown[]) => unknown).apply(
                      target,
                      args,
                    );
                    if (property === "resolve") window.__lastResolve = answer;
                    return answer;
                  };
                },
              });
      },
    });
  });
}

export async function crossings(page: Page): Promise<Crossings> {
  return page.evaluate(() => ({ ...window.__crossings }));
}

/** The node names of the last resolve, in the order the payload listed them. */
export async function payloadOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const answer = window.__lastResolve;
    const parsed: unknown = typeof answer === "string" ? JSON.parse(answer) : answer;
    const data = (parsed as { data?: { graph?: { nodes?: { name?: string }[] } } })?.data;
    return (data?.graph?.nodes ?? []).map((node) => node.name ?? "");
  });
}

/** Every edge the payload actually contained, as `source->target` with its per-unit. */
export async function payloadEdges(
  page: Page,
): Promise<{ id: string; perUnit: string; targetMethod: string }[]> {
  return page.evaluate(() => {
    const answer = window.__lastResolve;
    const parsed: unknown = typeof answer === "string" ? JSON.parse(answer) : answer;
    const nodes =
      (
        parsed as {
          data?: {
            graph?: {
              nodes?: {
                itemId?: string;
                method?: string;
                children?: { to?: string; perUnit?: string }[];
              }[];
            };
          };
        }
      ).data?.graph?.nodes ?? [];

    const out: { id: string; perUnit: string; targetMethod: string }[] = [];
    for (const node of nodes) {
      for (const child of node.children ?? []) {
        out.push({
          id: `${child.to ?? ""}->${node.itemId ?? ""}`,
          perUnit: child.perUnit ?? "",
          targetMethod: node.method ?? "",
        });
      }
    }
    return out;
  });
}
