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

/**
 * The schema this build understands.
 *
 * Version 2 adds `position` and `district` to `PlaceRecord` and introduces
 * the run record. Per SPEC-0010 REQ "The Schema Change Fails Legibly" that
 * is a bump, and a workspace written at version 1 loads nothing rather than
 * loading places with their positions quietly omitted.
 */
export const SCHEMA_VERSION = 2;

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

/**
 * Where a place sits on the Atlas.
 *
 * Governing: SPEC-0010 REQ "Position Is Optional and Authored"
 *
 * Two integers in the Atlas's own grid space, meaningful only relative to
 * other positions in the same workspace. Deliberately **not** derived from
 * `GalacticAddress` or the in-game `Position`: the Atlas is an arrangement
 * the player authors, and seeding it from the save would make the map a
 * lossy render of coordinates it cannot faithfully project, while quietly
 * overwriting whatever the player had arranged.
 *
 * Nothing in this package reads a save. That is the point — the constraint
 * holds because there is no code path that could violate it, not because a
 * comment asks nicely.
 */
export interface AtlasPosition {
  readonly x: number;
  readonly y: number;
}

export function isAtlasPosition(value: unknown): value is AtlasPosition {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return Number.isInteger(raw["x"]) && Number.isInteger(raw["y"]);
}

/**
 * How the player gets from one stop to the next.
 *
 * Recorded per leg rather than derived. The design's route bar draws a
 * method chip mid-leg, and which route a player takes between two bases is
 * a choice the geometry cannot infer.
 */
export type TravelMethod = "teleporter" | "portal" | "starship" | "foot";

export const TRAVEL_METHODS: readonly TravelMethod[] = [
  "teleporter",
  "portal",
  "starship",
  "foot",
];

export function isTravelMethod(value: unknown): value is TravelMethod {
  return (
    typeof value === "string" && (TRAVEL_METHODS as readonly string[]).includes(value)
  );
}

/**
 * One stop in a run.
 *
 * `method` is how the player reaches *this* stop from the previous one, so
 * the first stop carries none. N stops have N-1 legs, and hanging the leg
 * off its arrival stop keeps that arithmetic out of every consumer.
 *
 * `placeId` is the SPEC-0009 place id and nothing else. SPEC-0010 REQ "A
 * Harvest Run Is Player-Authored" forbids minting a second key for routing,
 * so a stop whose place has been deleted is a stop pointing at an id that
 * no longer resolves — retained and unresolved, never dropped.
 */
export interface RunStop {
  readonly placeId: string;
  readonly method?: TravelMethod;
}

/**
 * A harvest run: an ordered sequence of stops.
 *
 * Governing: SPEC-0010 REQ "A Harvest Run Is Player-Authored", REQ "Seeding
 * Is a One-Time Copy"
 *
 * Belongs to the workspace, never to a plan. `seededFromPlan` is provenance
 * only — a run is never invalidated, reordered, or deleted because the plan
 * that seeded it changed. Seeding copies once and the copy is the player's.
 */
export interface RunRecord {
  readonly id: string;
  readonly schemaVersion: number;

  readonly name?: string;
  readonly stops: readonly RunStop[];

  /** Provenance. Carries no subscription to the named plan. */
  readonly seededFromPlan?: string;

  readonly updatedAt: string;
  readonly revision: number;
}

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
   * Where this place sits on the Atlas, if the player has placed it.
   *
   * Governing: SPEC-0010 REQ "Position Is Optional and Authored", REQ "A
   * Freighter Is a Route Node Without a Position"
   *
   * Optional and nullable, and unpositioned is a first-class state rather
   * than a gap: such a place appears in the place list, is selectable as a
   * run stop, and simply is not drawn. No placeholder coordinate is ever
   * substituted, because a placeholder is a claim about where something is.
   *
   * A field on the place rather than a positions table, so that there is no
   * second record to keep in step and no join that can half-succeed.
   *
   * This is also the whole of the freighter's support. ADR-0006 gives the
   * freighter no fixed location; it needs no branch here, because "has no
   * position" is a state every kind can be in. A conditional on `kind` in
   * any positioning or rendering path would be a defect — read `absence.ts`
   * `positionOf` instead.
   */
  readonly position?: AtlasPosition | null;

  /*
   * The district this place belongs to, if any.
   *
   * Governing: SPEC-0010 REQ "A District Is a Tag and Its Rectangle Is
   * Derived"
   *
   * A name carried on the place — there is no district record and no stored
   * rectangle. The dashed territory is the bounding box of the district's
   * positioned members, computed at render time, which is what makes moving
   * one member a single store write rather than two.
   *
   * Absent means no district. There is no "ungrouped" pseudo-district,
   * because inventing one would put a record where the spec requires none.
   */
  readonly district?: string;

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
  readonly runs: readonly RunRecord[];
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
