/*
 * A stand-in for the Go toolchain's wasm_exec.js.
 *
 * Governing: SPEC-0005 REQ "Module Loading", REQ "Boundary Client"
 *
 * The real module cannot be made to report the wrong contract version, fail
 * to validate its artifact, or answer NOT_READY on demand — those are the
 * branches SPEC-0005 requires the client to distinguish, and they are exactly
 * the ones a healthy module never takes.
 *
 * So this defines the same `globalThis.Go` interface the real shim does and
 * publishes a scripted namespace instead. It pairs with empty.wasm, a valid
 * eight-byte WebAssembly module with no imports and no exports: enough for
 * WebAssembly.instantiate to succeed, which is all the client requires of the
 * binary before it looks for the namespace.
 *
 * The script it plays comes from window.__fake, set by the test before the
 * load starts.
 */
globalThis.Go = class {
  constructor() {
    this.importObject = {};
  }

  async run() {
    const script = globalThis.__fake ?? {};

    if (script.neverPublish === true) return;

    const version = script.contractVersion ?? "1.4.0";
    let readyAfter = script.notReadyTimes ?? 0;

    const envelope = (body) => JSON.stringify({ contractVersion: version, ...body });
    const failure = (code, message) => envelope({ ok: false, error: { code, message } });

    globalThis.nmsPlanner = {
      contractVersion: version,
      load: () =>
        script.loadFails === true
          ? failure(
              "INVALID_ARTIFACT",
              "recipe refers to an item the artifact does not define",
            )
          : envelope({ ok: true, data: {} }),
      ready: () => envelope({ ok: true, data: {} }),
      resolve: () => {
        if (readyAfter > 0) {
          readyAfter -= 1;
          return failure("NOT_READY", "no artifact has been loaded");
        }
        return envelope({
          ok: true,
          data: {
            graph: {
              target: "ANTIMATTER",
              quantity: "1",
              gameVersion: "5.97",
              nodes: [
                {
                  itemId: "ASTEROID1",
                  name: "Silver",
                  total: "5/6",
                  method: "gather",
                  legalMethods: ["gather"],
                  terminal: true,
                  verified: true,
                },
              ],
            },
          },
        });
      },
      rollup: () => failure("MALFORMED_INPUT", "not scripted"),
      power: () => failure("MALFORMED_INPUT", "not scripted"),
      /*
       * The catalogue entry point exists on the fake for the same reason
       * the others do: the client calls it on mount now, and a fake missing
       * an entry point fails as "undefined is not a function" rather than
       * as whatever the test was actually about.
       */
      catalogue: () =>
        script.catalogue === undefined
          ? envelope({ ok: true, data: { catalogue: { items: [] } } })
          : script.catalogue(),
    };
  }
};
