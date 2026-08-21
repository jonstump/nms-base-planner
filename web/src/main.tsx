// Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Token Discipline"
//
// tokens.css is imported before every other stylesheet so a custom property
// is always defined by the time a rule references it.
import "./styles/tokens.css";
import "./styles/base.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

const root = document.getElementById("root");
if (!root) {
  throw new Error("index.html is missing the #root mount point");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
