import { useCallback, useEffect, useRef, useState } from "react";
import { pickableBranches, useBranches, type Branch, type Business } from "../branches/store";
import { FeedbackInbox, type FeedbackInboxPayload } from "./FeedbackInbox";

/**
 * THE COMMENTS SECTION (dashboard-react T5): what customers wrote, filtered
 * by business or branch, and the same list as a CSV.
 *
 * The inbox loads once the auth bootstrap opens window.__apiReady, and again
 * only when the filter changes: the comments belong to the tenant, not to any
 * link row, so a table refresh does not touch them. It is its own load on
 * purpose: a failure here says so in this card and leaves the rest of the
 * dashboard working.
 *
 * The filter's options come from the branches store (../branches), the same
 * lists the Businesses card edits and the Links pickers read.
 */

/**
 * The comment filter as the API's query string. "b:<id>" is a business,
 * "l:<id>" a branch, "" everything. The list and the CSV read the same
 * value, so the export is always what is on screen.
 */
export function feedbackQuery(value: string): string {
  if (value.indexOf("b:") === 0) return "?business_id=" + encodeURIComponent(value.slice(2));
  if (value.indexOf("l:") === 0) return "?location_id=" + encodeURIComponent(value.slice(2));
  return "";
}

type FilterOption = { label: string; value: string };

/**
 * All, then each active business followed by its pickable branches, then the
 * pickable branches that belong to none. Switched-off ones stay out, as in
 * the Links pickers.
 */
function filterOptions(all: Branch[], businesses: Business[]): FilterOption[] {
  const branches = pickableBranches(all, businesses);
  const options: FilterOption[] = [{ label: "All businesses", value: "" }];
  businesses
    .filter((b) => b.is_active !== false)
    .forEach((b) => {
      options.push({ label: b.name, value: "b:" + b.id });
      branches.filter((l) => l.business_id === b.id).forEach((l) => options.push({ label: "— " + l.name, value: "l:" + l.id }));
    });
  branches.filter((l) => !l.business_id).forEach((l) => options.push({ label: l.name + " (no business)", value: "l:" + l.id }));
  return options;
}

type Inbox = { status: "loading" } | { status: "error" } | { status: "ready"; payload: FeedbackInboxPayload };
type Message = { kind: "" | "error" | "notice"; text: string };

export function CommentsSection() {
  const { branches, businesses } = useBranches();
  const [filter, setFilter] = useState("");
  const [inbox, setInbox] = useState<Inbox>({ status: "loading" });
  const [exporting, setExporting] = useState(false);
  const [msg, setMsg] = useState<Message>({ kind: "", text: "" });
  const seq = useRef(0);

  const options = filterOptions(branches, businesses);
  // The chosen business or branch no longer exists: fall back to all, which
  // reloads, or the list would stay filtered under an "All" label.
  const stale = !options.some((o) => o.value === filter);
  useEffect(() => {
    if (stale) setFilter("");
  }, [stale]);

  const load = useCallback(async (value: string) => {
    const mine = ++seq.current;
    if (window.__apiReady) await window.__apiReady;
    try {
      const res = await window.__api("GET", "/api/review-gate/feedback" + feedbackQuery(value));
      // Checked before the body is read as an inbox: a 401 or 500 is JSON
      // too, and rendering it would draw an empty inbox that looks like no
      // one wrote.
      if (!res.ok) throw new Error("feedback inbox: HTTP " + res.status);
      const payload = (await res.json()) as FeedbackInboxPayload;
      if (mine === seq.current) setInbox({ status: "ready", payload });
    } catch (err) {
      if (mine !== seq.current) return;
      setInbox({ status: "error" });
      console.error("feedback inbox failed to load", err);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  useEffect(
    () => () => {
      // Answers that land after unmounting are dropped.
      seq.current++;
    },
    [],
  );

  /**
   * The CSV export, downloaded through window.__api.
   *
   * Not a plain link: every tenant-scoped route authenticates with an
   * Authorization: Bearer header and picks the tenant with X-Tenant-Slug, and
   * a navigation carries neither — an href here would be a 401. So the file
   * is fetched with the same headers as every other call and handed to the
   * browser as a Blob.
   *
   * The server cannot say "truncated" inside the CSV without corrupting it,
   * so it says so in X-Truncated, and this says it to the owner.
   */
  async function exportCsv() {
    setExporting(true);
    setMsg({ kind: "", text: "" });
    try {
      const res = await window.__api("GET", "/api/review-gate/feedback.csv" + feedbackQuery(filter));
      // A refused export answers with a JSON error body. Read as a blob it
      // would download as customer-feedback.csv and look like a file, so the
      // status is checked first and the owner is told instead.
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        setMsg({ kind: "error", text: "Could not export: " + (body.detail || body.error || "HTTP " + res.status) });
        return;
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "customer-feedback.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on a delay: some browsers start the download after the click
      // handler returns, and an already-revoked URL cancels it.
      setTimeout(() => URL.revokeObjectURL(href), 10000);

      if (res.headers.get("X-Truncated") === "true") {
        setMsg({
          kind: "notice",
          text: "The file holds the newest " + (res.headers.get("X-Feedback-Limit") || "") + " comments; older ones were left out.",
        });
      }
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof Error ? err.message : "Could not export" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="card" id="feedback-card">
      <div className="feedback-head">
        <h3>What customers wrote</h3>
        <button type="button" id="feedback-export" className="btn-sm" disabled={exporting} onClick={() => void exportCsv()}>
          Download CSV
        </button>
      </div>
      <label htmlFor="feedback-filter" className="gap-top-sm">
        Show comments from
      </label>
      <select id="feedback-filter" value={stale ? "" : filter} onChange={(e) => setFilter(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div id="feedback-export-msg" className={"message" + (msg.kind ? " " + msg.kind : "")}>
        {msg.text}
      </div>
      <div id="feedback-body">
        {inbox.status === "loading" && <div className="loading">Loading...</div>}
        {inbox.status === "error" && <p className="gate-empty">Could not load comments.</p>}
        {inbox.status === "ready" && <FeedbackInbox payload={inbox.payload} />}
      </div>
    </div>
  );
}
