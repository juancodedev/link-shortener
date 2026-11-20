import { describe, it, expect } from "vitest";
import { dashboardHandler } from "../../src/handlers/dashboard";
import { DASHBOARD_CSS } from "./dashboard-stylesheet";

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
// hides those cells. The client rollup's table is the Overview island's
// (web/test/overview/overview.test.tsx).
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

describe("narrow screens hide informational columns, never the actions", () => {
  it("applies only below 768px", async () => {
    expect(DASHBOARD_CSS).toMatch(/@media \(max-width: 767px\)\s*\{\s*\.hide-sm\s*\{\s*display:\s*none;?\s*\}/);
  });
});
