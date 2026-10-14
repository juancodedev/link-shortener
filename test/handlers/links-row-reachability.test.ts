import { describe, it, expect } from "vitest";
import { dashboardHandler } from "../../src/handlers/dashboard";

// ---------------------------------------------------------------------------
// Reachability — the structural guarantee behind it.
//
// WHY THIS FILE EXISTS
//
// `odd/analysis/dashboard-design-review.md` found the links table clipping its
// action buttons and attributed it to four equal-weight buttons competing for
// space. That analysis was wrong: `.row-actions` declares `flex-wrap: wrap`, and
// the wrapping is what stacked all four vertically.
//
// The real cause is structural, and it is testable here even though layout is
// not: the row was carrying a 130px editable text field (25% of the available
// width) and four buttons, in a column that table auto-layout puts LAST. When the
// table's min-content exceeds the card, the last column is what falls off, and
// `overflow-x: auto` absorbs the difference silently.
//
// So this file asserts the SHAPE that makes reachability possible: no editable
// field in the row, and exactly one destructive action beside the primary one.
// Whether that produces a reachable layout is measured in a real browser —
// workerd has no DOM, so no assertion here can prove pixels.
//
// These read the SERVED row template, for the same reason every other test in
// this suite does: asserting the source would pass while the shipped page stayed
// broken.
// ---------------------------------------------------------------------------

function mockContext() {
  return {
    env: { SUPABASE_URL: "https://test.supabase.co", SUPABASE_ANON_KEY: "k" },
    html: (body: string) =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  } as any;
}

async function clientScript(): Promise<string> {
  const html = await (await dashboardHandler(mockContext())).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script || !script.includes("links-body")) {
    throw new Error("dashboard client script not found in served HTML");
  }
  return script;
}

/** Compiles the shipped `esc()` out of the served script. */
async function loadEsc(): Promise<(v: unknown) => string> {
  const src = await clientScript();
  const start = src.indexOf("function esc(");
  if (start < 0) throw new Error("esc() not found");
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      return new Function(`${src.slice(start, i + 1)}\nreturn esc;`)() as (
        v: unknown,
      ) => string;
    }
  }
  throw new Error("unterminated esc()");
}

/** Renders one links-table row through the shipped template. */
async function renderRow(over: Record<string, unknown> = {}): Promise<string> {
  const script = await clientScript();
  const anchor = "links.map((l) => {";
  const start = script.indexOf(anchor);
  if (start < 0) throw new Error("links.map row template not found");
  const from = start + "links.map(".length;
  const to = script.indexOf('}).join("")', from);
  if (to < 0) throw new Error("end of links.map row template not found");
  const arrow = script.slice(from, to + 1);
  const esc = await loadEsc();
  const render = new Function("esc", `return (${arrow});`)(esc) as (
    l: Record<string, unknown>,
  ) => string;
  return render({
    id: "link-uuid",
    short_code: "abc1234",
    short_url: "https://short.link/abc1234",
    original_url: "https://example.com",
    title: null,
    client_ref: null,
    clicks_count: 5,
    is_active: true,
    expires_at: null,
    ...over,
  });
}

const actionsIn = (html: string) =>
  [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);

/**
 * Splits the rendered template into the visible row and the hidden metrics panel.
 *
 * The template emits BOTH `<tr>`s from one arrow function, so a bare
 * `renderRow()` result contains the panel too. An assertion about "the row"
 * that did not split here would silently pass or fail on the wrong half — which
 * is how an earlier draft of this file appeared to fail after the change had
 * already landed.
 */
function split(row: string): { row: string; panel: string } {
  const at = row.indexOf('<tr id="metrics-');
  if (at < 0) throw new Error("metrics row not found in rendered template");
  return { row: row.slice(0, at), panel: row.slice(at) };
}

/** The links-table header, scoped so the "Stores by Client Ref" table cannot satisfy it. */
async function linksTableHeader(): Promise<string> {
  const html = await (await dashboardHandler(mockContext())).text();
  const table = html.slice(html.indexOf('<table id="links-table"'));
  const head = table.match(/<thead>[\s\S]*?<\/thead>/)?.[0];
  if (!head) throw new Error("links table header not found");
  return head;
}

// ---------------------------------------------------------------------------
// The row carries reading, not editing
// ---------------------------------------------------------------------------

describe("links row — no editable field competes for width", () => {
  it("emits no text input in the row", async () => {
    const { row } = split(await renderRow({ client_ref: "Cafe Central" }));

    // A 130px input per row was 25% of the available width. The client_ref field
    // lives in the metrics panel now.
    expect(row).not.toMatch(/<input[^>]*type="text"/);
  });

  it("emits exactly one button — the destructive one", async () => {
    const { row } = split(await renderRow());

    // The sharpest form of the width guarantee. Four buttons in this cell is
    // what squeezed it to 92.7px and stacked all four vertically; one cannot
    // stack, and it cannot be the column that falls off the edge.
    const buttons = [...row.matchAll(/<button/g)];
    expect(buttons, `row emits ${buttons.length} buttons`).toHaveLength(1);
  });

  it("still renders the client_ref input for the metrics panel to address", async () => {
    const { panel } = split(await renderRow({ id: "abc", client_ref: "Cafe Central" }));

    // It must keep this id: saveClientRef() resolves it by
    // getElementById("client-ref-" + id), and that signature is unchanged.
    expect(panel).toContain('id="client-ref-abc"');
    expect(panel).toContain('value="Cafe Central"');
  });

  it("keeps exactly one destructive action in the row", async () => {
    const { row } = split(await renderRow());

    const destructive = [...row.matchAll(/class="btn-sm btn-danger"/g)];
    expect(destructive, "the row must carry one destructive action, not several").toHaveLength(1);
    expect(actionsIn(row).filter((a) => a === "delete")).toHaveLength(1);
  });

  it("does not stack a second and third action beside the primary one", async () => {
    const { row } = split(await renderRow());

    // The primary action is the clicks link, which opens the metrics panel.
    expect(actionsIn(row)).toContain("metrics");
    // Copy-to-clipboard on the code stays: it is the fastest path to the URL.
    expect(actionsIn(row)).toContain("copy");
    // And nothing else competes for the cell.
    expect([...new Set(actionsIn(row))].sort()).toEqual(["copy", "delete", "metrics"]);
  });
});

// ---------------------------------------------------------------------------
// What left the row went somewhere, not nowhere
// ---------------------------------------------------------------------------

describe("the metrics panel is where the removed controls went", () => {
  it("carries the enable/disable state change", async () => {
    const { panel } = split(await renderRow({ id: "abc", is_active: true }));

    expect(panel).toContain('data-action="toggle"');
    expect(panel).toContain('data-id="abc"');
    // Deactivating a tag is the single most common lifecycle operation in the
    // NFC use case; it must remain a first-class, reachable control.
    expect(panel).toContain("Disable");
  });

  it("carries the save control for the client-ref field", async () => {
    const { panel } = split(await renderRow({ id: "abc" }));

    expect(panel).toContain('data-action="save-client-ref"');
  });

  it("keeps the QR print-sheet entry point reachable", async () => {
    const { row, panel } = split(await renderRow({ short_url: "https://short.link/abc1234" }));

    // The QR code is how a tag reaches the physical world. It is not a reading
    // affordance, so it moved with the others -- but it must not disappear.
    expect(actionsIn(row)).not.toContain("qr");
    expect(panel).toContain('data-action="qr"');
    expect(panel).toContain('data-url="https://short.link/abc1234"');
  });

  it("states what deactivating a tag actually does, next to the control", async () => {
    const { panel } = split(await renderRow({ id: "abc", is_active: true }));

    // The reason the redirect is a 302 and not a 301, said in the place where
    // the decision is made. It was absent from the interface entirely.
    expect(panel).toContain("sticker");
    expect(panel).toContain("cache");
  });

  it("says the other thing when re-enabling, not the same warning", async () => {
    const { panel } = split(await renderRow({ id: "abc", is_active: false }));

    expect(panel).toContain("Enable");
    // A confirmation that says "your printed sticker keeps working" while the
    // button reads Enable would be worse than saying nothing.
    expect(panel).not.toContain("stops working");
  });

  it("keeps the three breakdown panels and the visitor estimate intact", async () => {
    const { panel } = split(await renderRow({ id: "abc" }));

    for (const panelId of ["visitors-abc", "country-abc", "device-abc", "source-abc"]) {
      expect(panel).toContain(panelId);
    }
  });
});

// ---------------------------------------------------------------------------
// The controls that moved are still delegated, not re-wired
// ---------------------------------------------------------------------------

describe("moving controls did not break delegation", () => {
  it("keeps exactly one click listener on the stable ancestor", async () => {
    const script = await clientScript();

    const listeners = script.match(/getElementById\("links-body"\)[\s\S]{0,40}?addEventListener/g);
    expect(listeners).toHaveLength(1);
    expect(script).toContain('closest("[data-action]")');
  });

  it("still dispatches every action from the shared switch", async () => {
    const script = await clientScript();

    // The metrics panel is already inside the links tbody, so the same delegated
    // handler reaches controls that moved into it. No new wiring was needed, and
    // none may be added.
    for (const action of ["copy", "qr", "metrics", "save-client-ref", "toggle", "delete"]) {
      expect(script, `case "${action}":`).toContain(`case "${action}":`);
    }
  });

  it("adds no inline handler to the row or the panel", async () => {
    const row = await renderRow();

    expect(row).not.toContain("onclick");
    expect(row).not.toMatch(/\son[a-z]+\s*=\s*["']/);
  });

  it("still escapes client_ref where it now lives", async () => {
    const row = await renderRow({ client_ref: '"><img src=x onerror=alert(1)>' });

    expect(row).not.toContain("<img");
    expect(row).toContain("&quot;&gt;&lt;img");
  });
});

// ---------------------------------------------------------------------------
// The table can now fit
// ---------------------------------------------------------------------------

describe("the table header no longer reserves a column that is gone", () => {
  it("drops the Client Ref column header from the links table", async () => {
    // Scoped to the links table: the "Stores by Client Ref" rollup below it is a
    // different table and legitimately has that column.
    expect(await linksTableHeader()).not.toContain("Client Ref");
  });

  it("keeps the four reading headers in order", async () => {
    const head = await linksTableHeader();

    for (const header of ["Short Code", "URL", "Clicks", "Status"]) {
      expect(head).toContain(`>${header}<`);
    }
  });

  it("leaves the stores-by-client-ref rollup with its own header", async () => {
    const html = await (await dashboardHandler(mockContext())).text();

    expect(html).toContain("Stores by Client Ref");
  });
});