import { useEffect, useState } from "react";
import { api, whenApiReady } from "../api";

/**
 * THE SETTINGS SECTION (dashboard-react T5): where feedback should go.
 *
 * A card's QR leads to the review gate. A customer can leave a private
 * comment there, and it lands in analytics.tag_feedback and shows up in the
 * Comments section. The owner can also record here where that should be
 * delivered.
 *
 * IT DOES NOT SEND ANYTHING YET. The address is stored, shown and exported
 * into the print sheet's CSV, and nothing is emailed from it. That is the
 * honest state of this field, and the help text says so, because a green
 * dashboard implying "reviews are being emailed" is worse than no field at
 * all: an owner would stop checking the comments.
 *
 * The address belongs to the tenant, not to any link row, so it is read once
 * when the section mounts, never with a table reload.
 */

type Message = { kind: "" | "success" | "error"; text: string };

export function SettingsSection() {
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<Message>({ kind: "", text: "" });

  useEffect(() => {
    let live = true;
    void (async () => {
      await whenApiReady();
      try {
        const res = await api("GET", "/api/tenant/feedback-email");
        const body = (await res.json()) as { feedback_email?: unknown };
        if (live && typeof body.feedback_email === "string") setEmail(body.feedback_email);
      } catch {
        // A tenant that cannot read its own setting still gets a working
        // dashboard; the field just stays empty rather than blocking the page.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    setMsg({ kind: "", text: "" });
    try {
      const res = await api("PUT", "/api/tenant/feedback-email", { feedback_email: email });
      // Only say "saved" when the server agreed. A confirmation that lies is
      // worse than no confirmation: the owner walks away believing an
      // address is recorded that is not.
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        setMsg({ kind: "error", text: body.detail || body.error || "Could not save" });
        return;
      }
      setMsg({ kind: "success", text: "Saved." });
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof Error ? err.message : "Error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" id="feedback-email-card">
      <h3>Feedback email</h3>
      <p className="field-help">
        Where you would like private customer comments delivered. Stored now; nothing is emailed yet — comments still arrive in the
        Comments section.
      </p>
      <label htmlFor="feedback-email">Email address</label>
      <input
        type="email"
        id="feedback-email"
        placeholder="you@yourbusiness.com"
        autoComplete="email"
        maxLength={254}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <div id="feedback-email-msg" className={"message" + (msg.kind ? " " + msg.kind : "")}>
        {msg.text}
      </div>
      <button type="button" id="feedback-email-save" className="btn-sm btn-primary gap-top-sm" disabled={saving} onClick={() => void save()}>
        Save
      </button>
    </div>
  );
}
