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
  const start = html.indexOf('<form method="POST" action="/api/gate"');
  expect(start, "the feedback form is missing").toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</form>", start));
}

function ratingInputs(html: string): string[] {
  return [...html.matchAll(/<input[^>]*name="rating"[^>]*>/g)].map((m) => m[0]);
}

/** Everything between the opening of the collapsible panel and its close. */
function collapsedPanel(html: string): string {
  const start = html.indexOf("<details");
  if (start === -1) return "";
  return html.slice(start, html.indexOf("</details>", start));
}

describe("the private feedback form", () => {
  it("posts to the gate endpoint", async () => {
    expect(await screen()).toContain('<form method="POST" action="/api/gate"');
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
    const html = await screen();
    const form = feedbackForm(html);
    const inside = ["code", "action_taken", "comment", "customer_phone", "customer_contact"];

    for (const field of inside) {
      expect(form, `missing field: ${field}`).toContain(`name="${field}"`);
    }

    // The stars sit outside the <form> element so they are visible before the
    // panel opens, and join the submission through the HTML `form` attribute.
    // A browser submits an associated control exactly like a nested one.
    const formId = form.match(/<form[^>]*id="([^"]+)"/)?.[1];
    expect(formId, "the form needs an id for its associated controls").toBeTruthy();
    const ratings = ratingInputs(html);
    expect(ratings.length).toBe(5);
    for (const input of ratings) {
      expect(input, "a star is not associated with the form").toContain(`form="${formId}"`);
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

  it("offers the phone as a telephone field that is recommended, not required", async () => {
    const form = feedbackForm(await screen());
    const phone = form.match(/<input[^>]*name="customer_phone"[^>]*>/)?.[0] ?? "";
    expect(phone, "the phone input is missing").not.toBe("");
    expect(phone).toContain('type="tel"');
    expect(phone).not.toContain("required");
    expect(form).toContain("Teléfono (recomendado)");
    expect(form).toContain("Correo (opcional)");
  });

  it("orders the fields message, phone, email, then submit", async () => {
    const form = feedbackForm(await screen());
    const comment = form.indexOf('name="comment"');
    const phone = form.indexOf('name="customer_phone"');
    const email = form.indexOf('name="customer_contact"');
    const submit = form.indexOf('type="submit"');

    expect(comment).toBeGreaterThan(-1);
    expect(phone).toBeGreaterThan(comment);
    expect(email).toBeGreaterThan(phone);
    expect(submit).toBeGreaterThan(email);
  });
});

describe("the star rating", () => {
  it("renders five star inputs named rating with values 1 to 5", async () => {
    const inputs = ratingInputs(await screen());
    expect(inputs.length).toBe(5);
    inputs.forEach((input, i) => {
      expect(input).toContain('type="radio"');
      expect(input).toContain(`value="${i + 1}"`);
    });
  });

  it("is visible before the private panel opens", async () => {
    // A rating hidden inside the collapsed panel would never be chosen by
    // someone who goes straight to Google.
    expect(collapsedPanel(await screen())).not.toContain('name="rating"');
  });

  it("is optional", async () => {
    for (const input of ratingInputs(await screen())) {
      expect(input).not.toContain("required");
    }
  });
});

describe("compliance: the rating never decides what the customer sees", () => {
  // Review gating — showing Google only to happy customers — is prohibited by
  // Google. These assertions pin the markup a customer sees on first paint,
  // before any star is chosen.

  it("shows the Google link on first paint, outside the collapsed panel", async () => {
    const html = await screen();
    const link = html.match(/<a[^>]*data-action="google_redirect"[^>]*>/)?.[0] ?? "";

    expect(link, "the Google link is missing").not.toBe("");
    expect(link).toContain(`href="${params.destinationUrl}"`);
    expect(link).not.toMatch(/\b(hidden|disabled|aria-disabled|inert)\b/);
    expect(collapsedPanel(html)).not.toContain('data-action="google_redirect"');
  });

  it("never toggles visibility from the rating in its script", async () => {
    const html = await screen();
    const script = html.slice(html.lastIndexOf("<script>"), html.lastIndexOf("</script>"));
    // The only reason the script reads the rating is to record it.
    expect(script).not.toMatch(/\.hidden\s*=|style\.display|classList\.(add|remove|toggle)/);
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

  it("records the chosen rating on the Google click", async () => {
    const html = await screen();
    const fetchCall = html.match(/fetch\('\/api\/gate'[\s\S]*?\)\.catch/)?.[0] ?? "";
    expect(fetchCall).toContain("action_taken=google_redirect");
    expect(fetchCall).toContain("&rating=");
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