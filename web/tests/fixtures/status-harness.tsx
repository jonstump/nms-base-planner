/*
 * Renders every status through the real component.
 *
 * Governing: SPEC-0005 Accessibility Requirements — "Colour MUST NOT be the
 * sole carrier of any distinction."
 *
 * The shell can only reach two of the five statuses by driving its controls,
 * so a test that walks the running app checks two and infers three. This
 * mounts StatusBadge once per member of its own exported table, so the
 * assertion covers every state the component can produce and a status added
 * without a glyph and a word fails rather than going unvisited.
 *
 * It renders the real component, not a copy. A fixture that reimplemented the
 * badge would pass against a component that had stopped rendering its word.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { StatusBadge, STATUSES } from "../../src/shell/StatusBadge";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/shell.css";

const root = document.getElementById("root");
if (!root) throw new Error("status.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <ul>
      {STATUSES.map((status) => (
        <li key={status} data-status={status}>
          <StatusBadge status={status} />
        </li>
      ))}
    </ul>
  </StrictMode>,
);

document.body.dataset["statusCount"] = String(STATUSES.length);
