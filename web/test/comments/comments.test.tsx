import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBranches, resetBranches } from "../../src/branches/store";
import { CommentsSection, feedbackQuery } from "../../src/comments/CommentsSection";
import { count, gate, installApi, provideBranches, settle, type Call } from "../links/harness";

// The Comments section (dashboard-react T5): the feedback inbox, its business
// and branch filter, and the CSV export. Ported from the Worker tests of the
// legacy loadFeedbackInbox, feedbackQuery, fillFeedbackFilter and
// exportFeedbackCsv ("the feedback inbox", "comments can be filtered by
// business or branch", "the feedback export / inbox, when the server
// refuses", and the comments-filter half of "inactive ones leave the
// pickers").

const INBOX = {
  feedback: [
    {
      id: "fb-1",
      comment: "The soup was cold",
      rating: 2,
      customer_contact: null,
      customer_phone: null,
      scanned_at: "2026-10-14T20:15:00.000Z",
      short_code: "abc123",
      client_ref: null,
      location_name: "Terraza",
      business_name: "Sabores",
    },
  ],
  truncated: false,
  limit: 100,
};

const BUSINESSES = [
  { id: "biz-1", name: "Café Central", is_active: true },
  { id: "biz-2", name: "Sabores", is_active: true },
  { id: "biz-3", name: "Cerrado", is_active: false },
];
const BRANCHES = [
  { id: "loc-1", name: "Providencia", business_id: "biz-1", is_active: true },
  { id: "loc-2", name: "Vieja", business_id: "biz-1", is_active: false },
  { id: "loc-3", name: "Centro", business_id: "biz-3", is_active: true },
  { id: "loc-4", name: "Suelta", business_id: null, is_active: true },
  { id: "loc-5", name: "Apagada", business_id: null, is_active: false },
];

type Routes = {
  inbox?: (path: string) => unknown;
  csv?: (path: string) => unknown;
  /** What the branches store reloads from; read at each request. */
  lists?: { branches: unknown[]; businesses: unknown[] };
};

function commentsApi(routes: Routes = {}): Call[] {
  return installApi((method, path) => {
    if (method === "GET" && path === "/api/locations") return { locations: routes.lists?.branches ?? [] };
    if (method === "GET" && path === "/api/businesses") return { businesses: routes.lists?.businesses ?? [] };
    if (method === "GET" && path.startsWith("/api/review-gate/feedback.csv")) {
      return routes.csv ? routes.csv(path) : new Response("a,b\n", { status: 200, headers: { "Content-Type": "text/csv" } });
    }
    if (method === "GET" && path.startsWith("/api/review-gate/feedback")) return routes.inbox ? routes.inbox(path) : INBOX;
    throw new Error(`unexpected ${method} ${path}`);
  });
}

const el = (id: string) => document.getElementById(id) as HTMLElement;
const filter = () => el("feedback-filter") as HTMLSelectElement;
const exportButton = () => el("feedback-export") as HTMLButtonElement;
const exportMsg = () => el("feedback-export-msg");
/** The inbox and export requests, leaving the branches reloads out. */
const paths = (calls: Call[]) => calls.map((c) => c.path).filter((p) => p.startsWith("/api/review-gate/"));

async function mount() {
  const view = render(<CommentsSection />);
  await settle();
  return view;
}

let errors: ReturnType<typeof vi.spyOn>;
let downloads: { href: string; download: string }[];
let created: ReturnType<typeof vi.fn>;
let revoked: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetBranches();
  window.__apiReady = Promise.resolve();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  downloads = [];
  created = vi.fn(() => "blob:feedback");
  revoked = vi.fn();
  URL.createObjectURL = created as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revoked as unknown as typeof URL.revokeObjectURL;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Comments island — the inbox", () => {
  it("sends nothing until the auth gate opens, then loads the inbox once", async () => {
    const auth = gate();
    window.__apiReady = auth.wait;
    const calls = commentsApi();

    render(<CommentsSection />);
    await settle();
    expect(calls).toEqual([]);
    expect(el("feedback-body").textContent).toBe("Loading...");

    auth.release();
    await settle();

    expect(paths(calls)).toEqual(["/api/review-gate/feedback"]);
    expect(el("feedback-body").querySelector(".feedback-comment")!.textContent).toBe("The soup was cold");
  });

  it("keeps the card's title, ids and button the stylesheet and print rules know", async () => {
    commentsApi();
    await mount();

    expect(el("feedback-card").querySelector(".feedback-head h3")!.textContent).toBe("What customers wrote");
    expect(exportButton().textContent).toBe("Download CSV");
    expect(document.querySelector('label[for="feedback-filter"]')!.textContent).toBe("Show comments from");
  });

  it.each([
    ["the request throws", () => {
      throw new Error("unauthorized");
    }],
    ["the answer is not ok", () => new Response(JSON.stringify({ feedback: [], truncated: false, limit: 100 }), { status: 401 })],
  ])("says it could not load when %s, instead of rendering the error as an inbox", async (_case, inbox) => {
    const calls = commentsApi({ inbox });
    await mount();

    // The request was made: an error before it would also land here, for the wrong reason.
    expect(paths(calls)).toEqual(["/api/review-gate/feedback"]);
    expect(el("feedback-body").textContent).toBe("Could not load comments.");
    expect(el("feedback-body").querySelector(".gate-empty")).not.toBeNull();
    expect(errors).toHaveBeenCalled();
  });

  it("does not reload with the Links table or the branches: only the filter moves it", async () => {
    const calls = commentsApi({ lists: { branches: BRANCHES, businesses: BUSINESSES } });
    await mount();
    await act(async () => {
      await loadBranches();
    });
    await settle();

    expect(paths(calls)).toEqual(["/api/review-gate/feedback"]);
  });
});

describe("Comments island — the filter", () => {
  it("turns the filter into the API's query string", () => {
    expect(feedbackQuery("")).toBe("");
    expect(feedbackQuery("b:biz-1")).toBe("?business_id=biz-1");
    expect(feedbackQuery("l:loc-1")).toBe("?location_id=loc-1");
    expect(feedbackQuery("l:a b")).toBe("?location_id=a%20b");
  });

  it("offers only All businesses before the branches have loaded", async () => {
    commentsApi();
    await mount();

    expect([...filter().options].map((o) => [o.value, o.text])).toEqual([["", "All businesses"]]);
  });

  it("lists active businesses with their pickable branches, then loose branches, leaving inactive ones out", async () => {
    await provideBranches(BRANCHES, BUSINESSES);
    commentsApi();
    await mount();

    expect([...filter().options].map((o) => [o.value, o.text])).toEqual([
      ["", "All businesses"],
      ["b:biz-1", "Café Central"],
      ["l:loc-1", "— Providencia"],
      ["b:biz-2", "Sabores"],
      ["l:loc-4", "Suelta (no business)"],
    ]);
  });

  it("reloads the inbox for the chosen business or branch", async () => {
    await provideBranches(BRANCHES, BUSINESSES);
    const calls = commentsApi();
    await mount();

    fireEvent.change(filter(), { target: { value: "b:biz-1" } });
    await settle();
    fireEvent.change(filter(), { target: { value: "l:loc-4" } });
    await settle();

    expect(paths(calls)).toEqual([
      "/api/review-gate/feedback",
      "/api/review-gate/feedback?business_id=biz-1",
      "/api/review-gate/feedback?location_id=loc-4",
    ]);
  });

  it("falls back to all, and reloads, when the chosen business no longer exists", async () => {
    await provideBranches(BRANCHES, BUSINESSES);
    const lists = { branches: BRANCHES, businesses: BUSINESSES };
    const calls = commentsApi({ lists });
    await mount();
    fireEvent.change(filter(), { target: { value: "b:biz-2" } });
    await settle();

    lists.businesses = BUSINESSES.filter((b) => b.id !== "biz-2");
    await act(async () => {
      await loadBranches();
    });
    await settle();

    // Otherwise the list would stay filtered under an "All" label.
    expect(filter().value).toBe("");
    expect(paths(calls).at(-1)).toBe("/api/review-gate/feedback");
    expect(count(calls, "GET", "/api/review-gate/feedback")).toBe(2);
  });

  it("keeps the choice when a branches reload still has it", async () => {
    await provideBranches(BRANCHES, BUSINESSES);
    const calls = commentsApi({ lists: { branches: BRANCHES, businesses: BUSINESSES } });
    await mount();
    fireEvent.change(filter(), { target: { value: "l:loc-1" } });
    await settle();

    await act(async () => {
      await loadBranches();
    });
    await settle();

    expect(filter().value).toBe("l:loc-1");
    expect(paths(calls)).toEqual(["/api/review-gate/feedback", "/api/review-gate/feedback?location_id=loc-1"]);
  });

  it("shows only the newest answer when filter changes overlap", async () => {
    await provideBranches(BRANCHES, BUSINESSES);
    const slow = gate();
    commentsApi({
      inbox: (path) =>
        path.includes("biz-1") ? slow.wait.then(() => ({ ...INBOX, feedback: [{ ...INBOX.feedback[0]!, comment: "stale" }] })) : INBOX,
    });
    await mount();

    fireEvent.change(filter(), { target: { value: "b:biz-1" } });
    await settle();
    fireEvent.change(filter(), { target: { value: "" } });
    await settle();
    slow.release();
    await settle();

    expect(el("feedback-body").querySelector(".feedback-comment")!.textContent).toBe("The soup was cold");
  });
});

describe("Comments island — the CSV export", () => {
  it("downloads through window.__api with the filter on screen, never through a bare link", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await provideBranches(BRANCHES, BUSINESSES);
    const calls = commentsApi();
    await mount();
    fireEvent.change(filter(), { target: { value: "l:loc-1" } });
    await settle();

    await act(async () => {
      fireEvent.click(exportButton());
    });
    await settle();

    expect(document.querySelector('a[href*="feedback.csv"]')).toBeNull();
    expect(paths(calls).at(-1)).toBe("/api/review-gate/feedback.csv?location_id=loc-1");
    expect(created).toHaveBeenCalledTimes(1);
    expect(downloads).toEqual([{ href: "blob:feedback", download: "customer-feedback.csv" }]);
    // The temporary link is gone, and the URL is revoked only later, so a
    // browser that starts the download after the click still finds it.
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revoked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10000);
    expect(revoked).toHaveBeenCalledWith("blob:feedback");
    expect(exportMsg().className).toBe("message");
    expect(exportMsg().textContent).toBe("");
    expect(exportButton().disabled).toBe(false);
  });

  it("says the file was cut when the server says so", async () => {
    commentsApi({
      csv: () => new Response("a\n", { status: 200, headers: { "X-Truncated": "true", "X-Feedback-Limit": "5000" } }),
    });
    await mount();

    await act(async () => {
      fireEvent.click(exportButton());
    });
    await settle();

    expect(exportMsg().className).toBe("message notice");
    expect(exportMsg().textContent).toBe("The file holds the newest 5000 comments; older ones were left out.");
  });

  it("disables the button while the export runs", async () => {
    const hold = gate();
    commentsApi({ csv: () => hold.wait.then(() => new Response("a\n", { status: 200 })) });
    await mount();

    fireEvent.click(exportButton());
    await settle();
    expect(exportButton().disabled).toBe(true);

    hold.release();
    await settle();
    expect(exportButton().disabled).toBe(false);
  });

  it.each([
    ["the server's error", new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }), "Could not export: internal_error"],
    ["the server's detail first", new Response(JSON.stringify({ detail: "Too many", error: "x" }), { status: 429 }), "Could not export: Too many"],
    ["the status when the body is not JSON", new Response("nope", { status: 401 }), "Could not export: HTTP 401"],
  ])("shows %s in the card and downloads nothing", async (_case, refusal, text) => {
    commentsApi({ csv: () => refusal });
    await mount();

    await act(async () => {
      fireEvent.click(exportButton());
    });
    await settle();

    expect(created).not.toHaveBeenCalled();
    expect(downloads).toEqual([]);
    expect(exportMsg().className).toBe("message error");
    expect(exportMsg().textContent).toBe(text);
    expect(exportButton().disabled).toBe(false);
  });

  it("shows the thrown error when the real api helper rejects the export", async () => {
    commentsApi({
      csv: () => {
        throw new Error("internal_error");
      },
    });
    await mount();

    await act(async () => {
      fireEvent.click(exportButton());
    });
    await settle();

    expect(downloads).toEqual([]);
    expect(exportMsg().className).toBe("message error");
    expect(exportMsg().textContent).toBe("internal_error");
  });
});
