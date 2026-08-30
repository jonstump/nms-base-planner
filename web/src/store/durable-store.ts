/*
 * The local store.
 *
 * Governing: ADR-0008 (durable user data lives in a local-first store),
 * SPEC-0009 REQ "A Workspace Owns Places", REQ "A Place Is One Record Type,
 * Whatever Its Kind", REQ "Versioned, and Fails Legibly", REQ "Error
 * Handling Standards", REQ "Storage Operation Standards", REQ "Stage 1
 * Reaches No Network"
 *
 * IndexedDB, not localStorage. The design README's prohibition names
 * localStorage specifically and ADR-0008 lifts it for durable data only —
 * plan state keeps the rule. localStorage would have been the letter of it
 * and not the spirit: synchronous on the thread the WASM module runs on,
 * string-only, and capped around 5 MB.
 *
 * This is the first code in the project that legitimately holds durable
 * state, and it must not become the back door the other rules were keeping
 * shut. `ViewState` still has no field a graph could go in and `ResultCache`
 * still holds one deep-frozen entry. Nothing here stores a plan, a resolved
 * graph, or any derived quantity.
 */

import { classify, failure, ok, type StoreResult } from "./errors";
import { MAX_PLACE_BYTES, serializedBytes } from "./limits";
import {
  emptyWorkspace,
  isPlaceKind,
  SCHEMA_VERSION,
  type PlaceRecord,
  type Workspace,
  type WorkspaceRecord,
} from "./schema";

const DATABASE = "nms-planner";

/*
 * The IndexedDB version, which is not the schema version.
 *
 * IndexedDB's version governs the object stores; `schemaVersion` on each
 * record governs the shape of what is in them. They move independently: a
 * record shape can change without adding a store, and the version failure
 * SPEC-0009 requires is about the records, not the stores.
 */
const DB_VERSION = 1;

const WORKSPACE_STORE = "workspace";
const PLACES_STORE = "places";
/** The workspace is a singleton; this is its key. */
const WORKSPACE_KEY = "self";

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.addEventListener("success", () => {
      resolve(source.result);
    });
    source.addEventListener("error", () => {
      reject(source.error ?? new Error("request failed"));
    });
  });
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => {
      resolve();
    });
    transaction.addEventListener("error", () => {
      reject(transaction.error ?? new Error("transaction failed"));
    });
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new DOMException("aborted", "AbortError"));
    });
  });
}

/**
 * Validate a stored place against the shape this build reads.
 *
 * Returns a StoreResult rather than `PlaceRecord | StoreFailure`. Both of
 * those carry a `kind` field — a place's is its type, a failure's is the
 * literal "failed" — so narrowing on it happened to work and read as though
 * it were designed. One of them changing would have broken it silently.
 */
function readPlace(value: unknown): StoreResult<PlaceRecord> {
  if (typeof value !== "object" || value === null) {
    return failure("MALFORMED_RECORD", "a stored place is not an object");
  }
  const raw = value as Record<string, unknown>;

  const version = raw["schemaVersion"];
  if (typeof version !== "number") {
    return failure("MALFORMED_RECORD", "a stored place carries no schemaVersion");
  }
  if (version > SCHEMA_VERSION) {
    return failure(
      "UNSUPPORTED_VERSION",
      `a stored place is schema version ${String(version)}, and this build reads ${String(SCHEMA_VERSION)}`,
    );
  }

  if (typeof raw["id"] !== "string" || !isPlaceKind(raw["kind"])) {
    return failure("MALFORMED_RECORD", "a stored place has no usable id or kind");
  }
  if (typeof raw["updatedAt"] !== "string" || typeof raw["revision"] !== "number") {
    return failure(
      "MALFORMED_RECORD",
      `place ${raw["id"]} is missing updatedAt or revision`,
    );
  }

  return ok(raw as unknown as PlaceRecord);
}

export interface StoreOptions {
  /** Injected so tests can drive time. Defaults to the wall clock. */
  readonly now?: () => string;
  /** Injected so a test can use its own database rather than the app's. */
  readonly databaseName?: string;
}

export class DurableStore {
  readonly #databaseName: string;
  readonly #now: () => string;
  #db: IDBDatabase | null = null;

  constructor(options: StoreOptions = {}) {
    this.#databaseName = options.databaseName ?? DATABASE;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Open the database, creating its stores on first use.
   *
   * Idempotent. The `versionchange` handler is the load-bearing part: when
   * another tab opens the database at a higher version, this connection is
   * told and closes. Without it that tab's upgrade blocks indefinitely and
   * presents as the application hanging on load — a symptom pointing
   * nowhere near its cause, which is why SPEC-0009 names it.
   */
  async open(): Promise<StoreResult<void>> {
    if (this.#db) return ok(undefined);

    if (typeof indexedDB === "undefined") {
      return failure("STORAGE_UNAVAILABLE", "this browser exposes no IndexedDB");
    }

    try {
      const opening = indexedDB.open(this.#databaseName, DB_VERSION);

      opening.addEventListener("upgradeneeded", () => {
        const db = opening.result;
        if (!db.objectStoreNames.contains(WORKSPACE_STORE))
          db.createObjectStore(WORKSPACE_STORE);
        if (!db.objectStoreNames.contains(PLACES_STORE)) {
          db.createObjectStore(PLACES_STORE, { keyPath: "id" });
        }
      });

      const db = await request(opening);
      db.addEventListener("versionchange", () => {
        db.close();
        this.#db = null;
      });

      this.#db = db;
      return ok(undefined);
    } catch (error) {
      return classify(error, "opening the store");
    }
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  /**
   * Read the whole workspace.
   *
   * One transaction covering both stores, and **all or nothing**. An
   * unrecognized version anywhere loads no places at all — not the readable
   * subset. A partially loaded workspace is indistinguishable to the player
   * from a complete one: they see their bases and do not see that four of
   * eleven are missing.
   */
  async load(): Promise<StoreResult<Workspace>> {
    const db = this.#db;
    if (!db) return failure("STORAGE_UNAVAILABLE", "the store is not open");

    try {
      const transaction = db.transaction([WORKSPACE_STORE, PLACES_STORE], "readonly");
      const storedWorkspace = await request<unknown>(
        transaction.objectStore(WORKSPACE_STORE).get(WORKSPACE_KEY),
      );
      const storedPlaces = await request<unknown[]>(
        transaction.objectStore(PLACES_STORE).getAll(),
      );
      await settled(transaction);

      /*
       * A device that has never used the store. Ordinary, not a failure.
       *
       * Only when there are no places either. A missing workspace record
       * with places present is not a fresh device — it is a store whose
       * two halves disagree, and returning "empty" there would silently
       * drop every place the player has. An earlier draft did exactly that
       * and the malformed-record test caught it.
       */
      if (storedWorkspace === undefined) {
        if (storedPlaces.length > 0) {
          return failure(
            "MALFORMED_RECORD",
            `the store holds ${String(storedPlaces.length)} places and no workspace record`,
          );
        }
        return ok({ workspace: emptyWorkspace(this.#now()), places: [] });
      }

      const raw = storedWorkspace as Record<string, unknown>;
      const version = raw["schemaVersion"];
      if (typeof version !== "number") {
        return failure(
          "MALFORMED_RECORD",
          "the stored workspace carries no schemaVersion",
        );
      }
      if (version > SCHEMA_VERSION) {
        return failure(
          "UNSUPPORTED_VERSION",
          `the stored workspace is schema version ${String(version)}, ` +
            `and this build reads ${String(SCHEMA_VERSION)}`,
        );
      }
      if (!("ownerId" in raw)) {
        return failure("MALFORMED_RECORD", "the stored workspace has no ownerId field");
      }

      const places: PlaceRecord[] = [];
      for (const stored of storedPlaces) {
        const place = readPlace(stored);
        if (place.kind !== "ok") return place;
        places.push(place.value);
      }

      return ok({ workspace: raw as unknown as WorkspaceRecord, places });
    } catch (error) {
      return classify(error, "loading the store");
    }
  }

  /**
   * Write one place, advancing its revision.
   *
   * The size bound is checked before anything is attempted: SPEC-0009
   * requires the store fail a write that would exceed it "rather than
   * attempting it and discovering the quota", because a quota failure is
   * shared with everything else the origin stores and is a worse way to
   * find out.
   *
   * The place and the workspace's `updatedAt` move in one transaction. A
   * store that could complete the first without the second would produce a
   * workspace that disagrees with its own contents.
   */
  async putPlace(
    place: Omit<PlaceRecord, "schemaVersion" | "updatedAt" | "revision">,
  ): Promise<StoreResult<PlaceRecord>> {
    const db = this.#db;
    if (!db) return failure("STORAGE_UNAVAILABLE", "the store is not open");

    const size = serializedBytes(place);
    if (size > MAX_PLACE_BYTES) {
      return failure(
        "PLACE_TOO_LARGE",
        `place ${place.id} is ${String(size)} bytes, and the limit is ${String(MAX_PLACE_BYTES)}`,
      );
    }

    try {
      const now = this.#now();
      const transaction = db.transaction([WORKSPACE_STORE, PLACES_STORE], "readwrite");
      const places = transaction.objectStore(PLACES_STORE);
      const workspaces = transaction.objectStore(WORKSPACE_STORE);

      const existing = (await request<unknown>(places.get(place.id))) as
        { revision?: number } | undefined;
      const revision = (existing?.revision ?? 0) + 1;

      const record: PlaceRecord = {
        ...place,
        schemaVersion: SCHEMA_VERSION,
        updatedAt: now,
        revision,
      };
      await request(places.put(record));

      const storedWorkspace = (await request<unknown>(workspaces.get(WORKSPACE_KEY))) as
        WorkspaceRecord | undefined;
      await request(
        workspaces.put(
          { ...(storedWorkspace ?? emptyWorkspace(now)), updatedAt: now },
          WORKSPACE_KEY,
        ),
      );

      await settled(transaction);
      return ok(record);
    } catch (error) {
      return classify(error, `writing place ${place.id}`);
    }
  }

  /**
   * Remove one place.
   *
   * Governing: SPEC-0011 REQ "An Assignment Naming an Absent Place Is
   * Unassigned", ADR-0010 (a deleted place unassigns; it does not cascade)
   *
   * The store removes the record and nothing else. It does not reach into
   * any plan, because a plan is not the store's to edit — the leaves that
   * named this place become unassigned by rule when the plan is next read
   * against the workspace, which is what keeps deleting a place from
   * destroying the plan that referenced it.
   *
   * Deleting a place that is not there succeeds. The caller asked for a
   * state, and that state already holds; reporting an error would make a
   * double click a failure.
   */
  async deletePlace(id: string): Promise<StoreResult<void>> {
    const db = this.#db;
    if (!db) return failure("STORAGE_UNAVAILABLE", "the store is not open");

    try {
      const now = this.#now();
      const transaction = db.transaction([WORKSPACE_STORE, PLACES_STORE], "readwrite");
      await request(transaction.objectStore(PLACES_STORE).delete(id));

      const workspaces = transaction.objectStore(WORKSPACE_STORE);
      const storedWorkspace = (await request<unknown>(workspaces.get(WORKSPACE_KEY))) as
        WorkspaceRecord | undefined;
      await request(
        workspaces.put(
          { ...(storedWorkspace ?? emptyWorkspace(now)), updatedAt: now },
          WORKSPACE_KEY,
        ),
      );

      await settled(transaction);
      return ok(undefined);
    } catch (error) {
      return classify(error, `deleting place ${id}`);
    }
  }

  /** Persist the view's own preferences. Interface state, not domain state. */
  async putPreferences(
    preferences: Readonly<Record<string, string | boolean>>,
  ): Promise<StoreResult<void>> {
    const db = this.#db;
    if (!db) return failure("STORAGE_UNAVAILABLE", "the store is not open");

    try {
      const now = this.#now();
      const transaction = db.transaction(WORKSPACE_STORE, "readwrite");
      const workspaces = transaction.objectStore(WORKSPACE_STORE);
      const stored = (await request<unknown>(workspaces.get(WORKSPACE_KEY))) as
        WorkspaceRecord | undefined;
      await request(
        workspaces.put(
          { ...(stored ?? emptyWorkspace(now)), preferences, updatedAt: now },
          WORKSPACE_KEY,
        ),
      );
      await settled(transaction);
      return ok(undefined);
    } catch (error) {
      return classify(error, "writing preferences");
    }
  }

  /**
   * Remove everything.
   *
   * ADR-0002 banked "needs no upload endpoint, retention policy, or
   * deletion story" as a benefit of holding nothing. The moment data is
   * held the player is owed a way to remove it that is not developer tools,
   * and this is that operation's storage half.
   */
  async deleteAll(): Promise<StoreResult<void>> {
    const db = this.#db;
    if (!db) return failure("STORAGE_UNAVAILABLE", "the store is not open");

    try {
      const transaction = db.transaction([WORKSPACE_STORE, PLACES_STORE], "readwrite");
      await request(transaction.objectStore(PLACES_STORE).clear());
      await request(transaction.objectStore(WORKSPACE_STORE).clear());
      await settled(transaction);
      return ok(undefined);
    } catch (error) {
      return classify(error, "deleting stored data");
    }
  }
}
