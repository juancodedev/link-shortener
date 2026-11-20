import { useState, type FormEvent } from "react";
import { BulkModal } from "./BulkModal";
import { errorText } from "./load";
import { api } from "../api";

/**
 * THE CREATE CARD (dashboard-react T3b): the single-link form and the entry
 * point to bulk card stock.
 *
 * The ids and classes are the ones the dashboard's CSS and print rules were
 * written against (#create-form, #create-msg, #result, #short-url, .message,
 * .field-help, .short-url), so the card looks as it did server-rendered.
 */

type Message = { kind: "" | "success" | "error"; text: string };

/** What POST /api/links answers with (the fields the form reads). */
type Created = { short_url: string; original_url?: string | null };

export function CreateCard({ onCreated }: { onCreated: () => void }) {
  const [url, setUrl] = useState("");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [gated, setGated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message>({ kind: "", text: "" });
  /** The short URL on show, or null while there is none (or a new one is on its way). */
  const [shortUrl, setShortUrl] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg({ kind: "", text: "" });
    setShortUrl(null);

    try {
      // A blank slug means "generate one for me", so it is sent as undefined
      // (JSON drops the key) rather than as "".
      const slugValue = slug.trim();
      // A blank destination is OMITTED, not sent as "": that is what makes
      // card stock creatable from the form, stated at the boundary instead of
      // leaning on a server-side coercion.
      const urlValue = url.trim();

      const res = await api("POST", "/api/links", {
        ...(urlValue ? { original_url: urlValue } : {}),
        title: title || undefined,
        slug: slugValue || undefined,
        is_gated: gated,
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error || "Failed to create link");
      }

      const data = (await res.json()) as Created;
      setShortUrl(data.short_url);
      setUrl("");
      setTitle("");
      setSlug("");
      setGated(false);
      // A card and a link are different objects: "Link created!" for one that
      // has nowhere to point yet is a small lie the owner discovers when a
      // customer scans the sticker.
      setMsg({
        kind: "success",
        text: data.original_url
          ? "Link created! Copied to clipboard."
          : "Card created! Its QR opens a 'not configured' page until you add a destination.",
      });
      copyText(data.short_url);
      onCreated();
    } catch (err) {
      setMsg({ kind: "error", text: errorText(err) || "Error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>Create Short Link</h3>
      <form id="create-form" onSubmit={(e) => void submit(e)}>
        <label htmlFor="url">Destination URL</label>
        {/* NOT required. Card stock is manufactured before its destination
            exists: the owner creates the link, the designer prints the code
            as a QR, and the real URL is loaded later. `required` would block
            that in the browser while the API allows it. Leaving it blank is
            a deliberate act, so the help text says what it means. */}
        <input type="text" id="url" placeholder="example.com or https://..." value={url} onChange={(e) => setUrl(e.target.value)} />
        <p className="field-help">
          Leave empty to create a card first and add its destination later. Until you do, its QR opens a "not configured" page.
        </p>
        <label htmlFor="slug">Custom short code (optional)</label>
        {/* A printed sticker lives for months, so its code should be one the
            owner chose. The server owns the rules (src/utils/short-code.ts);
            the pattern only shows the shape before the error does. */}
        <input
          type="text"
          id="slug"
          placeholder="cafe-central"
          maxLength={32}
          pattern="[A-Za-z0-9_-]+"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
        <label htmlFor="title">Title (optional)</label>
        <input type="text" id="title" placeholder="My awesome link" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        {/* The review screen is opt-in: unchecked, a scan is a plain 302 to
            the destination; only checked links feed the satisfaction panel. */}
        <label className="check-row">
          <input type="checkbox" id="gated" checked={gated} onChange={(e) => setGated(e.target.checked)} />
          <span>Show the review screen before redirecting</span>
        </label>
        <p className="field-help">
          Off: the scan goes straight to the destination. On: customers see the star rating and can leave you a private comment.
          Only links with this on feed the satisfaction panel.
        </p>
        <button type="submit" disabled={busy}>
          {busy ? "Creating..." : "Shorten"}
        </button>
      </form>
      <div id="create-msg" className={msg.kind ? `message ${msg.kind}` : "message"}>
        {msg.text}
      </div>
      <div id="result" className="gap-top" style={{ display: shortUrl === null ? "none" : "" }}>
        <p className="caption">Your short link:</p>
        <input
          type="text"
          id="short-url"
          readOnly
          className="short-url"
          value={shortUrl ?? ""}
          onClick={(e) => {
            e.currentTarget.select();
            copyText(e.currentTarget.value);
          }}
        />
      </div>
      {/* Card stock is a different job from shortening a URL, so it gets its
          own entry point: an owner making a hundred stickers does not want a
          hundred submissions. */}
      <hr style={{ margin: "1.25rem 0", border: "none", borderTop: "1px solid var(--edge)" }} />
      <BulkModal onCreated={onCreated} />
    </div>
  );
}

/**
 * Best effort, never awaited: the link already exists, so a refused or
 * missing clipboard (an insecure origin has none) must not turn the success
 * into an error or skip the table reload.
 */
function copyText(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}
