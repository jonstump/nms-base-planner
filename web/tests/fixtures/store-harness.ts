/*
 * Test harness for the durable store.
 *
 * Governing: SPEC-0009
 *
 * IndexedDB exists only in a browser, so the store's tests are page tests
 * rather than Node ones. Each test gets its own database name so they can
 * run in parallel without sharing state — the store is a singleton per
 * origin in production and deliberately not here.
 */

import { classify } from "../../src/store/errors";
import { DurableStore } from "../../src/store";
import type { PlaceRecord, StoreResult, Workspace } from "../../src/store";

type NewPlace = Omit<PlaceRecord, "schemaVersion" | "updatedAt" | "revision">;

declare global {
  interface Window {
    __store: {
      open: (database: string, now?: string) => Promise<StoreResult<void>>;
      load: (database: string) => Promise<StoreResult<Workspace>>;
      putPlace: (database: string, place: NewPlace) => Promise<StoreResult<PlaceRecord>>;
      putPreferences: (
        database: string,
        preferences: Record<string, string | boolean>,
      ) => Promise<StoreResult<void>>;
      deleteAll: (database: string) => Promise<StoreResult<void>>;
      close: (database: string) => void;
      /** Write a record straight past the store, to plant a bad version. */
      plant: (
        database: string,
        store: string,
        key: string | null,
        value: unknown,
      ) => Promise<void>;
      /** Open a raw connection at a higher version, to test versionchange. */
      upgrade: (database: string, version: number) => Promise<"upgraded" | "blocked">;
      /** The pure error classifier, for conditions a test cannot provoke. */
      classify: (name: string) => string;
    };
  }
}

const stores = new Map<string, DurableStore>();

function get(database: string, now?: string): DurableStore {
  let store = stores.get(database);
  if (!store) {
    store = new DurableStore(
      now ? { databaseName: database, now: () => now } : { databaseName: database },
    );
    stores.set(database, store);
  }
  return store;
}

window.__store = {
  open: async (database, now) => get(database, now).open(),
  load: async (database) => get(database).load(),
  putPlace: async (database, place) => get(database).putPlace(place),
  putPreferences: async (database, preferences) =>
    get(database).putPreferences(preferences),
  deleteAll: async (database) => get(database).deleteAll(),
  close: (database) => {
    get(database).close();
    stores.delete(database);
  },

  plant: async (database, store, key, value) =>
    new Promise((resolve, reject) => {
      const opening = indexedDB.open(database);
      opening.onsuccess = () => {
        const db = opening.result;
        const transaction = db.transaction(store, "readwrite");
        const target = transaction.objectStore(store);
        if (key === null) target.put(value);
        else target.put(value, key);
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

  upgrade: async (database, version) =>
    new Promise((resolve) => {
      const opening = indexedDB.open(database, version);
      let blocked = false;
      opening.onblocked = () => {
        blocked = true;
      };
      opening.onsuccess = () => {
        opening.result.close();
        resolve(blocked ? "blocked" : "upgraded");
      };
      opening.onerror = () => {
        resolve("blocked");
      };
      /*
       * A `blocked` event does not settle the request — the open stays
       * pending until the holding connection closes. Without this the test
       * would hang rather than report the condition it is checking for.
       */
      setTimeout(() => {
        resolve(blocked ? "blocked" : "upgraded");
      }, 2000);
    }),

  classify: (name) => classify(new DOMException("planted", name), "test").code,
};

document.body.dataset["ready"] = "true";
