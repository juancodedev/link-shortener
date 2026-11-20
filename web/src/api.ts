import { navigate } from "./shell/navigate";
import { showTenantPicker, type TenantChoice } from "./shell/tenant-picker";

/**
 * The dashboard's authenticated fetch, and the gate every island awaits before
 * its first request (odd/tasks/dashboard-react.md T6a). It used to be
 * window.__api / window.__apiReady, defined by an inline script in the served
 * shell; the contract is unchanged.
 *
 * The token is module state on purpose: no global carries it, so nothing else
 * on the page can read it off window.
 */

/**
 * Where each request gets its token. The auth bootstrap hands over the
 * session's getter, not a one-off string: Supabase refreshes the session in
 * the background, and a token read once at boot expired after about an hour
 * and sent the owner to /login mid-task (L19).
 */
type TokenSource = () => Promise<string | null>;

let token: TokenSource = async () => null;
let openGate: () => void = () => {};
const gate = new Promise<void>((resolve) => {
  openGate = resolve;
});

/**
 * Resolves once the auth bootstrap has a session and the helper below can
 * authenticate. Every island's first load parks here, so a load started while
 * getSession() is still in flight waits instead of failing. A visitor without
 * a session is sent to /login and the gate never opens: a load started there
 * could only fail.
 */
export function whenApiReady(): Promise<void> {
  return gate;
}

/**
 * Called by the auth bootstrap (./shell/auth) with the session's token getter
 * (a fixed string is accepted too); opens the gate.
 */
export function openApi(source: string | TokenSource): void {
  // Set before the gate opens, so every waiter wakes to a usable helper.
  token = typeof source === "string" ? async () => source : source;
  openGate();
}

/**
 * Which location a call is about. Resolved from the URL first so a shared
 * dashboard link opens the right store, then from the last choice. Absent for
 * a single-location user, who never sees the picker: one membership resolves
 * server-side with no header.
 */
function tenantSlug(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("tenant");
  if (fromUrl) return fromUrl;
  try {
    return window.localStorage.getItem("tenant");
  } catch {
    return null;
  }
}

/**
 * Authenticated fetch: Bearer token, X-Tenant-Slug, JSON body. Returns the
 * response when it is ok and THROWS otherwise, with the server's `error`
 * message when it sent one.
 */
export async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: "Bearer " + (await token()) };
  const slug = tenantSlug();
  if (slug) headers["X-Tenant-Slug"] = slug;

  // no-store, because the server already sends it, and because deleting a
  // link has to visibly remove its row. A GET that follows a mutation must
  // never be answered from a cache holding the list as it was BEFORE it.
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (res.status === 401) {
    navigate("/login");
    throw new Error("Unauthorized");
  }

  // Several locations and none chosen. The API refuses rather than guessing,
  // so the user has to choose. This is the only way a multi-store user ever
  // sees 409 tenant_required.
  if (res.ok) return res;

  // The body is read once and shared: a 409 that is not tenant_required (a
  // duplicate slug or business name) still reports the server's reason. The
  // served helper read it twice and always fell back to "Server error" (L19).
  let payload: { error?: unknown; available?: unknown } | null = null;
  try {
    payload = await res.json();
  } catch {
    // Not JSON: the fallback message below.
  }
  if (res.status === 409 && payload && payload.error === "tenant_required" && Array.isArray(payload.available)) {
    showTenantPicker(payload.available as TenantChoice[]);
    throw new Error("tenant_required");
  }
  throw new Error(payload && typeof payload.error === "string" && payload.error ? payload.error : "Server error");
}
