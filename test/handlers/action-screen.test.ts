import { describe, it, expect } from "vitest";
import { renderActionScreen } from "../../src/handlers/action-screen";

/**
 * The form and the endpoint it posts to, as ONE contract.
 *
 * The comment form broke in production because it posted `code`, `comment` and
 * `customer_contact` — and no `action_taken`. The handler read `action_taken`,
 * found an empty string, and returned 400.
 *
 * Every handler test passes `action_taken` by hand, so all of them were green
 * while the only client that talks to this endpoint in production could not use
 * it. Tests on each side of a boundary are not a test of the boundary. This file
 * is the boundary.
 */

const params = {
  businessName: "Café Central",
  destinationUrl: "https://g.page/abc/review",
  code: "mesa-01",
};

async function screen(): Promise<string> {
  // `Response.text()` is a Promise. Awaiting it here rather than in each test
  // keeps every assertion below reading as a plain string.
  return await renderActionScreen(params).text();
}

function feedbackForm(html: string): string {
  const start = html.indexOf('<form method="POST" action="/api/gate">');
  expect(start, "the feedback form is missing").toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</form>", start));
}

describe("the private feedback form", () => {
  it("posts to the gate endpoint", async () => {
    expect(await screen()).toContain('<form method="POST" action="/api/gate">');
  });

  it("declares the action the endpoint validates", async () => {
    // THE BUG. The handler reads `action_taken` and rejects anything outside
    // {google_redirect, internal_feedback}. A form that omits it sends "", which
    // is not in the set, so every private comment 400s — and the customer sees
    // `{"error":"invalid_request"}`.
    const form = feedbackForm(await screen());
    expect(form).toContain('name="action_taken"');
    expect(form).toMatch(/name="action_taken"[^>]*value="internal_feedback"/);
  });

  it("declares every field the endpoint reads", async () => {
    const form = feedbackForm(await screen());
    const required = ["code", "action_taken", "comment", "customer_contact"];

    for (const field of required) {
      expect(form, `missing field: ${field}`).toContain(`name="${field}"`);
    }
  });

  it("carries the scanned code, so the feedback lands on the right sticker", async () => {
    // Without it the handler rejects on `!input.code` — and a comment attached
    // to the wrong table is worse than no comment.
    const form = feedbackForm(await screen());
    const hidden = form.match(/<input[^>]*name="code"[^>]*>/)?.[0] ?? "";
    expect(hidden).toContain('type="hidden"');
    expect(hidden).toContain(params.code);
  });

  it("escapes the code it embeds in the markup", async () => {
    // A code is generated, but this handler interpolates it into an attribute
    // and a JS string literal. One unescaped quote would end both.
    const html = await renderActionScreen({
      ...params,
      code: 'a"onerror=alert(1)',
    }).text();

    expect(html).not.toContain('value="a"onerror=alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("requires a comment, matching the rule the endpoint enforces", async () => {
    // The endpoint rejects an empty private comment: accepting it would inflate
    // the feedback count with nothing behind it. The form saying `required`
    // means the customer finds out before submitting rather than after.
    expect(feedbackForm(await screen())).toMatch(/<textarea[^>]*name="comment"[^>]*required/);
  });

  it("marks the email optional, because the rule is optional", async () => {
    const form = feedbackForm(await screen());
    const email = form.match(/<input[^>]*name="customer_contact"[^>]*>/)?.[0] ?? "";
    expect(email).not.toContain("required");
    expect(email).toContain('type="email"');
  });
});

describe("the client's own fetches", () => {
  it("sends action_taken on every fetch to the gate", async () => {
    const html = await screen();
    const fetches = [...html.matchAll(/fetch\('\/api\/gate'[\s\S]*?\)\.catch/g)];

    expect(fetches.length).toBeGreaterThan(0);
    for (const f of fetches) {
      // A fetch that omits it is a request that cannot succeed.
      expect(f[0], "a gate fetch omits action_taken").toContain("action_taken=");
    }
  });

  it("does not fire a feedback fetch that the endpoint will always reject", async () => {
    // Opening the <details> panel fired `internal_feedback` with no comment.
    // The endpoint rejects exactly that body — "a private submission with no
    // comment carries no information" — so this request could only ever return
    // 400. It recorded nothing and it cost a round trip.
    const html = await screen();
    const toggleFetch = html.match(/'toggle'[\s\S]*?\)\.catch/)?.[0];

    if (toggleFetch) {
      expect(toggleFetch, "panel-open records feedback with no comment").not.toContain(
        "internal_feedback",
      );
    }
  });
});