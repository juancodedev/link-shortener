import { describe, it, expect } from "vitest";
import { dashboardHandler } from "../../src/handlers/dashboard";

// ---------------------------------------------------------------------------
// Links row reachability.
//
// The row once carried an editable client-ref input and four buttons in its
// last column, which pushed the actions off a phone screen. The row and its
// panel are the React Links island now (odd/tasks/dashboard-react.md T3a);
// what a row and a panel render — two short buttons, no text input, the
// controls in the panel, three hideable cells, the header without a Client
// Ref column — is pinned in web/test/links/rows.test.tsx.
//
// What stays here is what the server still serves: the stylesheet rule that
// hides those cells, and the client rollup's own table.
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

async function serve(): Promise<string> {
  return (await dashboardHandler(mockContext())).text();
}

describe("the client_ref rollup keeps its own table", () => {
  it("leaves the stores-by-client-ref rollup with its own header", async () => {
    expect(await serve()).toContain("Stores by Client Ref");
  });
});

describe("narrow screens hide informational columns, never the actions", () => {
  it("applies only below 768px", async () => {
    expect(await serve()).toMatch(/@media \(max-width: 767px\)\s*\{\s*\.hide-sm\s*\{\s*display:\s*none;?\s*\}/);
  });
});
