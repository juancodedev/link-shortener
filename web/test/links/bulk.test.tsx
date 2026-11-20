import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { count, field, gate, installLegacy, link, mountLinks, settle, standardApi, type Call } from "./harness";

// Bulk card stock: the "Create cards in bulk..." modal. Ported from the
// Worker tests that read the served modal and its BULK BLOCK script
// (test/handlers/dashboard.test.ts: "the dashboard can manufacture cards in
// bulk" and "a bulk batch can carry one label").

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clicked: HTMLAnchorElement[];

beforeEach(() => {
  installLegacy();
  createObjectURL = vi.fn(() => "blob:sheet");
  revokeObjectURL = vi.fn();
  // jsdom has neither.
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const modal = () => document.getElementById("bulk-modal") as HTMLDivElement;
const isShown = () => !modal().classList.contains("hidden");
const msg = () => document.getElementById("bulk-msg") as HTMLDivElement;
const bulkResult = () => document.getElementById("bulk-result") as HTMLDivElement;
const summary = () => document.getElementById("bulk-summary")!.textContent;
const createBtn = () => document.getElementById("bulk-create") as HTMLButtonElement;
const batches = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/links/batch");
const sheets = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/links/qr-sheet.zip");

async function open() {
  await act(async () => {
    fireEvent.click(document.getElementById("open-bulk")!);
  });
}

async function create(n?: string) {
  if (n !== undefined) fireEvent.change(field("bulk-count"), { target: { value: n } });
  await act(async () => {
    fireEvent.click(createBtn());
  });
  await settle();
}

async function download() {
  await act(async () => {
    fireEvent.click(document.getElementById("bulk-download")!);
  });
  await settle();
}

describe("bulk modal — opening and closing", () => {
  it("opens from the bulk entry point and closes on its Close button and on the backdrop, not on the card", async () => {
    standardApi();
    await mountLinks();

    expect(document.getElementById("open-bulk")!.textContent).toContain("Create cards in bulk...");
    expect(modal().className).toBe("qr-modal hidden");
    await open();
    expect(isShown()).toBe(true);

    fireEvent.click(modal().querySelector(".qr-card")!);
    expect(isShown()).toBe(true);

    fireEvent.click(modal());
    expect(isShown()).toBe(false);

    await open();
    const close = [...modal().querySelectorAll("button")].find((b) => b.textContent === "Close")!;
    fireEvent.click(close);
    expect(isShown()).toBe(false);
  });

  it("starts each opening with no result and no message, keeping what was typed", async () => {
    const calls = standardApi();
    await mountLinks();
    await open();
    fireEvent.change(field("bulk-label"), { target: { value: "Patio" } });
    await create("2");
    expect(bulkResult().style.display).toBe("");

    fireEvent.click(modal());
    await open();

    expect(bulkResult().style.display).toBe("none");
    expect(msg().className).toBe("message");
    expect(msg().textContent).toBe("");
    expect(field("bulk-label").value).toBe("Patio");
    expect(field("bulk-count").value).toBe("2");

    // The ids of the previous batch went with it.
    await act(async () => {
      bulkResult().style.display = "";
    });
    await download();
    expect(msg().textContent).toBe("Create the cards first.");
    expect(sheets(calls)).toHaveLength(0);
  });
});

describe("bulk modal — the fields", () => {
  it("asks for a count capped at the server's limit, an optional label and the review screen, nothing else", async () => {
    standardApi();
    await mountLinks();

    const n = field("bulk-count");
    expect(n.type).toBe("number");
    expect(n.min).toBe("1");
    expect(n.max).toBe("200");
    expect(n.value).toBe("10");
    expect(field("bulk-label").maxLength).toBe(200);
    expect(document.querySelector('label[for="bulk-label"]')!.textContent).toContain("Label for this batch");
    expect(field("bulk-gated").type).toBe("checkbox");
    expect(field("bulk-gated").checked).toBe(false);
    expect(modal().querySelector("#url")).toBeNull();
  });

  it("says what an unconfigured card does, and that the label reaches the card and the CSV", async () => {
    standardApi();
    await mountLinks();

    const text = modal().textContent!;
    expect(text).toContain("not configured");
    expect(text).toMatch(/CSV/);
    expect(text).toMatch(/designer/i);
  });
});

describe("bulk modal — creating", () => {
  it("validates the count before spending a request on it", async () => {
    const calls = standardApi();
    await mountLinks();
    await open();

    for (const bad of ["0", "201", "", "abc"]) {
      await create(bad);
      expect(msg().className).toBe("message error");
      expect(msg().textContent).toBe("Enter a number between 1 and 200.");
    }
    expect(batches(calls)).toHaveLength(0);
  });

  it("creates the cards WITHOUT a destination, ungated by default, and no label when none was typed", async () => {
    const calls = standardApi();
    await mountLinks();
    await open();

    await create("3");

    expect(batches(calls)[0]!.body).toEqual({ links: [{ is_gated: false }, { is_gated: false }, { is_gated: false }] });
  });

  it("applies ONE trimmed label and the review-screen choice to every card", async () => {
    const calls = standardApi();
    await mountLinks();
    await open();

    fireEvent.change(field("bulk-label"), { target: { value: "  Main room  " } });
    fireEvent.click(field("bulk-gated"));
    await create("2");

    expect(batches(calls)[0]!.body).toEqual({
      links: [
        { is_gated: true, client_ref: "Main room" },
        { is_gated: true, client_ref: "Main room" },
      ],
    });
  });

  it("reports a full batch, and reloads the table", async () => {
    const calls = standardApi();
    await mountLinks();
    delete window.__loadLinks;
    await open();

    await create("1");

    expect(bulkResult().style.display).toBe("");
    expect(summary()).toBe("1 card created. ");
    expect(msg().className).toBe("message success");
    expect(count(calls, "GET", "/api/links")).toBe(2);

    await create("4");
    expect(summary()).toBe("4 cards created. ");
  });

  it("reports a PARTIAL batch rather than calling it a success", async () => {
    standardApi({
      batch: () => ({
        results: [
          { status: 201, link: link({ id: "a" }) },
          { status: 500, error: "boom" },
          { status: 201, link: link({ id: "b" }) },
        ],
      }),
    });
    await mountLinks();
    await open();

    await create("3");

    expect(summary()).toBe("2 cards created. 1 failed — try those again.");
    expect(msg().className).toBe("message error");
  });

  it("surfaces the server's own refusal when nothing was created", async () => {
    standardApi({ batch: () => new Response(JSON.stringify({ error: "Too many cards" }), { status: 400 }) });
    await mountLinks();
    await open();

    await create("3");

    expect(msg().className).toBe("message error");
    expect(msg().textContent).toBe("Too many cards");
    expect(bulkResult().style.display).toBe("none");
  });

  it("falls back to a generic refusal, and shows what the api helper throws", async () => {
    standardApi({ batch: () => new Response(JSON.stringify({}), { status: 400 }) });
    await mountLinks();
    await open();
    await create("1");
    expect(msg().textContent).toBe("Could not create the cards");

    standardApi({
      batch: () => {
        throw new Error("Server error");
      },
    });
    await create("1");
    expect(msg().textContent).toBe("Server error");
  });

  it("disables the button while the batch is out", async () => {
    const hold = gate();
    standardApi({
      batch: async () => {
        await hold.wait;
        return { results: [] };
      },
    });
    await mountLinks();
    await open();

    await act(async () => {
      fireEvent.click(createBtn());
    });
    expect(createBtn().disabled).toBe(true);
    expect(createBtn().textContent).toBe("Creating...");

    hold.release();
    await settle();
    expect(createBtn().disabled).toBe(false);
    expect(createBtn().textContent).toBe("Create them");
  });
});

describe("bulk modal — the print sheet", () => {
  it("downloads only the cards actually created, as cards.zip, through the api helper", async () => {
    const calls = standardApi({
      batch: () => ({
        results: [
          { status: 201, link: link({ id: "a" }) },
          { status: 422, error: "x" },
          { status: 201, link: link({ id: "b" }) },
        ],
      }),
    });
    await mountLinks();
    await open();
    await create("3");

    await download();

    expect(sheets(calls)[0]!.body).toEqual({ link_ids: ["a", "b"] });
    // The response body itself (Response.blob() is Node's Blob, not jsdom's).
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]![0]).toHaveProperty("size", 3);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe("cards.zip");
    expect(clicked[0]!.href).toBe("blob:sheet");
    // Removed after the click, and the object URL released.
    expect(clicked[0]!.isConnected).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:sheet");
  });

  it("refuses to download before anything was created", async () => {
    const calls = standardApi({ batch: () => ({ results: [{ status: 500 }, { status: 500 }] }) });
    await mountLinks();
    await open();
    await create("2");
    expect(summary()).toBe("0 cards created. 2 failed — try those again.");

    await download();

    expect(msg().className).toBe("message error");
    expect(msg().textContent).toBe("Create the cards first.");
    expect(sheets(calls)).toHaveLength(0);
  });

  it("shows the error when the sheet cannot be fetched, and downloads nothing", async () => {
    standardApi({
      sheet: () => {
        throw new Error("Card a has a destination");
      },
    });
    await mountLinks();
    await open();
    await create("1");

    await download();

    expect(msg().className).toBe("message error");
    expect(msg().textContent).toBe("Card a has a destination");
    expect(clicked).toHaveLength(0);
  });
});
