import { useState } from "react";

import "./styles/reference.css";

/*
 * The scaffolding's only surface: a token and interaction-state reference.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0005 REQ "Token Discipline",
 * REQ "Component Styling Discipline"
 *
 * This is not the app shell — that is issue #60. It exists so the styling
 * primitives this story establishes are visible and clickable rather than
 * asserted, and so the selection-over-children case has something to show:
 * every card below carries an absolutely positioned badge, which is exactly
 * the arrangement an inset box-shadow ring would disappear behind.
 *
 * It carries no inline style. Every value comes from a class in
 * styles/reference.css, which in turn resolves through the token file.
 */

const BASES = [
  { id: 1, name: "Verdant Moon" },
  { id: 2, name: "Gasworks" },
  { id: 3, name: "Cobalt Flats" },
] as const;

export function App() {
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <main className="canvas reference">
      <h2>Token reference</h2>
      <p className="label">Interaction states</p>

      <div className="control-row reference-group">
        {BASES.map((base) => (
          <button
            key={base.id}
            type="button"
            aria-pressed={selected === base.id}
            data-selected={selected === base.id}
            onClick={() => {
              setSelected(selected === base.id ? null : base.id);
            }}
            className={`reference-card interactive selectable identity identity-${base.id}`}
          >
            {base.name}
            <span className="label reference-badge">Base {base.id}</span>
          </button>
        ))}
      </div>

      <div className="control-row">
        <button type="button" className="control control-primary interactive">
          Recompute
        </button>
        <button type="button" className="control interactive">
          Share
        </button>
      </div>

      <div className="control-row control-row-sm reference-group">
        {(["C", "B", "A", "S"] as const).map((grade) => (
          <button key={grade} type="button" className="control interactive">
            {grade}
          </button>
        ))}
      </div>
    </main>
  );
}
