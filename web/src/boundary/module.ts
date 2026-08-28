/*
 * Fetching, instantiating and priming the WASM module — late, once, and with
 * its two failure modes kept apart.
 *
 * Governing: ADR-0003 (Go domain, thin adapter), ADR-0004 (React view layer),
 * SPEC-0005 REQ "Module Loading", REQ "Boundary Client"
 *
 * Nothing here runs at import time. The requirement is that "the WASM module
 * and the layout engine MUST be loaded lazily rather than on first paint",
 * and a module-level side effect would defeat that no matter how the caller
 * behaves — which is why the loader is a method on an object the shell
 * constructs, and why tests/boundary/lazy-load.spec.ts checks the network
 * rather than the source.
 */

import { EXPECTED_CONTRACT_VERSION, NAMESPACE, type PlannerModule } from "./contract";
import { decodeEnvelope, failure, type Outcome } from "./envelope";

/** The Go toolchain's loader shim defines this. */
interface GoRuntime {
  readonly importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

type GoConstructor = new () => GoRuntime;

export type ModuleStatus =
  /** Nothing fetched. The shell is interactive and no domain figure exists. */
  | "idle"
  /** In flight. Figures are pending — not zero. */
  | "loading"
  /** The artifact validated. Calls go through. */
  | "ready"
  /** Terminal. See {@link BoundaryModule.failureOutcome}. */
  | "failed";

export interface ModulePaths {
  readonly shim: string;
  readonly wasm: string;
  readonly artifact: string;
}

export const DEFAULT_PATHS: ModulePaths = {
  shim: "/wasm_exec.js",
  wasm: "/planner.wasm",
  artifact: "/tier1.json",
};

/** Load one classic script and resolve when it has executed. */
async function loadScript(source: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const element = document.createElement("script");
    element.src = source;
    /*
     * Not a module and not inlined. The CSP is `script-src 'self'
     * 'wasm-unsafe-eval'` with no 'unsafe-inline', so the shim has to arrive
     * as a same-origin file — which it does, copied out of the Go toolchain
     * by scripts/build-wasm.sh.
     */
    element.addEventListener("load", () => {
      resolve();
    });
    element.addEventListener("error", () => {
      reject(new Error(`${source} could not be loaded`));
    });
    document.head.appendChild(element);
  });
}

async function instantiate(
  wasmPath: string,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
  const response = await fetch(wasmPath);
  if (!response.ok) {
    throw new Error(`${wasmPath} responded ${String(response.status)}`);
  }

  /*
   * instantiateStreaming is the fast path and refuses anything not served as
   * application/wasm. A static host that has not been told about the type
   * would fail here for a reason that has nothing to do with the module, so
   * the buffer path is the fallback rather than the diagnosis.
   */
  try {
    const { instance } = await WebAssembly.instantiateStreaming(
      response.clone(),
      imports,
    );
    return instance;
  } catch {
    const { instance } = await WebAssembly.instantiate(
      await response.arrayBuffer(),
      imports,
    );
    return instance;
  }
}

/** Wait for the module's `main` to publish its namespace. */
async function awaitNamespace(): Promise<PlannerModule> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = (globalThis as Record<string, unknown>)[NAMESPACE];
    if (candidate !== undefined && candidate !== null) {
      return candidate as PlannerModule;
    }
    await new Promise((resume) => setTimeout(resume, 10));
  }
  throw new Error(`the module ran but never defined globalThis.${NAMESPACE}`);
}

/**
 * The module's lifecycle, owned by one object so the shell can construct it
 * without loading it.
 */
export class BoundaryModule {
  readonly #paths: ModulePaths;
  readonly #listeners = new Set<(status: ModuleStatus) => void>();

  #status: ModuleStatus = "idle";
  #inFlight: Promise<Outcome<PlannerModule>> | null = null;
  #failure: Outcome<never> | null = null;

  constructor(paths: ModulePaths = DEFAULT_PATHS) {
    this.#paths = paths;
  }

  status(): ModuleStatus {
    return this.#status;
  }

  /** The failure that put this module in `failed`, if it is there. */
  failureOutcome(): Outcome<never> | null {
    return this.#failure;
  }

  /** Status changes, for a shell that wants to re-render on them. */
  subscribe(listener: (status: ModuleStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setStatus(status: ModuleStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }

  /**
   * Start the load if it has not started, and resolve when it is settled.
   *
   * Idempotent: concurrent callers share the one in-flight promise, so a
   * shell that asks three components for figures fetches one module.
   */
  ensureLoaded(): Promise<Outcome<PlannerModule>> {
    this.#inFlight ??= this.#load();
    return this.#inFlight;
  }

  async #load(): Promise<Outcome<PlannerModule>> {
    this.#setStatus("loading");

    let planner: PlannerModule;
    try {
      /*
       * Everything in this block is "the module failed to load" — the shim,
       * the binary, the instantiation, the namespace. SPEC-0005 REQ "Module
       * Loading" requires this to be reported distinctly from an artifact
       * that fails to validate, and the split is here: below this try, the
       * module is running and every failure is its own answer.
       */
      await loadScript(this.#paths.shim);

      const Go = (globalThis as { Go?: GoConstructor }).Go;
      if (!Go)
        throw new Error(`${this.#paths.shim} loaded but defined no Go constructor`);

      const go = new Go();
      const instance = await instantiate(this.#paths.wasm, go.importObject);

      /*
       * Deliberately not awaited. cmd/planner parks in `select {}` so this
       * promise never resolves; awaiting it would hang the load forever. The
       * catch is still attached, because a Go panic rejects it and an
       * unhandled rejection would surface as an unrelated console error.
       */
      void go.run(instance).catch(() => {
        this.#fail(failure("MODULE_LOAD_FAILED", "the Go runtime exited"));
      });

      planner = await awaitNamespace();
    } catch (cause) {
      return this.#fail(
        failure(
          "MODULE_LOAD_FAILED",
          `the planner module could not be loaded: ${describe(cause)}`,
        ),
      );
    }

    /*
     * The version check happens before the artifact is even fetched. A module
     * implementing a different contract may well accept the artifact and
     * return figures in a shape this view would misread, and "does not
     * consume the payload" has to mean the payload was never requested.
     */
    if (
      typeof planner.contractVersion === "string" &&
      planner.contractVersion !== EXPECTED_CONTRACT_VERSION
    ) {
      return this.#fail({
        kind: "version-mismatch",
        expected: EXPECTED_CONTRACT_VERSION,
        received: planner.contractVersion,
        message:
          `the module implements boundary contract ${planner.contractVersion}, ` +
          `and this view was built for ${EXPECTED_CONTRACT_VERSION}`,
      });
    }

    let artifact: string;
    try {
      const response = await fetch(this.#paths.artifact);
      if (!response.ok) throw new Error(`responded ${String(response.status)}`);
      artifact = await response.text();
    } catch (cause) {
      return this.#fail(
        failure(
          "ARTIFACT_FETCH_FAILED",
          `${this.#paths.artifact} could not be fetched: ${describe(cause)}`,
        ),
      );
    }

    /* From here the module is the authority: its code, not ours. */
    const loaded = decodeEnvelope(planner.load(artifact), () => true as const);
    if (loaded.kind !== "ok") return this.#fail(loaded);

    this.#setStatus("ready");
    return { kind: "ok", value: planner };
  }

  #fail(outcome: Outcome<never>): Outcome<never> {
    this.#failure = outcome;
    this.#setStatus("failed");
    return outcome;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
