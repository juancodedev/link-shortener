import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { count, field, gate, installClipboard, installLegacy, link, mountLinks, settle, standardApi, type Call } from "./harness";

// The create form at the top of the Links section. Ported from the Worker
// tests that read the served form and its submit handler (test/handlers/
// dashboard.test.ts: "the create form can manufacture card stock" and
// "review screen checkbox").

let clipboard: string[];

beforeEach(() => {
  installLegacy();
  clipboard = installClipboard();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const form = () => document.getElementById("create-form") as HTMLFormElement;
const submitButton = () => form().querySelector("button") as HTMLButtonElement;
const msg = () => document.getElementById("create-msg") as HTMLDivElement;
const result = () => document.getElementById("result") as HTMLDivElement;
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/links");

function type(id: string, value: string) {
  fireEvent.change(field(id), { target: { value } });
}

async function submit() {
  await act(async () => {
    fireEvent.submit(form());
  });
  await settle();
}

describe("create form — the fields", () => {
  it("does not mark the destination as required, and keeps it labelled and first", async () => {
    standardApi();
    await mountLinks();

    // Card stock is created before its destination exists; `required` would
    // block that in the one place the owner types.
    const url = field("url");
    expect(url.required).toBe(false);
    expect(form().querySelector("input")).toBe(url);
    expect(document.querySelector('label[for="url"]')!.textContent).toBe("Destination URL");
  });

  it("says what an empty destination produces", async () => {
    standardApi();
    await mountLinks();

    const help = [...form().querySelectorAll(".field-help")].map((p) => p.textContent).join(" ");
    expect(help).toContain("Leave empty to create a card first and add its destination later.");
    expect(help).toContain('"not configured" page');
  });

  it("shapes the custom short code and the title the way the server does", async () => {
    standardApi();
    await mountLinks();

    expect(field("slug").maxLength).toBe(32);
    expect(field("slug").getAttribute("pattern")).toBe("[A-Za-z0-9_-]+");
    expect(field("title").maxLength).toBe(200);
  });

  it("offers the review screen as an opt-in checkbox, unchecked by default", async () => {
    standardApi();
    await mountLinks();

    expect(field("gated").type).toBe("checkbox");
    expect(field("gated").checked).toBe(false);
  });
});

describe("create form — submitting", () => {
  it("omits original_url entirely when the field is blank, and blank slug and title too", async () => {
    const calls = standardApi();
    await mountLinks();

    type("url", "   ");
    await submit();

    const sent = posts(calls)[0]!.body as Record<string, unknown>;
    expect("original_url" in sent).toBe(false);
    expect(sent.slug).toBeUndefined();
    expect(sent.title).toBeUndefined();
    expect(JSON.parse(JSON.stringify(sent))).toEqual({ is_gated: false });
  });

  it("trims the destination and the slug, and sends the review-screen choice", async () => {
    const calls = standardApi();
    await mountLinks();

    type("url", "  example.com/menu  ");
    type("slug", "  cafe-central ");
    type("title", "Menu");
    fireEvent.click(field("gated"));
    await submit();

    expect(posts(calls)[0]!.body).toEqual({ original_url: "example.com/menu", title: "Menu", slug: "cafe-central", is_gated: true });
  });

  it("shows the short URL, copies it and names a link as a link", async () => {
    standardApi();
    await mountLinks();

    type("url", "https://example.com");
    await submit();

    expect(field("short-url").value).toBe("https://short.link/new1234");
    expect(result().style.display).toBe("");
    expect(clipboard).toEqual(["https://short.link/new1234"]);
    expect(msg().className).toBe("message success");
    expect(msg().textContent).toBe("Link created! Copied to clipboard.");
  });

  it("names a card with no destination as a card", async () => {
    standardApi();
    await mountLinks();

    await submit();

    expect(msg().textContent).toBe("Card created! Its QR opens a 'not configured' page until you add a destination.");
  });

  it("clears every field after creating", async () => {
    standardApi();
    await mountLinks();

    type("url", "https://example.com");
    type("slug", "abc");
    type("title", "T");
    fireEvent.click(field("gated"));
    await submit();

    expect(field("url").value).toBe("");
    expect(field("slug").value).toBe("");
    expect(field("title").value).toBe("");
    expect(field("gated").checked).toBe(false);
  });

  it("reloads the table through the island's own load", async () => {
    const calls = standardApi();
    await mountLinks();
    delete window.__loadLinks;

    await submit();

    expect(count(calls, "GET", "/api/links")).toBe(2);
  });

  it("disables the button while the request is out, and hides the previous result", async () => {
    let hold: ReturnType<typeof gate> | null = null;
    standardApi({
      create: async () => {
        if (hold) await hold.wait;
        return link({ short_url: "https://short.link/x" });
      },
    });
    await mountLinks();
    await submit();
    expect(result().style.display).toBe("");

    hold = gate();
    await act(async () => {
      fireEvent.submit(form());
    });

    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toBe("Creating...");
    expect(result().style.display).toBe("none");

    hold.release();
    await settle();
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().textContent).toBe("Shorten");
    expect(result().style.display).toBe("");
  });

  it("shows the server's refusal and keeps what was typed", async () => {
    standardApi({ create: () => new Response(JSON.stringify({ error: "Slug already taken" }), { status: 409 }) });
    await mountLinks();

    type("slug", "taken");
    await submit();

    expect(msg().className).toBe("message error");
    expect(msg().textContent).toBe("Slug already taken");
    expect(field("slug").value).toBe("taken");
    expect(result().style.display).toBe("none");
  });

  it("shows the error the api helper throws", async () => {
    standardApi({
      create: () => {
        throw new Error("Server error");
      },
    });
    await mountLinks();

    await submit();

    expect(msg().textContent).toBe("Server error");
    expect(submitButton().textContent).toBe("Shorten");
  });

  it("still reloads the table when the clipboard is unavailable", async () => {
    const calls = standardApi();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    await mountLinks();

    await submit();

    expect(msg().className).toBe("message success");
    expect(count(calls, "GET", "/api/links")).toBe(2);
  });
});

describe("create form — the short URL box", () => {
  it("selects and copies the short URL on click, with no inline handler", async () => {
    standardApi();
    await mountLinks();
    await submit();
    clipboard.length = 0;

    const box = field("short-url");
    expect(box.readOnly).toBe(true);
    expect(box.className).toBe("short-url");
    expect(box.getAttribute("onclick")).toBeNull();
    const select = vi.spyOn(box, "select");
    fireEvent.click(box);

    expect(select).toHaveBeenCalled();
    expect(clipboard).toEqual(["https://short.link/new1234"]);
  });
});
