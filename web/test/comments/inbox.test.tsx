import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FeedbackInbox, type FeedbackInboxPayload, type FeedbackRow } from "../../src/comments/FeedbackInbox";

// The inbox: what customers wrote (dashboard-react T5). Ported from
// test/handlers/feedback-inbox.test.ts, which tested the server-side
// renderFeedbackInbox the page used to inject with toString(). Every string
// here except the labels was typed by a stranger into a public form, so the
// escaping tests become "rendered as text, never as markup".

const XSS = "<img src=x onerror=alert(1)>";

function row(over: Partial<FeedbackRow> = {}): FeedbackRow {
  return {
    id: "fb-1",
    comment: "The soup was cold",
    rating: 2,
    customer_contact: null,
    customer_phone: null,
    scanned_at: "2026-10-14T20:15:00.000Z",
    short_code: "abc123",
    client_ref: "mesa-4",
    location_name: "Terraza",
    business_name: "Sabores",
    ...over,
  };
}

function payload(over: Partial<FeedbackInboxPayload> = {}): FeedbackInboxPayload {
  return { feedback: [row()], truncated: false, limit: 100, ...over };
}

function show(p: FeedbackInboxPayload): HTMLElement {
  return render(<FeedbackInbox payload={p} />).container;
}

afterEach(cleanup);

describe("rendering a comment", () => {
  it("shows the comment, the rating and where it came from, as a list item", () => {
    const html = show(payload());
    const item = html.querySelector("ul.feedback-list > li.feedback-item")!;
    expect(item.querySelector(".feedback-comment")!.textContent).toBe("The soup was cold");
    expect(item.querySelector(".feedback-rating")!.textContent).toBe("2 / 5");
    expect(item.querySelector(".feedback-rating")!.classList.contains("withheld")).toBe(false);
    expect(item.querySelector(".feedback-origin")!.textContent).toBe("Sabores · Terraza · mesa-4 abc123");
  });

  it("says 'No rating' rather than showing an empty or zero rating", () => {
    const rating = show(payload({ feedback: [row({ rating: null })] })).querySelector(".feedback-rating")!;
    expect(rating.textContent).toBe("Sin calificación");
    expect(rating.className).toBe("feedback-rating withheld");
  });

  it("falls back to the client_ref, then to a plain label, when there is no location", () => {
    expect(show(payload({ feedback: [row({ location_name: null })] })).querySelector(".feedback-origin")!.textContent).toBe(
      "Sabores · mesa-4 abc123",
    );
    cleanup();
    // No location means no business either: the business is reached through
    // the location.
    expect(
      show(payload({ feedback: [row({ business_name: null, location_name: null, client_ref: null })] })).querySelector(".feedback-origin")!
        .textContent,
    ).toBe("Sin ubicación abc123");
  });

  it("skips empty origin parts as well as missing ones", () => {
    expect(show(payload({ feedback: [row({ location_name: "", client_ref: "" })] })).querySelector(".feedback-origin")!.textContent).toBe(
      "Sabores abc123",
    );
  });

  it("shows the contact only when the customer left one", () => {
    expect(show(payload()).querySelector(".feedback-contact")).toBeNull();
    cleanup();
    expect(show(payload({ feedback: [row({ customer_contact: "ana@example.com" })] })).querySelector(".feedback-contact")!.textContent).toBe(
      "Contacto: ana@example.com",
    );
  });

  it("shows the phone first when the customer left both", () => {
    const html = show(payload({ feedback: [row({ customer_phone: "+56 9 1234 5678", customer_contact: "ana@example.com" })] }));
    expect(html.querySelector(".feedback-contact")!.textContent).toBe("Contacto: +56 9 1234 5678 · ana@example.com");
  });

  it("shows a phone-only contact", () => {
    expect(show(payload({ feedback: [row({ customer_phone: "+56 9 1234 5678" })] })).querySelector(".feedback-contact")!.textContent).toBe(
      "Contacto: +56 9 1234 5678",
    );
  });

  it("traces every comment to its short code, even without a branch", () => {
    const code = show(payload({ feedback: [row({ business_name: null, location_name: null, client_ref: null })] })).querySelector(
      "code.feedback-code",
    )!;
    expect(code.textContent).toBe("abc123");
  });

  it.each([null, ""])("leaves the code out when the short code is %j", (short_code) => {
    const html = show(payload({ feedback: [row({ short_code })] }));
    expect(html.querySelector("code")).toBeNull();
    expect(html.querySelector(".feedback-origin")!.textContent).toBe("Sabores · Terraza · mesa-4");
  });

  it("shows the date in the reader's locale, keeping the instant in datetime", () => {
    const time = show(payload()).querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe("2026-10-14T20:15:00.000Z");
    expect(time.textContent).toBe(new Date("2026-10-14T20:15:00.000Z").toLocaleString("es-CL"));
  });

  it("shows an unparseable date as it came", () => {
    expect(show(payload({ feedback: [row({ scanned_at: "yesterday" })] })).querySelector("time")!.textContent).toBe("yesterday");
  });

  it("never cuts a long comment", () => {
    const long = "x".repeat(5000);
    expect(show(payload({ feedback: [row({ comment: long })] })).querySelector(".feedback-comment")!.textContent).toBe(long);
  });
});

describe("customer text is text", () => {
  it.each([
    ["comment", { comment: XSS }],
    ["contact", { customer_contact: XSS }],
    ["phone", { customer_phone: XSS }],
    ["location", { location_name: XSS }],
    ["client_ref", { location_name: null, client_ref: XSS }],
    ["business", { business_name: XSS }],
    ["short code", { short_code: XSS }],
  ])("renders the %s as text", (_field, over) => {
    const html = show(payload({ feedback: [row(over)] }));
    expect(html.querySelector("img")).toBeNull();
    expect(html.textContent).toContain(XSS);
  });

  it("keeps a hostile date inside its attribute", () => {
    const html = show(payload({ feedback: [row({ scanned_at: '"><script>x</script>' })] }));
    expect(html.querySelector("script")).toBeNull();
    expect(html.querySelector("time")!.getAttribute("datetime")).toBe('"><script>x</script>');
  });
});

describe("empty and truncated states", () => {
  it("says there are no comments yet, rather than rendering nothing", () => {
    const html = show(payload({ feedback: [] }));
    expect(html.querySelector("ul")).toBeNull();
    expect(html.querySelector("p.gate-empty")!.textContent).toBe(
      "Aún no hay comentarios. Cuando un cliente deje uno en la pantalla de reseña, aparecerá aquí.",
    );
  });

  it("says the list is cut when it is", () => {
    expect(show(payload({ truncated: true, limit: 100 })).querySelector("p.estimate-note")!.textContent).toBe(
      "Mostrando los 100 comentarios más recientes. Descarga el CSV para ver más.",
    );
  });

  it("says nothing about truncation when the list is complete", () => {
    expect(show(payload()).textContent).not.toContain("newest");
  });
});
