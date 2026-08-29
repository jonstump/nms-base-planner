/*
 * The store's public surface.
 *
 * Governing: ADR-0008 (durable user data), SPEC-0009
 *
 * Consumers import from here. `durable-store.ts` internals — the request
 * promisifiers, the store names, the record validator — are implementation.
 */

export { DurableStore, type StoreOptions } from "./durable-store";
export {
  STORE_CODES,
  type StoreCode,
  type StoreFailure,
  type StoreResult,
} from "./errors";
export { MAX_PLACE_BYTES, MEASURED_PLACE_BYTES, serializedBytes } from "./limits";
export {
  emptyWorkspace,
  isPlaceKind,
  PLACE_KINDS,
  SCHEMA_VERSION,
  type PlaceKind,
  type PlaceRecord,
  type Workspace,
  type WorkspaceRecord,
} from "./schema";
