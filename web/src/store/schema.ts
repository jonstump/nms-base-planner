/*
 * What the store holds.
 *
 * Governing: ADR-0008 (durable user data, local-first), SPEC-0009 REQ "A
 * Workspace Owns Places", REQ "A Place Is One Record Type, Whatever Its
 * Kind", REQ "Versioned, and Fails Legibly"
 *
 * Three fields here are written from version 1 and read by nothing:
 * `ownerId`, `updatedAt` and `revision`. That is deliberate and it is the
 * whole reason ADR-0008 settled ownership and the sharing unit before any
 * sharing was built.
 *
 * Sign-in attaches an `ownerId` to a workspace that already carries the
 * field; it does not re-key records. A field added in version 2 cannot do
 * that for data written under version 1, and the player who ticked fifty
 * construction items before signing up is exactly who that migration is
 * for. `revision` is the same argument for multi-device ordering: a store
 * that adds it later cannot order edits made before it existed.
 */

/** The schema this build understands. */
export const SCHEMA_VERSION = 1;

/**
 * One record type for all three surfaces.
 *
 * ADR-0006 and ADR-0007 make freighters and settlements their own surfaces
 * because their domain content differs. None of that reaches durable user
 * data — a note is a note and a tick is a tick — and ADR-0008 settled the
 * sharing unit as "one place", which only reads coherently if a place is
 * one thing.
 */
export type PlaceKind = "base" | "freighter" | "settlement";

export const PLACE_KINDS: readonly PlaceKind[] = ["base", "freighter", "settlement"];

export interface PlaceRecord {
  /** Generated at creation. Independent of any save file and any account. */
  readonly id: string;
  readonly kind: PlaceKind;
  readonly schemaVersion: number;

  /** Player-assigned. Absent until the player names it. */
  readonly name?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
  /** Construction items ticked off, keyed by part id. */
  readonly ticks?: Readonly<Record<string, boolean>>;
  /** Stocked quantities, keyed by item id. Exact strings, never numbers. */
  readonly stocked?: Readonly<Record<string, string>>;

  /*
   * Reserved by ADR-0008, which defers multi-device sync and conflict
   * resolution to a later ADR (numbered 0012 in its forward table, and not
   * yet written) and keeps the schema room deliberately. SPEC-0009 makes it
   * normative: both MUST be written from the first version, because a store
   * that adds them later cannot order edits made before they existed.
   *
   * Written on every mutation; nothing reads them in stage 1.
   */
  readonly updatedAt: string;
  readonly revision: number;
}

export interface WorkspaceRecord {
  readonly schemaVersion: number;

  /**
   * Null in stage 1, where no account exists.
   *
   * Present and null rather than absent — SPEC-0009 REQ "A Workspace Owns
   * Places" requires the distinction, because the field being there from
   * version 1 is what makes sign-in an attachment rather than a migration.
   */
  readonly ownerId: string | null;

  /** View-local preferences. SPEC-0005 permits the view to hold these. */
  readonly preferences?: Readonly<Record<string, string | boolean>>;

  readonly updatedAt: string;
}

export interface Workspace {
  readonly workspace: WorkspaceRecord;
  readonly places: readonly PlaceRecord[];
}

export function isPlaceKind(value: unknown): value is PlaceKind {
  return typeof value === "string" && (PLACE_KINDS as readonly string[]).includes(value);
}

/**
 * A workspace as it exists on a device that has never used the store.
 *
 * Not an error and not a failure — SPEC-0009 REQ "An Empty Store Is a
 * Designed State" makes this the ordinary condition on a fresh device, a
 * private window, or after the player cleared their storage.
 */
export function emptyWorkspace(now: string): WorkspaceRecord {
  return { schemaVersion: SCHEMA_VERSION, ownerId: null, updatedAt: now };
}
