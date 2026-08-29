import { useCallback, useId, useState, type ReactNode } from "react";

import { Popover } from "../a11y/Popover";
import { useLiveRegion } from "../a11y/useLiveRegion";
import type { StoredData } from "../state/useStoredData";

/*
 * What the player is told about their data, and what they can do about it.
 *
 * Governing: ADR-0008 (durable user data, local-first), SPEC-0009 REQ
 * "Deletion Is a First-Class Operation", REQ "Storage Is Evictable and the
 * Application Must Not Imply Otherwise", REQ "Screenshots Are Local-Only"
 *
 * ADR-0002 banked "needs no upload endpoint, retention policy, or deletion
 * story" as a benefit of holding nothing. This spends the third of those
 * the moment the first byte is written: once data is held, the player is
 * owed a way to remove it that is not browser developer tools.
 *
 * The wording below is load-bearing and is checked mechanically by
 * tests/helpers/claim-checks.ts. Browsers evict origin storage under
 * pressure, private windows discard it on close, and until an account
 * exists there is no recovery path — so "saved" on its own is a stronger
 * claim than the storage makes, and "backed up" or "synced" would be false.
 * There is no technical mitigation at stage 1; being accurate about the
 * scope IS the mitigation, which is why this is a labelling requirement.
 *
 * No share or upload control appears here, and that is a requirement rather
 * than an omission. ADR-0008 excluded blobs on measured grounds — one
 * capture is 1.5-3 MB against 596 KB for a 200-place text workspace — and
 * deferred them to ADR-0013. Until that decision exists there is nowhere
 * for an image to go, so there is no control to send it there.
 */
export function DataCustody({ data }: { readonly data: StoredData }): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const headingId = useId();
  const { announce } = useLiveRegion();

  const close = useCallback(() => {
    setConfirming(false);
  }, []);

  const confirm = useCallback(() => {
    setDeleting(true);
    void data.deleteEverything().finally(() => {
      setDeleting(false);
      setConfirming(false);
      announce("Stored data deleted. Nothing is saved on this device.");
    });
  }, [data, announce]);

  return (
    <>
      <p className="label">
        Kept on this device, in this browser. Clearing site data removes it, and a browser
        short of space can remove it on its own.
      </p>

      <button
        type="button"
        className="control control-sm interactive"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Delete stored data
      </button>

      {/*
        The shell's Popover, not a bespoke dialog. Its focus trap restores
        focus in the effect cleanup, so Escape, the backdrop and the close
        control all converge on the same line — a dialog written here would
        have to reimplement that, and would get one of the three routes
        wrong. SPEC-0009's criterion names #82's trap for exactly this.
      */}
      <Popover open={confirming} onClose={close} labelledBy={headingId}>
        <h3 id={headingId}>Delete stored data?</h3>
        <p className="label">
          This removes every place kept on this device, and the display settings stored
          with them. It cannot be undone.
        </p>
        <button
          type="button"
          className="control control-primary interactive"
          disabled={deleting}
          onClick={confirm}
        >
          {deleting ? "Deleting" : "Delete everything"}
        </button>
      </Popover>
    </>
  );
}
