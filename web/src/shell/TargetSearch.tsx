import { useId, useMemo, useRef, useState, type ReactNode } from "react";

import { matches, type CatalogueItem } from "../boundary";
import { StatusBadge } from "./StatusBadge";
import type { CatalogueState } from "./useCatalogue";

/*
 * Choosing what to build, by name.
 *
 * Governing: ADR-0004 (React view layer), ADR-0010 (places first and the
 * shell), SPEC-0011 REQ "Target Selection Is a Search Over Known Items",
 * Accessibility Requirements → Keyboard Navigation
 *
 * The control this replaces was a bare `<input>` whose value went to the
 * domain as an item id, so the only way to load anything was to already
 * know a string like `ULTRAPROD2`. That is the criterion this story is
 * measured by: "a player who has never seen an item id can reach any
 * selectable item".
 *
 * The list comes through the boundary and is held by the caller. Nothing
 * here reads the Tier 1 artifact and there is no item literal in this file
 * — SPEC-0011 forbids both, and `tests/shell/target-search.spec.ts` checks
 * the second mechanically, because a compiled-in copy is the shortcut that
 * works right up until the artifact changes.
 *
 * Filtering is local. SPEC-0011 § Rate Limiting: the search "MUST NOT issue
 * a catalogue call per keystroke", and the list cannot change while the
 * page is open.
 *
 * The name is primary and the id secondary, in that order in the DOM, so a
 * screen reader reads what a player recognises first.
 */

export interface TargetSearchProps {
  readonly catalogue: CatalogueState;
  /** The item id currently chosen, or "" when nothing is. */
  readonly value: string;
  readonly onSelect: (itemId: string) => void;
}

/** How many results to render. The real catalogue is thousands of items. */
const VISIBLE = 20;

export function TargetSearch({
  catalogue,
  value,
  onSelect,
}: TargetSearchProps): ReactNode {
  const inputId = useId();
  const listId = useId();
  const countId = useId();

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const items = catalogue.status === "ready" ? catalogue.items : [];
  const found = useMemo(() => matches(items, query), [items, query]);
  const shown = found.slice(0, VISIBLE);

  const choose = (item: CatalogueItem): void => {
    onSelect(item.id);
    setQuery(item.name);
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      /*
       * Dismiss without selecting, which SPEC-0011 names as one of the
       * three things the combobox must do by keyboard. The query is left
       * alone: clearing it would be a second, unasked-for effect.
       */
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (shown.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + shown.length) % shown.length);
      return;
    }
    if (event.key === "Enter" && open) {
      const item = shown[active];
      if (item) {
        event.preventDefault();
        choose(item);
      }
    }
  };

  if (catalogue.status === "loading") {
    /*
     * A pending state, not an error and not an empty search. SPEC-0011
     * requires the view "present a loading state and retry once readiness
     * resolves, rather than reporting an error" — an empty combobox would
     * be telling the player no item matches anything.
     */
    return (
      <div className="target-search">
        <span className="label">Target</span>{" "}
        <StatusBadge status="pending" detail="loading the item list" />
      </div>
    );
  }

  if (catalogue.status === "failed") {
    return (
      <div className="target-search">
        <span className="label">Target</span>{" "}
        <StatusBadge status="danger" detail={catalogue.reason} />
      </div>
    );
  }

  const activeId =
    shown[active] === undefined ? undefined : `${listId}-${String(active)}`;

  return (
    <div className="target-search">
      <label className="label" htmlFor={inputId}>
        Target
      </label>
      <input
        id={inputId}
        ref={inputRef}
        className="control"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-describedby={countId}
        {...(activeId === undefined ? {} : { "aria-activedescendant": activeId })}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />

      {/*
        The count, announced as it changes. SPEC-0011 Accessibility
        Requirements: "its result count is announced as it changes" — a
        sighted player watches the list shrink, and this is the same
        information for someone who cannot.
      */}
      <p id={countId} className="label" aria-live="polite">
        {found.length === 0
          ? "No items match"
          : `${String(found.length)} item${found.length === 1 ? "" : "s"} match${
              found.length === 1 ? "es" : ""
            }`}
        {found.length > VISIBLE ? `, showing ${String(VISIBLE)}` : ""}
      </p>

      {/*
        The listbox is always in the DOM and hidden when closed, because
        `aria-controls` on the input has to resolve to something — an
        idref pointing at nothing is an axe violation and, worse, tells a
        screen reader the combobox controls a region that is not there.

        Options are `<li role="option">`, not buttons. In the combobox
        pattern focus stays on the input and moves through
        `aria-activedescendant`; a focusable option would put a second tab
        stop per result in the shell's tab order, which is exactly what the
        "tab order follows visual layout" assertion notices.

        `onMouseDown` with preventDefault rather than `onClick`: a click on
        an option blurs the input first, which closes the list, and the
        click then lands on nothing.
      */}
      <ul
        id={listId}
        className="target-results"
        role="listbox"
        aria-label="Items"
        hidden={!open}
      >
        {shown.map((item, index) => (
          <li
            key={item.id}
            id={`${listId}-${String(index)}`}
            role="option"
            /*
             * The id as an attribute, not only as rendered text. A test
             * choosing "ANTIMATTER" by text also matches "Antimatter
             * Housing", which is a real item — so the selection was
             * ambiguous and silently resolved the wrong tree.
             */
            data-item-id={item.id}
            aria-selected={item.id === value}
            className={`target-result${index === active ? " target-result-active" : ""}`}
            onMouseDown={(event) => {
              event.preventDefault();
              choose(item);
            }}
          >
            {/* Name first, id second — what a player recognises leads. */}
            <span className="target-result-name">{item.name}</span>{" "}
            <span className="label target-result-id">{item.id}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
