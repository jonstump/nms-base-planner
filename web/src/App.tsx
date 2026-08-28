import { useMemo, type ReactNode } from "react";

import { BoundaryClient } from "./boundary";
import { AppShell } from "./shell/AppShell";

import "./styles/shell.css";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Module Loading"
 *
 * The client is constructed here and loaded nowhere. Constructing it fetches
 * nothing — the module is fetched the first time a surface actually asks for
 * a figure, which is what keeps first paint free of a four-megabyte binary.
 */
export function App(): ReactNode {
  const client = useMemo(() => new BoundaryClient(), []);
  return <AppShell client={client} />;
}
