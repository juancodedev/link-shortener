import { useState } from "react";
import { errorText, type Link } from "./load";
import { api } from "../api";

/**
 * MANUFACTURING CARD STOCK IN BULK (dashboard-react T3b).
 *
 * The "Create cards in bulk..." button and the modal it opens. The cards are
 * created WITHOUT a destination, which is the state the whole flow depends on:
 * the QR goes on the card now and the URL is loaded later, when it is settled.
 *
 * The modal asks for a count, one label for the batch and the review-screen
 * choice, nothing else: every other field on a link is per-card by nature and
 * stays editable on the row.
 *
 * It renders as a fixed overlay (.qr-modal), so where it sits in the DOM does
 * not change what the owner sees, and the print CSS hides it.
 */

type Message = { kind: "" | "success" | "error"; text: string };

/** One item of the POST /api/links/batch answer. */
type BatchResult = { status: number; link?: Link; error?: string };

export function BulkModal({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  // The fields keep their values between openings, as the server-rendered
  // inputs did; only the result of the last run is dropped.
  const [count, setCount] = useState("10");
  const [label, setLabel] = useState("");
  const [gated, setGated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message>({ kind: "", text: "" });
  /** The summary of the last run, or null while there is none to show. */
  const [summary, setSummary] = useState<string | null>(null);
  // The ids the sheet is built from: only the cards that were really created.
  const [ids, setIds] = useState<string[]>([]);

  function openModal() {
    setIds([]);
    setSummary(null);
    setMsg({ kind: "", text: "" });
    setOpen(true);
  }

  async function create() {
    const n = parseInt(count, 10);
    // Validated here as well as on the server: the server is what makes it
    // safe, but a button that waits ten seconds to refuse a 0 teaches the
    // owner the button is broken.
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      setMsg({ kind: "error", text: "Enter a number between 1 and 200." });
      return;
    }

    setBusy(true);
    setMsg({ kind: "", text: "" });

    try {
      // ONE label for the whole run: the question is "where does this batch
      // go", not ten separate identities. A blank one is no label at all,
      // never ten cards carrying an empty identifier.
      const ref = label.trim();
      const links = Array.from({ length: n }, () => ({
        is_gated: gated,
        ...(ref ? { client_ref: ref } : {}),
      }));
      const res = await api("POST", "/api/links/batch", { links });

      const body = (await res.json()) as { results?: BatchResult[]; error?: string };
      // A partial batch is reported, never treated as success: nine of ten
      // cards is a shortfall the owner discovers at the printer.
      const results = body.results || [];
      const created = results.filter((r) => r.status === 201);
      if (!res.ok && !created.length) throw new Error(body.error || "Could not create the cards");

      setIds(created.map((r) => r.link!.id));
      const failed = results.length - created.length;
      setSummary(
        created.length + (created.length === 1 ? " card created. " : " cards created. ") + (failed ? failed + " failed — try those again." : ""),
      );
      setMsg({ kind: failed ? "error" : "success", text: "" });
      onCreated();
    } catch (err) {
      setMsg({ kind: "error", text: errorText(err) || "Error" });
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!ids.length) {
      setMsg({ kind: "error", text: "Create the cards first." });
      return;
    }

    try {
      // Through api(), never a hand-rolled fetch: an earlier version read the
      // token from the wrong place and the sheet 401'd after the cards had
      // been created. api() returns the response, so the blob comes through
      // unchanged, with the 401 redirect and the tenant picker included.
      const res = await api("POST", "/api/links/qr-sheet.zip", { link_ids: ids });

      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "cards.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // The click already handed the download to the browser; a live object
      // URL would pin the whole ZIP in memory for the life of the tab.
      URL.revokeObjectURL(href);
    } catch (err) {
      setMsg({ kind: "error", text: errorText(err) || "Error" });
    }
  }

  return (
    <>
      <button type="button" id="open-bulk" className="btn-sm btn-outline" onClick={openModal}>
        Create cards in bulk...
      </button>
      <div id="bulk-modal" className={open ? "qr-modal" : "qr-modal hidden"} onClick={() => setOpen(false)}>
        <div className="qr-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "26rem" }}>
          <h3 className="qr-title">Create cards in bulk</h3>
          <p className="field-help">
            Each card gets its own QR and no destination yet. Print them, and load the real URL whenever it is settled — until then,
            scanning a card opens a "not configured" page rather than a broken link.
          </p>
          <label htmlFor="bulk-count">How many cards</label>
          <input type="number" id="bulk-count" min="1" max="200" step="1" value={count} onChange={(e) => setCount(e.target.value)} />
          <label htmlFor="bulk-label" className="gap-top-sm">
            Label for this batch <span className="field-note">(optional)</span>
          </label>
          <input
            type="text"
            id="bulk-label"
            maxLength={200}
            placeholder="e.g. Main room — tables 1 to 10"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <label className="check-row gap-top-sm">
            <input type="checkbox" id="bulk-gated" checked={gated} onChange={(e) => setGated(e.target.checked)} />
            <span>Show the review screen before redirecting</span>
          </label>
          <p className="field-help">
            Off: once a destination is loaded, scans go straight to it. On: customers see the star rating and can leave a private
            comment — and only these cards feed the satisfaction panel. Changeable per card later.
          </p>
          <p className="field-help">
            Printed under the code on every card, and written to the sheet's CSV, so the designer knows which sticker is which before
            cutting. One field for the whole batch beats typing it ten times.
          </p>
          <div id="bulk-msg" className={msg.kind ? `message ${msg.kind}` : "message"}>
            {msg.text}
          </div>
          <div id="bulk-result" style={{ display: summary === null ? "none" : "" }}>
            <p className="caption" id="bulk-summary">
              {summary}
            </p>
            <button type="button" id="bulk-download" className="btn-sm btn-primary gap-top-sm" onClick={() => void download()}>
              Download print sheet (.zip)
            </button>
            <p className="field-help">One SVG per card plus a links.csv listing them. The cards go straight to your designer.</p>
          </div>
          <div className="gap-top-sm" style={{ display: "flex", gap: ".5rem" }}>
            <button type="button" id="bulk-create" className="btn-sm btn-primary" disabled={busy} onClick={() => void create()}>
              {busy ? "Creating..." : "Create them"}
            </button>
            <button type="button" className="btn-sm gap-top-sm" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
