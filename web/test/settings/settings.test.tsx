import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSection } from "../../src/settings/SettingsSection";
import { gate, installApi, settle, type Call } from "../links/harness";

// The feedback email card (dashboard-react T5). Ported from the Worker tests
// of the legacy loadFeedbackEmail and its save listener ("the feedback email
// section"). The address is stored, shown and exported; NOTHING IS EMAILED,
// and the card has to say so: a green dashboard beside a "feedback email"
// field tells an owner their reviews are being delivered.

type Routes = { get?: () => unknown; put?: (body: unknown) => unknown };

function settingsApi(routes: Routes = {}): Call[] {
  return installApi((method, path, body) => {
    if (path !== "/api/tenant/feedback-email") throw new Error(`unexpected ${method} ${path}`);
    if (method === "GET") return routes.get ? routes.get() : { feedback_email: "owner@cafe.cl" };
    if (method === "PUT") return routes.put ? routes.put(body) : { ok: true };
    throw new Error(`unexpected ${method} ${path}`);
  });
}

const input = () => document.getElementById("feedback-email") as HTMLInputElement;
const save = () => document.getElementById("feedback-email-save") as HTMLButtonElement;
const msg = () => document.getElementById("feedback-email-msg") as HTMLElement;

async function mount() {
  const view = render(<SettingsSection />);
  await settle();
  return view;
}

async function clickSave() {
  await act(async () => {
    fireEvent.click(save());
  });
  await settle();
}

beforeEach(() => {
  window.__apiReady = Promise.resolve();
});

afterEach(cleanup);

describe("Settings island — the feedback email card", () => {
  it("says the address is stored, not sent, and where comments still arrive", async () => {
    settingsApi();
    await mount();

    const card = document.getElementById("feedback-email-card")!;
    expect(card.querySelector("h3")!.textContent).toBe("Feedback email");
    expect(card.querySelector(".field-help")!.textContent!.replace(/\s+/g, " ").trim()).toBe(
      "Where you would like private customer comments delivered. Stored now; nothing is emailed yet — comments still arrive in the Comments section.",
    );
    expect(input().type).toBe("email");
    expect(input().placeholder).toBe("you@yourbusiness.com");
    expect(input().autocomplete).toBe("email");
    expect(input().maxLength).toBe(254);
    expect(document.querySelector('label[for="feedback-email"]')!.textContent).toBe("Email address");
    expect(save().textContent).toBe("Save");
  });

  it("sends nothing until the auth gate opens, then shows the stored address, read once", async () => {
    const auth = gate();
    window.__apiReady = auth.wait;
    const calls = settingsApi();
    render(<SettingsSection />);
    await settle();
    expect(calls).toEqual([]);

    auth.release();
    await settle();

    expect(calls).toEqual([{ method: "GET", path: "/api/tenant/feedback-email" }]);
    expect(input().value).toBe("owner@cafe.cl");
  });

  it.each([
    ["no address is stored", () => ({ feedback_email: null })],
    ["the setting cannot be read", () => {
      throw new Error("Server error");
    }],
  ])("leaves the field empty, and the card working, when %s", async (_case, get) => {
    settingsApi({ get });
    await mount();

    expect(input().value).toBe("");
    expect(msg().className).toBe("message");
    expect(save().disabled).toBe(false);
  });

  it("PUTs what is typed and says Saved only when the server agreed", async () => {
    const calls = settingsApi();
    await mount();

    fireEvent.change(input(), { target: { value: "new@cafe.cl" } });
    await clickSave();

    expect(calls.at(-1)).toEqual({ method: "PUT", path: "/api/tenant/feedback-email", body: { feedback_email: "new@cafe.cl" } });
    expect(msg().className).toBe("message success");
    expect(msg().textContent).toBe("Saved.");
  });

  it.each([
    ["the server's detail", { detail: "That does not look like an email address.", error: "invalid" }, "That does not look like an email address."],
    ["the server's error", { error: "invalid" }, "invalid"],
    ["a fallback", {}, "Could not save"],
  ])("shows %s when the server refuses", async (_case, body, text) => {
    settingsApi({ put: () => new Response(JSON.stringify(body), { status: 400 }) });
    await mount();

    await clickSave();

    expect(msg().className).toBe("message error");
    expect(msg().textContent).toBe(text);
    expect(save().disabled).toBe(false);
  });

  it("shows the thrown error when the real api helper rejects the save", async () => {
    settingsApi({
      put: () => {
        throw new Error("That does not look like an email address.");
      },
    });
    await mount();

    await clickSave();

    expect(msg().className).toBe("message error");
    expect(msg().textContent).toBe("That does not look like an email address.");
  });

  it("disables Save while the request runs, and clears the last message", async () => {
    const hold = gate();
    let first = true;
    settingsApi({
      put: () => {
        if (first) {
          first = false;
          return new Response("{}", { status: 500 });
        }
        return hold.wait.then(() => ({ ok: true }));
      },
    });
    await mount();
    await clickSave();
    expect(msg().className).toBe("message error");

    fireEvent.click(save());
    await settle();
    expect(save().disabled).toBe(true);
    expect(msg().className).toBe("message");
    expect(msg().textContent).toBe("");

    hold.release();
    await settle();
    expect(save().disabled).toBe(false);
    expect(msg().textContent).toBe("Saved.");
  });
});
