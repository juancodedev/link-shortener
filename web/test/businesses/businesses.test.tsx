import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBranches, loadBranches, resetBranches } from "../../src/branches/store";
import { BusinessesSection } from "../../src/businesses/BusinessesSection";
import { provideLinksLoad } from "../../src/links/reload";
import { count, installApi, settle, type Call } from "../links/harness";
import { stubApiReady } from "../api-stub";

// The Businesses and branches card (odd/tasks/business-branches.md S3, and the
// moves and switches requested after PR #83), as the island draws it
// (dashboard-react T5). Ported from the Worker tests that compiled
// renderBusinesses, addBusiness, addBranch, moveBranch, setBusinessActive,
// setBranchActive and refreshOwnership out of the served HTML.

const XSS = '<img src=x onerror=alert(1)>';

const BUSINESSES = [
  { id: "biz-1", name: "Café Central", is_active: true },
  { id: "biz-2", name: "Sabores", is_active: true },
  { id: "biz-3", name: "Cerrado", is_active: false },
];
const BRANCHES = [
  { id: "loc-1", name: "Providencia", business_id: "biz-1", is_active: true, link_count: 3 },
  { id: "loc-2", name: "Vieja", business_id: "biz-1", is_active: false, link_count: 0 },
  { id: "loc-9", name: "Cards", business_id: null, is_active: true, link_count: 59 },
];

type Lists = { branches: unknown[]; businesses: unknown[] };
type Write = (method: string, path: string, body: unknown) => unknown;

/** GET the two lists from `lists`; every write goes to `write` (ok by default). */
function businessesApi(lists: Lists = { branches: BRANCHES, businesses: BUSINESSES }, write: Write = () => ({ ok: true })): Call[] {
  return installApi((method, path, body) => {
    if (method === "GET" && path === "/api/locations") return { locations: lists.branches };
    if (method === "GET" && path === "/api/businesses") return { businesses: lists.businesses };
    if (method === "GET") throw new Error(`unexpected ${method} ${path}`);
    return write(method, path, body);
  });
}

const el = (id: string) => document.getElementById(id) as HTMLElement;
const input = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;
const msg = () => el("businesses-msg");
const group = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".biz-group")].find((g) => g.querySelector(".biz-name")!.textContent!.startsWith(name))!;
const branchLine = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".biz-branch")].find((l) => l.querySelector("span")!.textContent!.startsWith(name))!;
const buttonIn = (root: Element, text: string) => {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
};
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

let reloads: ReturnType<typeof vi.fn<() => Promise<void>>>;
let stopLinks = () => {};
let errors: ReturnType<typeof vi.spyOn>;

async function mount() {
  const view = render(<BusinessesSection />);
  await act(async () => {
    await loadBranches();
  });
  await settle();
  return view;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    fireEvent.click(button);
  });
  await settle();
}

beforeEach(() => {
  resetBranches();
  stubApiReady(Promise.resolve());
  reloads = vi.fn(async () => {});
  stopLinks = provideLinksLoad(reloads);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  stopLinks();
  errors.mockRestore();
});

describe("Businesses island — the card", () => {
  it("shows Loading until the branches store has loaded", async () => {
    businessesApi();
    render(<BusinessesSection />);

    expect(el("businesses-card").querySelector("h3")!.textContent).toBe("Locales y sucursales");
    expect(el("businesses-body").textContent).toBe("Cargando…");
    expect(input("new-business-name").maxLength).toBe(120);
    expect(input("new-business-name").placeholder).toBe("p. ej. Café Central");
    expect(el("add-business").textContent).toBe("Agregar");
  });

  it("groups each branch under its business, with its link count and a field to add one more", async () => {
    businessesApi();
    await mount();

    const central = group("Café Central");
    expect([...central.querySelectorAll(".biz-branch")].map((l) => l.querySelector("span")!.textContent)).toEqual([
      "Providencia 3 enlaces ",
      "Vieja 0 enlaces Inactivo",
    ]);
    expect(input("new-branch-biz-1").placeholder).toBe("Nueva sucursal, p. ej. Providencia");
    expect(input("new-branch-biz-1").maxLength).toBe(120);
    expect(buttonIn(central, "Agregar")).toBeDefined();
  });

  it("says a business has no branches yet", async () => {
    businessesApi();
    await mount();

    expect(group("Sabores").querySelector(".biz-branches")!.textContent).toBe("Aún no hay sucursales.");
  });

  it("lists branches without a business separately, so they can be moved into one", async () => {
    businessesApi();
    await mount();

    const loose = group("Sin local");
    expect(loose.querySelector(".biz-branch")!.textContent).toContain("Cards");
    // Into any active business; there is no business to leave.
    expect([...input("move-loc-9").options].map((o) => [o.value, o.text])).toEqual([
      ["", "Mover a…"],
      ["biz-1", "Café Central"],
      ["biz-2", "Sabores"],
    ]);
    expect(input("new-branch-biz-3")).not.toBeNull();
    expect(loose.querySelector("input")).toBeNull();
  });

  it("lets a branch that has a business move to another active one, or to none", async () => {
    businessesApi();
    await mount();

    expect([...input("move-loc-1").options].map((o) => [o.value, o.text])).toEqual([
      ["", "Mover a…"],
      ["biz-2", "Sabores"],
      ["none", "Sin local"],
    ]);
  });

  it("offers Deactivate on active businesses and branches, Activate on inactive ones", async () => {
    businessesApi();
    await mount();

    expect(buttonIn(group("Café Central").querySelector(".biz-name")!, "Desactivar")).toBeDefined();
    expect(buttonIn(group("Cerrado").querySelector(".biz-name")!, "Activar")).toBeDefined();
    expect(group("Cerrado").querySelector(".biz-name .field-note")!.textContent).toBe("Inactivo");
    expect(group("Café Central").querySelector(".biz-name .field-note")).toBeNull();
    expect(buttonIn(branchLine("Providencia"), "Desactivar")).toBeDefined();
    expect(buttonIn(branchLine("Vieja"), "Activar")).toBeDefined();
  });

  it("renders business and branch names as text", async () => {
    businessesApi({
      businesses: [{ id: "biz-1", name: XSS, is_active: true }],
      branches: [{ id: "loc-1", name: XSS, business_id: "biz-1", link_count: 0 }],
    });
    await mount();

    expect(el("businesses-card").querySelector("img")).toBeNull();
    expect(el("businesses-body").textContent).toContain(XSS);
  });

  it("asks for the first business when there is none", async () => {
    businessesApi({ branches: [], businesses: [] });
    await mount();

    expect(el("businesses-body").textContent).toBe("Aún no hay locales. Agrega el primero arriba.");
  });

  it("says it could not load instead of drawing an empty card", async () => {
    installApi(() => {
      throw new Error("Error del servidor");
    });
    await mount();

    expect(el("businesses-body").textContent).toBe("No se pudieron cargar los locales.");
  });
});

describe("Businesses island — actions", () => {
  it("adds a trimmed business, empties the field, and reloads the branches and the Links table", async () => {
    const calls = businessesApi();
    await mount();

    fireEvent.change(input("new-business-name"), { target: { value: "  Nuevo  " } });
    await click(el("add-business") as HTMLButtonElement);

    expect(writes(calls)).toEqual([{ method: "POST", path: "/api/businesses", body: { name: "Nuevo" } }]);
    expect(input("new-business-name").value).toBe("");
    expect(count(calls, "GET", "/api/locations")).toBe(2);
    expect(count(calls, "GET", "/api/businesses")).toBe(2);
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a blank business name", async () => {
    const calls = businessesApi();
    await mount();

    fireEvent.change(input("new-business-name"), { target: { value: "   " } });
    await click(el("add-business") as HTMLButtonElement);

    expect(writes(calls)).toEqual([]);
    expect(reloads).not.toHaveBeenCalled();
  });

  it.each([
    ["the server's own error", new Response(JSON.stringify({ error: "Name taken" }), { status: 400 }), "Name taken"],
    ["a fallback when the body is not JSON", new Response("nope", { status: 500 }), "No se pudo agregar el local."],
  ])("shows %s when adding a business is refused, and keeps the name", async (_case, refusal, text) => {
    const calls = businessesApi(undefined, () => refusal);
    await mount();

    fireEvent.change(input("new-business-name"), { target: { value: "Nuevo" } });
    await click(el("add-business") as HTMLButtonElement);

    expect(msg().className).toBe("message error");
    expect(msg().textContent).toBe(text);
    expect(input("new-business-name").value).toBe("Nuevo");
    expect(count(calls, "GET", "/api/locations")).toBe(1);
    expect(reloads).not.toHaveBeenCalled();
  });

  it("shows the thrown error when the real api helper rejects the add", async () => {
    // The real API helper (web/src/api.ts) throws on any non-ok answer, with the server's error.
    businessesApi(undefined, () => {
      throw new Error("Name taken");
    });
    await mount();

    fireEvent.change(input("new-business-name"), { target: { value: "Nuevo" } });
    await click(el("add-business") as HTMLButtonElement);

    expect(msg().className).toBe("message error");
    expect(msg().textContent).toBe("Name taken");
  });

  it("adds a trimmed branch to its business, and reloads both", async () => {
    const calls = businessesApi();
    await mount();

    fireEvent.change(input("new-branch-biz-2"), { target: { value: " Ñuñoa " } });
    await click(buttonIn(group("Sabores"), "Agregar"));

    expect(writes(calls)).toEqual([{ method: "POST", path: "/api/locations", body: { name: "Ñuñoa", business_id: "biz-2" } }]);
    expect(count(calls, "GET", "/api/locations")).toBe(2);
    expect(reloads).toHaveBeenCalledTimes(1);
    // The card is drawn again from the reload, as the legacy innerHTML was.
    expect(input("new-branch-biz-2").value).toBe("");
  });

  it("sends nothing for a blank branch name, and says so when adding one is refused", async () => {
    const calls = businessesApi(undefined, () => new Response("{}", { status: 400 }));
    await mount();

    await click(buttonIn(group("Sabores"), "Agregar"));
    expect(writes(calls)).toEqual([]);

    fireEvent.change(input("new-branch-biz-2"), { target: { value: "Ñuñoa" } });
    await click(buttonIn(group("Sabores"), "Agregar"));
    expect(msg().className).toBe("message error");
    expect(msg().textContent).toBe("No se pudo agregar la sucursal.");
  });

  it("moves a branch to another business, or out of its own with null", async () => {
    const calls = businessesApi();
    await mount();

    fireEvent.change(input("move-loc-1"), { target: { value: "biz-2" } });
    await click(buttonIn(branchLine("Providencia"), "Mover"));
    fireEvent.change(input("move-loc-1"), { target: { value: "none" } });
    await click(buttonIn(branchLine("Providencia"), "Mover"));

    expect(writes(calls)).toEqual([
      { method: "PATCH", path: "/api/locations/loc-1", body: { business_id: "biz-2" } },
      { method: "PATCH", path: "/api/locations/loc-1", body: { business_id: null } },
    ]);
    expect(reloads).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when Move is pressed on Move to…", async () => {
    const calls = businessesApi();
    await mount();

    await click(buttonIn(branchLine("Providencia"), "Mover"));
    expect(writes(calls)).toEqual([]);
  });

  it("switches businesses and branches through PATCH, to the opposite of what they are", async () => {
    const calls = businessesApi();
    await mount();

    await click(buttonIn(group("Café Central").querySelector(".biz-name")!, "Desactivar"));
    await click(buttonIn(group("Cerrado").querySelector(".biz-name")!, "Activar"));
    await click(buttonIn(branchLine("Providencia"), "Desactivar"));
    await click(buttonIn(branchLine("Vieja"), "Activar"));

    expect(writes(calls)).toEqual([
      { method: "PATCH", path: "/api/businesses/biz-1", body: { is_active: false } },
      { method: "PATCH", path: "/api/businesses/biz-3", body: { is_active: true } },
      { method: "PATCH", path: "/api/locations/loc-1", body: { is_active: false } },
      { method: "PATCH", path: "/api/locations/loc-2", body: { is_active: true } },
    ]);
    expect(reloads).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["moving", () => buttonIn(branchLine("Providencia"), "Mover"), "No se pudo mover la sucursal."],
    ["switching a business", () => buttonIn(group("Café Central").querySelector(".biz-name")!, "Desactivar"), "No se pudo actualizar el local."],
    ["switching a branch", () => buttonIn(branchLine("Providencia"), "Desactivar"), "No se pudo actualizar la sucursal."],
  ])("says so when %s is refused, and reloads nothing", async (_case, target, text) => {
    const calls = businessesApi(undefined, () => new Response("{}", { status: 500 }));
    await mount();

    fireEvent.change(input("move-loc-1"), { target: { value: "biz-2" } });
    await click(target());

    expect(msg().className).toBe("message error");
    expect(msg().textContent).toBe(text);
    expect(count(calls, "GET", "/api/locations")).toBe(1);
    expect(reloads).not.toHaveBeenCalled();
  });

  it("clears an earlier error once an action succeeds", async () => {
    let refuse = true;
    businessesApi(undefined, () => (refuse ? new Response("{}", { status: 500 }) : { ok: true }));
    await mount();

    await click(buttonIn(branchLine("Providencia"), "Desactivar"));
    expect(msg().className).toBe("message error");

    refuse = false;
    await click(buttonIn(branchLine("Providencia"), "Desactivar"));
    expect(msg().className).toBe("message");
    expect(msg().textContent).toBe("");
  });

  it("redraws from the reloaded lists", async () => {
    const lists = { branches: BRANCHES, businesses: BUSINESSES };
    businessesApi(lists);
    await mount();

    lists.businesses = [...BUSINESSES, { id: "biz-4", name: "Nuevo", is_active: true }];
    fireEvent.change(input("new-business-name"), { target: { value: "Nuevo" } });
    await click(el("add-business") as HTMLButtonElement);

    expect(group("Nuevo")).toBeDefined();
    expect(getBranches().businesses).toHaveLength(4);
  });
});
