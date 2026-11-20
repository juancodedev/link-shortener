import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { reload } from "./navigate";

/** One location the user belongs to, as the API's 409 tenant_required lists it. */
export type TenantChoice = { slug: string; displayName?: string | null; role: string };

/** Display names for the membership roles (tenant_memberships.role); an unknown one is shown as sent. */
const ROLE_LABEL: Record<string, string> = { owner: "propietario", admin: "administrador", viewer: "lector" };
const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

function remembered(): string | null {
  try {
    return window.localStorage.getItem("tenant");
  } catch {
    return null;
  }
}

/**
 * The location bar. The role is shown beside each name because admin and
 * viewer mean different permissions: a switcher showing only names would let
 * someone pick a store they can see but not manage. Names, slugs and roles
 * come from the API, so they are JSX text and attribute values only.
 */
function TenantPicker({ available, current }: { available: TenantChoice[]; current: string | null }) {
  return (
    <div className="tenant-bar">
      <label htmlFor="tenant-select">Ubicación</label>
      <select
        id="tenant-select"
        defaultValue={current ?? undefined}
        onChange={(e) => {
          // Remembered so the reload names it and does not fall back to 409.
          try {
            window.localStorage.setItem("tenant", e.currentTarget.value);
          } catch {
            // Storage blocked: the reload will ask again.
          }
          reload();
        }}
      >
        {available.map((t) => (
          <option key={String(t.slug)} value={String(t.slug)}>
            {String(t.displayName || t.slug) + " (" + roleLabel(String(t.role)) + ")"}
          </option>
        ))}
      </select>
    </div>
  );
}

let root: Root | null = null;
let rootHost: HTMLElement | null = null;

/**
 * Shows the location picker at the top of the page (styled by .tenant-bar).
 * Called by the API helper on 409 tenant_required; a later call redraws the
 * same bar with the new list.
 */
export function showTenantPicker(available: TenantChoice[]): void {
  let host = document.getElementById("tenant-picker");
  if (!host) {
    host = document.createElement("div");
    host.id = "tenant-picker";
    document.body.insertBefore(host, document.body.firstChild);
  }
  if (!root || rootHost !== host) {
    root = createRoot(host);
    rootHost = host;
  }
  const view = root;
  // Synchronous, as the served picker was: the bar is on the page by the time
  // the API helper throws tenant_required. A key per list, so the remembered
  // choice preselects on every redraw.
  flushSync(() => {
    view.render(<TenantPicker key={available.map((t) => String(t.slug)).join("\n")} available={available} current={remembered()} />);
  });
  window.scrollTo(0, 0);
}
