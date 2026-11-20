import { useState } from "react";
import { loadBranches, useBranches, type Branch, type Business } from "../branches/store";
import { reloadLinks } from "../links/reload";

/**
 * THE BUSINESSES SECTION (dashboard-react T5): businesses and branches.
 *
 * A business ("local") groups one or more branches ("sucursales"), and each
 * link belongs to a branch. Operator-only: the businesses never see this.
 * Every comment and rating is then traceable to business, branch and link
 * (odd/tasks/business-branches.md).
 *
 * The lists live in the branches store (../branches), which the Links
 * pickers and the Comments filter read too. Every successful action reloads
 * the store and the Links table, because both show business and branch
 * names. The card is drawn from scratch after each load (keyed on the store's
 * version), as the legacy innerHTML was: a reload empties the add-branch
 * fields and resets the move pickers.
 *
 * Names are typed by a person, so they are JSX text, never markup.
 */

type Message = { kind: "" | "error"; text: string };

/** Reloads everything that shows a business or branch name. */
function refreshOwnership() {
  void loadBranches();
  void reloadLinks();
}

/**
 * The server's message from a refused write: a non-ok answer's `error`, or
 * the message the real window.__api throws with (it throws on any non-ok
 * status, carrying that same `error`).
 */
async function refusal(res: Response | null, err: unknown): Promise<string> {
  if (res) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error || "";
  }
  return err instanceof Error ? err.message : "";
}

export function BusinessesSection() {
  const { status, branches, businesses, version } = useBranches();
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<Message>({ kind: "", text: "" });

  const fail = (text: string) => setMsg({ kind: "error", text });
  const succeed = () => {
    setMsg({ kind: "", text: "" });
    refreshOwnership();
  };

  /**
   * One write. `onRefused` gets the server's message ("" when it has none);
   * a write the server agreed to clears the message and refreshes.
   */
  async function write(method: string, path: string, body: unknown, onRefused: (server: string) => void): Promise<boolean> {
    let res: Response;
    try {
      res = await window.__api(method, path, body);
    } catch (err) {
      onRefused(await refusal(null, err));
      return false;
    }
    if (!res.ok) {
      onRefused(await refusal(res, null));
      return false;
    }
    succeed();
    return true;
  }

  async function addBusiness() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const ok = await write("POST", "/api/businesses", { name: trimmed }, (server) => fail(server || "Could not add the business."));
    if (ok) setName("");
  }

  const actions: CardActions = {
    addBranch: (businessId, branchName) => {
      const trimmed = branchName.trim();
      if (!trimmed) return;
      void write("POST", "/api/locations", { name: trimmed, business_id: businessId }, (server) => fail(server || "Could not add the branch."));
    },
    moveBranch: (locationId, value) => {
      if (value === "") return;
      // "none" takes the branch out of its business.
      void write("PATCH", "/api/locations/" + encodeURIComponent(locationId), { business_id: value === "none" ? null : value }, () =>
        fail("Could not move the branch."),
      );
    },
    setBusinessActive: (businessId, isActive) => {
      void write("PATCH", "/api/businesses/" + encodeURIComponent(businessId), { is_active: isActive }, () =>
        fail("Could not update the business."),
      );
    },
    setBranchActive: (locationId, isActive) => {
      void write("PATCH", "/api/locations/" + encodeURIComponent(locationId), { is_active: isActive }, () =>
        fail("Could not update the branch."),
      );
    },
  };

  return (
    <div className="card" id="businesses-card">
      <h3>Businesses and branches</h3>
      <label htmlFor="new-business-name">New business</label>
      <div className="field-row">
        <input
          type="text"
          id="new-business-name"
          maxLength={120}
          placeholder="e.g. Café Central"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="button" id="add-business" className="btn-sm btn-primary" onClick={() => void addBusiness()}>
          Add
        </button>
      </div>
      <div id="businesses-msg" className={"message" + (msg.kind ? " " + msg.kind : "")}>
        {msg.text}
      </div>
      <div id="businesses-body" className="gap-top">
        {status === "loading" && <div className="loading">Loading...</div>}
        {status === "error" && <p className="gate-empty">Could not load businesses.</p>}
        {status === "ready" && <Groups key={version} businesses={businesses} branches={branches} actions={actions} />}
      </div>
    </div>
  );
}

type CardActions = {
  addBranch: (businessId: string, name: string) => void;
  moveBranch: (locationId: string, value: string) => void;
  setBusinessActive: (businessId: string, isActive: boolean) => void;
  setBranchActive: (locationId: string, isActive: boolean) => void;
};

const InactiveNote = () => <span className="field-note">Inactive</span>;

/** Activate on an inactive record, Deactivate on an active one: the button asks for the opposite. */
function Toggle({ isActive, onToggle }: { isActive: boolean; onToggle: (next: boolean) => void }) {
  return (
    <button type="button" className="btn-sm btn-outline" onClick={() => onToggle(!isActive)}>
      {isActive ? "Deactivate" : "Activate"}
    </button>
  );
}

/**
 * Each business with its branches, then the branches that belong to none.
 * Every business is listed, switched off or not, so an inactive one can be
 * switched back on.
 */
function Groups({ businesses, branches, actions }: { businesses: Business[]; branches: Branch[]; actions: CardActions }) {
  const active = businesses.filter((b) => b.is_active !== false);
  const loose = branches.filter((l) => !l.business_id);

  if (businesses.length === 0 && loose.length === 0) {
    return <p className="field-note">No businesses yet. Add the first one above.</p>;
  }

  return (
    <>
      {businesses.map((b) => (
        <BusinessGroup key={b.id} business={b} own={branches.filter((l) => l.business_id === b.id)} active={active} actions={actions} />
      ))}
      {loose.length > 0 && (
        <div className="biz-group">
          <div className="biz-name">Not in a business</div>
          <ul className="biz-branches">
            {loose.map((l) => (
              <BranchLine key={l.id} branch={l} active={active} actions={actions} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function BusinessGroup({ business: b, own, active, actions }: { business: Business; own: Branch[]; active: Business[]; actions: CardActions }) {
  const [branchName, setBranchName] = useState("");
  const isActive = b.is_active !== false;
  return (
    <div className="biz-group">
      <div className="biz-name">
        {b.name} {isActive ? null : <InactiveNote />}
        <Toggle isActive={isActive} onToggle={(next) => actions.setBusinessActive(b.id, next)} />
      </div>
      <ul className="biz-branches">
        {own.length ? (
          own.map((l) => <BranchLine key={l.id} branch={l} active={active} actions={actions} />)
        ) : (
          <li className="field-note">No branches yet.</li>
        )}
      </ul>
      <div className="field-row">
        <input
          type="text"
          id={`new-branch-${b.id}`}
          maxLength={120}
          placeholder="New branch, e.g. Providencia"
          value={branchName}
          onChange={(e) => setBranchName(e.target.value)}
        />
        <button type="button" className="btn-sm btn-outline" onClick={() => actions.addBranch(b.id, branchName)}>
          Add
        </button>
      </div>
    </div>
  );
}

/** One branch. Every branch can move: to another active business, or out of its own. */
function BranchLine({ branch: l, active, actions }: { branch: Branch; active: Business[]; actions: CardActions }) {
  const [target, setTarget] = useState("");
  const isActive = l.is_active !== false;
  return (
    <li className="biz-branch">
      <span>
        {l.name} <span className="field-note">{l.link_count ?? ""} links</span> {isActive ? null : <InactiveNote />}
      </span>
      <span className="field-row">
        <select id={`move-${l.id}`} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Move to…</option>
          {active
            .filter((b) => b.id !== l.business_id)
            .map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          {l.business_id ? <option value="none">No business</option> : null}
        </select>
        <button type="button" className="btn-sm btn-outline" onClick={() => actions.moveBranch(l.id, target)}>
          Move
        </button>
        <Toggle isActive={isActive} onToggle={(next) => actions.setBranchActive(l.id, next)} />
      </span>
    </li>
  );
}
