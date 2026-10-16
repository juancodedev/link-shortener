import { describe, it, expect } from "vitest";
import {
  renderFeedbackInbox,
  type FeedbackInboxPayload,
} from "../../src/handlers/feedback-inbox";
import type { FeedbackRow } from "../../src/api/review-gate";

// ---------------------------------------------------------------------------
// The inbox: what customers wrote.
//
// Every string on this panel except the labels was typed by a stranger into a
// public form, and the panel is assigned with innerHTML. The tests are mostly
// about that, and about the panel saying something honest when it has nothing
// to show.
// ---------------------------------------------------------------------------

const XSS = '<img src=x onerror=alert(1)>';

function row(over: Partial<FeedbackRow> = {}): FeedbackRow {
  return {
    id: "fb-1",
    comment: "The soup was cold",
    rating: 2,
    customer_contact: null,
    scanned_at: "2026-10-14T20:15:00.000Z",
    short_code: "abc123",
    client_ref: "mesa-4",
    location_name: "Terraza",
    ...over,
  };
}

function payload(over: Partial<FeedbackInboxPayload> = {}): FeedbackInboxPayload {
  return { feedback: [row()], truncated: false, limit: 100, ...over };
}

describe("rendering a comment", () => {
  it("shows the comment, the rating and where it came from", () => {
    const html = renderFeedbackInbox(payload());
    expect(html).toContain("The soup was cold");
    expect(html).toContain("2 / 5");
    expect(html).toContain("Terraza");
    expect(html).toContain("mesa-4");
  });

  it("says 'No rating' rather than showing an empty or zero rating", () => {
    const html = renderFeedbackInbox(payload({ feedback: [row({ rating: null })] }));
    expect(html).toContain("No rating");
    expect(html).not.toContain("0 / 5");
  });

  it("falls back to the client_ref, then to a plain label, when there is no location", () => {
    const refOnly = renderFeedbackInbox(payload({ feedback: [row({ location_name: null })] }));
    expect(refOnly).toContain("mesa-4");

    const none = renderFeedbackInbox(
      payload({ feedback: [row({ location_name: null, client_ref: null })] }),
    );
    expect(none).toContain("No location");
  });

  it("shows the contact only when the customer left one", () => {
    expect(renderFeedbackInbox(payload())).not.toContain("Contact");
    const html = renderFeedbackInbox(
      payload({ feedback: [row({ customer_contact: "ana@example.com" })] }),
    );
    expect(html).toContain("Contact");
    expect(html).toContain("ana@example.com");
  });

  it("shows the date", () => {
    const html = renderFeedbackInbox(payload());
    expect(html).toContain('datetime="2026-10-14T20:15:00.000Z"');
  });
});

describe("escaping customer text", () => {
  it.each([
    ["comment", { comment: XSS }],
    ["contact", { customer_contact: XSS }],
    ["location", { location_name: XSS }],
    ["client_ref", { location_name: null, client_ref: XSS }],
  ])("escapes the %s", (_field, over) => {
    const html = renderFeedbackInbox(payload({ feedback: [row(over)] }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes quotes so an attribute cannot be broken out of", () => {
    const html = renderFeedbackInbox(
      payload({ feedback: [row({ scanned_at: '"><script>x</script>' })] }),
    );
    expect(html).not.toContain("<script>");
  });
});

describe("empty and truncated states", () => {
  it("says there are no comments yet, rather than rendering nothing", () => {
    const html = renderFeedbackInbox(payload({ feedback: [] }));
    expect(html).toContain("No comments yet");
  });

  it("says the list is cut when it is", () => {
    const html = renderFeedbackInbox(payload({ truncated: true, limit: 100 }));
    expect(html).toContain("newest 100");
  });

  it("says nothing about truncation when the list is complete", () => {
    expect(renderFeedbackInbox(payload())).not.toContain("newest");
  });
});

// ---------------------------------------------------------------------------
// The injection guard — the same one `gate-panel.test.ts` carries, for the same
// reason: `dashboard.ts` ships this function with `.toString()`, so a
// module-scope helper is a ReferenceError in the browser and invisible here.
// ---------------------------------------------------------------------------

describe("the injected source is self-contained", () => {
  function rehydrate(): (p: FeedbackInboxPayload) => string {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${renderFeedbackInbox.toString()})`)() as (
      p: FeedbackInboxPayload,
    ) => string;
  }

  it("renders every branch identically with nothing else in scope", () => {
    const standalone = rehydrate();
    const cases = [
      payload(),
      payload({ feedback: [] }),
      payload({ truncated: true }),
      payload({
        feedback: [
          row({ rating: null, location_name: null, client_ref: null, customer_contact: XSS }),
        ],
      }),
    ];
    for (const c of cases) {
      expect(standalone(c)).toBe(renderFeedbackInbox(c));
    }
  });
});
