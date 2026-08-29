import type { ReactNode } from "react";

import { formatQuantity } from "../boundary";

import type { BuildItem } from "./build-items";

/*
 * Everything to construct at this base.
 *
 * Governing: ADR-0004 (React view layer), SPEC-0007 REQ "Build Rollup
 * Footer", SPEC-0005 Accessibility Requirements
 *
 * Each row carries `data-from`, the id of the section row it was collected
 * out of, so "every footer item corresponds to a row above it" is asserted by
 * comparison rather than by eye. An item the footer invented would have a
 * `data-from` matching nothing.
 *
 * Pending and unbuilt are distinguished by a word, not by a tint. A player
 * who cannot see the tint still needs to know which items are waiting on a
 * decision and which are only waiting on them.
 *
 * There is no completion fraction and no progress bar. The v2 prototype has
 * both; they need durable per-base state that does not exist, and a fraction
 * computed against session state would be a figure the card made up.
 */

const STATE_WORD: Record<BuildItem["state"], string> = {
  unbuilt: "to build",
  pending: "pending — power deficit",
};

export function BuildFooter({ items }: { items: readonly BuildItem[] }): ReactNode {
  if (items.length === 0) return null;

  return (
    <section className="card-section card-footer" data-section="build-rollup">
      <h4 className="card-section-head">To build</h4>
      <ul className="card-rows">
        {items.map((item) => (
          <li
            className="card-row"
            key={`${item.from}:${item.label}`}
            data-build-item={item.label}
            data-from={item.from}
            data-state={item.state}
          >
            <span className="card-row-name">{item.label}</span>
            <span className="card-row-figures">
              <span className="card-figure-value mono">{formatQuantity(item.count)}</span>
              <span className="card-build-state">{STATE_WORD[item.state]}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
