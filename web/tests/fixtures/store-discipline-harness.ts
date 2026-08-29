/*
 * Fixture for the store's two discipline requirements.
 *
 * Governing: SPEC-0009 REQ "Stage 1 Reaches No Network", REQ "Nothing Is
 * Marked for Synchronization"
 *
 * Separate from `store-harness.ts` on purpose. This page has to wrap the
 * network primitives *before* any store code runs, and a fixture that both
 * instruments globals and serves the behavioural suite would leave every
 * test in that suite running against patched globals for no reason.
 *
 * The records are read back with a raw IndexedDB connection rather than
 * through `DurableStore.load`, because `load` returns typed records and the
 * question here is what keys are actually on disk. A field the store's own
 * reader drops is still a field that was written.
 */

import { DurableStore } from "../../src/store";
import { attributedTo, type NetworkAttempt } from "../helpers/network-attribution";

const STORE_PATH = "/src/store/";
const HARNESS_PATH = "store-discipline-harness";

const attempts: NetworkAttempt[] = [];

function record(kind: string): void {
  attempts.push({ kind, stack: new Error().stack ?? "" });
}

/*
 * Wrap every way this page could reach the network.
 *
 * Installed at module scope so nothing runs ahead of it. Each wrapper
 * records and then delegates: a recorder that swallowed the call would make
 * the unrelated-traffic test pass for the wrong reason, since the request it
 * is supposed to observe would never happen.
 */
const realFetch = window.fetch.bind(window);
window.fetch = (...args: Parameters<typeof fetch>) => {
  record("fetch");
  return realFetch(...args);
};

/*
 * Capturing `open` off the prototype is the whole point — it is re-invoked
 * below with `.call(this, ...)`, which is the correct receiver and the one
 * the rule cannot see. Rebinding it would break every XHR on the page.
 */
// eslint-disable-next-line @typescript-eslint/unbound-method
const realOpen = XMLHttpRequest.prototype.open;
/*
 * Spelled out rather than spread, because `open` is overloaded: the
 * two-argument form and the five-argument form are separate signatures, and
 * a rest parameter satisfies neither.
 */
XMLHttpRequest.prototype.open = function open(
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  async?: boolean,
  username?: string | null,
  password?: string | null,
): void {
  record("xhr");
  /*
   * `async` defaults to true in the two-argument form, so passing it
   * through explicitly preserves the semantics. `.call` on an overloaded
   * function resolves to the last overload, which is the five-argument one.
   */
  realOpen.call(this, method, url, async ?? true, username, password);
};

if (typeof navigator.sendBeacon === "function") {
  const realBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = ((...args: Parameters<typeof realBeacon>) => {
    record("beacon");
    return realBeacon(...args);
  }) as typeof navigator.sendBeacon;
}

/*
 * Constructors go through a Proxy rather than a subclass: `super()` has to
 * be the first statement in a derived constructor, so a subclass could only
 * record *after* the socket had already been opened.
 */
window.WebSocket = new Proxy(window.WebSocket, {
  construct: (target, args: ConstructorParameters<typeof WebSocket>) => {
    record("websocket");
    return Reflect.construct(target, args);
  },
});

window.EventSource = new Proxy(window.EventSource, {
  construct: (target, args: ConstructorParameters<typeof EventSource>) => {
    record("eventsource");
    return Reflect.construct(target, args);
  },
});

function readRaw(database: string, store: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(database);
    opening.onsuccess = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains(store)) {
        db.close();
        resolve([]);
        return;
      }
      const transaction = db.transaction(store, "readonly");
      const all = transaction.objectStore(store).getAll();
      all.onsuccess = () => {
        db.close();
        resolve(all.result);
      };
      all.onerror = () => {
        db.close();
        reject(all.error ?? new Error("raw read failed"));
      };
    };
    opening.onerror = () => {
      reject(opening.error ?? new Error("raw open failed"));
    };
  });
}

declare global {
  interface Window {
    __discipline: {
      /** Drive every store call path: open, load, write, prefer, reload, delete. */
      exercise: (database: string) => Promise<string[]>;
      /** Write a place and preferences and leave them there, for the raw reads. */
      seed: (database: string) => Promise<string[]>;
      /** A request from code that is not the store, as any real page has. */
      unrelated: () => Promise<void>;
      /** Every attempt seen, tagged with where it came from. */
      attempts: () => { kind: string; fromStore: boolean; fromHarness: boolean }[];
      reset: () => void;
      /** Records as they sit on disk, not as the store's reader returns them. */
      raw: (database: string, store: string) => Promise<unknown[]>;
    };
  }
}

window.__discipline = {
  exercise: async (database) => {
    const store = new DurableStore({ databaseName: database });
    const outcomes: string[] = [];
    const note = (label: string, result: { kind: string }) => {
      outcomes.push(`${label}:${result.kind}`);
    };

    note("open", await store.open());
    note("load", await store.load());
    note(
      "putPlace",
      await store.putPlace({
        id: "place-1",
        kind: "base",
        name: "Aurora Flats",
        notes: "Landing pad on the north ridge, near the copper.",
        tags: ["copper", "temperate"],
        ticks: { "part-1": true },
        stocked: { "item-1": "120" },
      }),
    );
    note("putPreferences", await store.putPreferences({ groupSeparator: true }));
    note("reload", await store.load());
    note("deleteAll", await store.deleteAll());
    store.close();
    return outcomes;
  },

  seed: async (database) => {
    /*
     * `exercise` deletes everything at the end, which is the right shape
     * for the network tests and the wrong one for the record tests. This
     * writes and leaves it written, so the raw reads have something to
     * look at.
     */
    const store = new DurableStore({ databaseName: database });
    const outcomes: string[] = [];
    const note = (label: string, result: { kind: string }) => {
      outcomes.push(`${label}:${result.kind}`);
    };

    note("open", await store.open());
    note(
      "putPlace",
      await store.putPlace({
        id: "kept",
        kind: "settlement",
        name: "Kept",
        stocked: { "item-1": "7/2" },
      }),
    );
    note("putPreferences", await store.putPreferences({ showUnverified: false }));
    store.close();
    return outcomes;
  },

  unrelated: async () => {
    /*
     * Deliberately a real request from a path that is not the store. It is
     * allowed to fail — a 404 still travels, and travelling is the whole
     * point. What must not happen is it being attributed to the store.
     */
    try {
      await fetch("/favicon.ico?unrelated=1");
    } catch {
      /* offline, blocked, whatever — it was still attempted, and recorded */
    }
  },

  attempts: () =>
    attempts.map((attempt) => ({
      kind: attempt.kind,
      fromStore: attributedTo(attempt.stack, STORE_PATH),
      fromHarness: attributedTo(attempt.stack, HARNESS_PATH),
    })),

  reset: () => {
    attempts.length = 0;
  },

  raw: readRaw,
};

document.body.dataset["ready"] = "true";
