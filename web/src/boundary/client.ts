/*
 * The view's only route to a domain value.
 *
 * Governing: ADR-0003 (Go domain, thin adapter), ADR-0004 (React view layer),
 * SPEC-0005 REQ "Boundary Client", REQ "Module Loading", REQ "The View
 * Computes No Domain Values"
 *
 * Two promises shape the API.
 *
 * "WHEN a call is made before the module has loaded its artifact THEN the
 * view presents a loading state rather than a failure, and retries once
 * readiness resolves." So a call issued during loading is not rejected and is
 * not the caller's problem to reissue: it waits on the same load everyone
 * else is waiting on, then goes through. {@link BoundaryClient.peek} is what
 * a component renders from in the meantime.
 *
 * "The view MUST NOT perform arithmetic on quantities." So nothing here
 * returns a number, and no figure is derived from a previous figure — every
 * call is a fresh crossing.
 */

import type { PlannerModule } from "./contract";
import { selectCatalogue, type CatalogueItem } from "./catalogue";
import { decodeEnvelope, isNotReady, type Outcome } from "./envelope";
import { selectBuild, type Build } from "./build";
import { selectGraph, type ResolvedGraph } from "./graph";
import { selectPower, type Power } from "./power";
import {
  powerToWire,
  rollupToWire,
  type PowerRequest,
  type RollupRequest,
} from "./requests";
import {
  BoundaryModule,
  DEFAULT_PATHS,
  type ModulePaths,
  type ModuleStatus,
} from "./module";
import { planToWire, type Plan } from "./plan";

/**
 * What a component renders right now, without waiting.
 *
 * `pending` is deliberately distinct from a failure and from a zero: SPEC-0005
 * REQ "Module Loading" requires figures to be "shown as pending, not as zero",
 * because a zero is a claim about the plan and a pending is a claim about the
 * module.
 */
export type Readiness =
  | { readonly kind: "not-started" }
  | { readonly kind: "pending" }
  | { readonly kind: "ready" }
  | { readonly kind: "unavailable"; readonly outcome: Outcome<never> };

export class BoundaryClient {
  readonly #module: BoundaryModule;

  constructor(module: BoundaryModule = new BoundaryModule(DEFAULT_PATHS)) {
    this.#module = module;
  }

  static withPaths(paths: ModulePaths): BoundaryClient {
    return new BoundaryClient(new BoundaryModule(paths));
  }

  /** Status changes, so a shell re-renders when pending becomes ready. */
  subscribe(listener: (status: ModuleStatus) => void): () => void {
    return this.#module.subscribe(listener);
  }

  /** The synchronous view of readiness. Never blocks, never fetches. */
  peek(): Readiness {
    switch (this.#module.status()) {
      case "idle":
        return { kind: "not-started" };
      case "loading":
        return { kind: "pending" };
      case "ready":
        return { kind: "ready" };
      case "failed": {
        const outcome = this.#module.failureOutcome();
        return {
          kind: "unavailable",
          outcome: outcome ?? {
            kind: "failed",
            code: "MODULE_LOAD_FAILED",
            message: "the module is unavailable",
          },
        };
      }
    }
  }

  /**
   * Begin loading.
   *
   * Called by the shell when a surface that needs figures first appears —
   * not at import time and not on first paint.
   */
  async start(): Promise<void> {
    await this.#module.ensureLoaded();
  }

  /** Resolve a plan into a graph. */
  async resolve(plan: Plan): Promise<Outcome<ResolvedGraph>> {
    return this.#call((planner) => planner.resolve(planToWire(plan)), selectGraph);
  }

  /**
   * Stage 2: a plan plus curated constants into construction instructions.
   *
   * Takes the plan rather than a resolved graph. SPEC-0002 REQ "Boundary
   * Surface" requires one call to perform one complete stage, and a caller
   * obliged to hand back a graph it received would be assembling the stage
   * out of two crossings.
   */
  async rollup(request: RollupRequest): Promise<Outcome<Build>> {
    return this.#call((planner) => planner.rollup(rollupToWire(request)), selectBuild);
  }

  /**
   * Stage 3: generation and draw into a power position.
   *
   * Takes no plan. The domain's power stage costs a base sketched by hand
   * exactly as it costs one a rollup produced, and requiring a plan here
   * would invent a coupling the engine does not have.
   */
  /**
   * The searchable item catalogue.
   *
   * Called once, not per keystroke — SPEC-0011 § Rate Limiting. The caller
   * holds the list and filters locally.
   */
  async catalogue(): Promise<Outcome<readonly CatalogueItem[]>> {
    return this.#call((planner) => planner.catalogue(""), selectCatalogue);
  }

  async power(request: PowerRequest): Promise<Outcome<Power>> {
    return this.#call((planner) => planner.power(powerToWire(request)), selectPower);
  }

  /**
   * One crossing, with the readiness wait and the single retry.
   *
   * The retry exists for a narrow case: the module answered NOT_READY even
   * though the load had settled. That means readiness changed underneath the
   * call rather than that the call was wrong, so it is worth exactly one more
   * attempt after waiting again — and not a loop, which would turn a module
   * that is genuinely never ready into a hang instead of a message.
   */
  async #call<T>(
    invoke: (planner: PlannerModule) => string,
    select: (data: unknown) => T | null,
  ): Promise<Outcome<T>> {
    const loaded = await this.#module.ensureLoaded();
    if (loaded.kind !== "ok") return loaded;

    const first = decodeEnvelope(invoke(loaded.value), select);
    if (!isNotReady(first)) return first;

    const reloaded = await this.#module.ensureLoaded();
    if (reloaded.kind !== "ok") return reloaded;
    return decodeEnvelope(invoke(reloaded.value), select);
  }
}
