import { useCallback, type ReactNode, type RefObject } from "react";

import { useFocusTrap } from "./useFocusTrap";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 Accessibility
 * Requirements
 *
 * Three ways to close, one way to restore focus.
 *
 * Escape, the backdrop and the close control all do the same thing: call
 * `onClose`. None of them touches focus. The restore happens in
 * useFocusTrap's cleanup when `open` goes false, so the three routes cannot
 * disagree — and a fourth added later inherits the behaviour by doing
 * nothing special.
 */

export interface PopoverProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly labelledBy: string;
  readonly children: ReactNode;
  readonly id?: string;
}

export function Popover({
  open,
  onClose,
  labelledBy,
  children,
  id,
}: PopoverProps): ReactNode {
  const container = useFocusTrap(open, { onEscape: onClose });

  const onBackdrop = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <>
      {/*
        A button rather than a div: a backdrop that dismisses is an
        interactive control, and one that only responds to a mouse leaves a
        keyboard user unable to do what a mouse user can. aria-hidden and
        tabIndex -1 keep it out of the trap's tab cycle, where it would be a
        stop that reads as nothing.
      */}
      <button
        type="button"
        className="popover-backdrop"
        aria-label="Close"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onBackdrop}
      />
      <div
        id={id}
        ref={container as RefObject<HTMLDivElement | null>}
        className="popover panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
        <button
          type="button"
          className="control control-sm interactive"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </>
  );
}
