import { describe, expect, it } from "vitest";
import { landingHandler } from "../../src/handlers/landing";
import { authCallbackHandler, loginHandler, resetPasswordHandler, signupHandler } from "../../src/handlers/auth";
import { dashboardHandler } from "../../src/handlers/dashboard";
import gateSource from "../../src/handlers/gate.ts?raw";
import redirectSource from "../../src/handlers/redirect.ts?raw";
import actionScreenSource from "../../src/handlers/action-screen.ts?raw";
import setupSource from "../../src/handlers/setup.ts?raw";

// The brand's icons and link preview: Más Reseñas pages carry the favicon,
// the landing also the Open Graph card; the pages a business's own customers
// see carry the business's name and none of ours.

function context(url = "https://masresenas.cl/") {
  return {
    env: { SUPABASE_URL: "https://test.supabase.co", SUPABASE_ANON_KEY: "k" },
    req: { url, query: (name: string) => new URL(url).searchParams.get(name) ?? undefined },
    html: (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } }),
  } as any;
}

async function render(handler: (c: any) => Response | Promise<Response>, url?: string): Promise<string> {
  return (await handler(context(url))).text();
}

const ICONS = [
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
];

describe("brand icons and link preview", () => {
  it.each([
    ["landing", landingHandler],
    ["signup", signupHandler],
    ["login", loginHandler],
    ["reset password", resetPasswordHandler],
    ["auth callback", authCallbackHandler],
    ["dashboard", dashboardHandler],
  ])("links the favicon on the %s page, inside <head>", async (_name, handler) => {
    const html = await render(handler);
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    for (const tag of ICONS) expect(head).toContain(tag);
  });

  it("gives the landing an Open Graph and Twitter card with an absolute image URL", async () => {
    const html = await render(landingHandler, "https://masresenas.cl/?ref=x");

    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain('<meta property="og:site_name" content="Más Reseñas">');
    expect(html).toContain('<meta property="og:title" content="Tarjetas de reseñas con QR para tu local — Más Reseñas">');
    expect(html).toContain('<meta property="og:url" content="https://masresenas.cl/">');
    expect(html).toContain('<meta property="og:image" content="https://masresenas.cl/og.png">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain('<meta property="og:locale" content="es_CL">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toMatch(/<meta property="og:description" content="Una tarjeta con QR en cada mesa\./);
  });

  it.each([
    ["gate", gateSource],
    ["redirect", redirectSource],
    ["action screen", actionScreenSource],
    ["setup", setupSource],
  ])("keeps our brand off the %s page the business's customers see", (_name, source) => {
    expect(source).not.toContain("favicon");
    expect(source).not.toContain("og:image");
  });

  it("ships the assets the tags point to, and no /favicon.ico", () => {
    // The Workers test pool has no file system: vite lists the folder instead.
    const shipped = Object.keys(import.meta.glob("../../web/public/*", { query: "?url", eager: true }))
      .map((path) => path.split("/").pop())
      .sort();
    expect(shipped).toEqual(["apple-touch-icon.png", "favicon-32.png", "favicon.svg", "og.png"]);
  });
});
