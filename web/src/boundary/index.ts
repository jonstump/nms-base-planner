/*
 * The boundary's public surface.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Boundary Client"
 *
 * Components import from here and nowhere deeper. The module, the envelope
 * decoder and the graph decoder are implementation: a component that reached
 * for `decodeEnvelope` would be one refactor away from branching on a
 * message, which the requirement forbids.
 */

export { BoundaryClient, type Readiness } from "./client";
export {
  BoundaryModule,
  DEFAULT_PATHS,
  type ModulePaths,
  type ModuleStatus,
} from "./module";
export {
  EXPECTED_CONTRACT_VERSION,
  type FailureCode,
  type ModuleErrorCode,
} from "./contract";
export type { Outcome } from "./envelope";
export type { ResolvedEdge, ResolvedGraph, ResolvedNode } from "./graph";
export {
  EMPTY_PLAN,
  isEmptyPlan,
  validatePlan,
  type Plan,
  type PlanResult,
} from "./plan";
export { decodePlanFromHash, encodePlanToHash, type DecodedHash } from "./plan-hash";
export {
  asQuantity,
  formatQuantity,
  isIntegral,
  isQuantity,
  partsOf,
  unformatQuantity,
  type Quantity,
} from "./quantity";
