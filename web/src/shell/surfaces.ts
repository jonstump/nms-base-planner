/*
 * The surfaces the shell switches between.
 *
 * Governing: ADR-0010 (places first and the shell), SPEC-0011 REQ "The
 * Shell Opens on Bases and Renders Without the Domain", REQ "Surfaces Are
 * Shell View State", SPEC-0005 REQ "Module Loading"
 *
 * A list rather than a router. SPEC-0011: "Surface selection MUST be view
 * state the shell holds. The application MUST NOT introduce a router
 * library." Two surfaces and no URL segment do not need one, and a router
 * would put a second owner of navigation state next to the URL hash, which
 * ADR-0002 already owns for the plan.
 *
 * `needsModule` is what makes the switcher stable. SPEC-0011 requires that
 * "a surface whose data is unavailable MUST present its own empty or
 * loading state rather than being absent from the switcher, so the set of
 * surfaces does not change under the player" — a list that shrank while the
 * WASM binary was still downloading would move controls under someone's
 * cursor mid-click.
 */

export const SURFACES = [
  {
    id: "bases",
    label: "Bases",
    /**
     * The entry surface, and the one that must render with no module.
     *
     * SPEC-0011: a player "MUST be able to create a place, name it, and see
     * it listed with the module never having loaded". Places live in the
     * durable store; nothing here crosses the boundary.
     */
    needsModule: false,
  },
  {
    id: "planner",
    label: "Planner",
    /**
     * Every figure on this surface comes from the domain, so it has nothing
     * to show until the module answers. It stays in the switcher regardless
     * and presents its own pending state when selected.
     */
    needsModule: true,
  },
] as const;

export type SurfaceId = (typeof SURFACES)[number]["id"];

/** The entry surface. SPEC-0011: "The entry surface MUST be the bases surface." */
export const ENTRY_SURFACE: SurfaceId = "bases";

export function isSurfaceId(value: unknown): value is SurfaceId {
  return SURFACES.some((surface) => surface.id === value);
}
