import { describe, it, expect } from "vitest";
import { landingHandler } from "../../src/handlers/landing";
import actionScreenSource from "../../src/handlers/action-screen.ts?raw";

// ---------------------------------------------------------------------------
// The landing page at GET /: the review cards, pitched to the owner of a local
// business (REQ-LP001, rewritten for the reviews service).
// ---------------------------------------------------------------------------

function mockContext(supabaseUrl = "https://test.supabase.co", url = "https://example.com/") {
  return {
    env: { SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: "test-anon-key" },
    req: { url },
  } as any;
}

async function page(c = mockContext()): Promise<string> {
  return (await landingHandler(c)).text();
}

describe("landingHandler", () => {
  it("returns HTTP 200 with text/html content type", async () => {
    const response = await landingHandler(mockContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("starts with DOCTYPE html, in Spanish, with a responsive viewport", async () => {
    const text = await page();

    expect(text.trimStart()).toMatch(/^<!DOCTYPE html>/i);
    expect(text).toContain('<html lang="es">');
    expect(text).toContain("width=device-width");
  });

  it("carries the brand, Más Reseñas, in the title, the top bar and the footer", async () => {
    const text = await page();

    expect(text).toContain("<title>Tarjetas de reseñas con QR para tu local — Más Reseñas</title>");
    expect(text).toContain('<a class="brand" href="/">Más Reseñas</a>');
    expect(text).toContain('Más Reseñas. Desarrollado por <a href="https://www.juancode.dev">juancode.dev</a>.');
    expect(text).not.toContain("Link Shortener");
  });

  it("says what the service is in the first heading", async () => {
    const text = await page();

    expect(text).toContain("<h1>Las reseñas se piden en la mesa.</h1>");
    expect(text).toContain("publicar su reseña en Google o escribirte directo a ti");
  });

  it("offers sign-up and login to a visitor", async () => {
    const text = await page();
    const guest = text.slice(text.indexOf('id="guest-view"'), text.indexOf('id="user-view"'));

    expect(guest).toContain('<a href="/signup" class="btn btn-primary">Crear cuenta</a>');
    expect(guest).toContain('<a href="/login" class="btn btn-ghost">Iniciar sesión</a>');
  });

  it("keeps a hidden signed-in view with the dashboard and logout", async () => {
    const text = await page();

    expect(text).toContain('<div id="user-view" style="display:none;">');
    expect(text).toContain('<a href="/dashboard" class="btn btn-primary">Ir al panel</a>');
    expect(text).toContain('id="logout-btn"');
  });

  it("shows a real review card whose QR opens sign-up on this host", async () => {
    const text = await page(mockContext("https://test.supabase.co", "https://reviews.example.com/?x=1"));
    const figure = text.slice(text.indexOf('<figure class="table-card">'), text.indexOf("</figure>"));

    expect(figure).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"');
    expect(figure).toContain("Escanea con tu cámara");
    // The QR is a path, so the URL itself is not in the markup.
    expect(figure).not.toContain("reviews.example.com");
  });

  it("still renders when the request URL is unknown", async () => {
    const response = await landingHandler({ env: { SUPABASE_URL: "https://test.supabase.co" }, req: {} } as any);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<figure class="table-card">');
  });

  it("lays out how it works as three ordered steps", async () => {
    const text = await page();
    const steps = text.slice(text.indexOf('<ol class="steps">'), text.indexOf("</ol>"));

    expect([...steps.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1])).toEqual([
      "Imprimes tus tarjetas",
      "Tu cliente escanea",
      "Tú ves qué pasó",
    ]);
  });

  it("shows the diner's screen with the action screen's own labels", async () => {
    const text = await page();

    // Each label must also be on the real screen, so the page cannot drift
    // into promising a screen the diner will not see.
    for (const label of ["¿Cómo fue tu experiencia hoy?", "Publicar reseña en Google", "Enviar comentario privado", "Tus comentarios los recibe directamente el local."]) {
      expect(text).toContain(label);
      expect(actionScreenSource).toContain(label);
    }
  });

  it("states that every diner sees the Google button, and never promises to filter reviews", async () => {
    const text = await page();

    expect(text).toContain("Todos ven el botón de Google");
    expect(text).toContain("Con una estrella o con cinco, cada cliente ve las mismas dos opciones");
    expect(text).not.toMatch(/protege tu (reputación|calificación)|evita (las )?malas reseñas|solo (a )?los clientes felices/i);
  });

  it("loads only the Supabase browser client as an external script, and no external stylesheet", async () => {
    const text = await page();
    const externalScripts = [...text.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)].map((m) => m[1]);

    expect(externalScripts).toEqual(["https://unpkg.com/@supabase/supabase-js@2.119.0/dist/umd/supabase.js"]);
    expect(text).not.toMatch(/<link[^>]*stylesheet[^>]*href="https?:\/\//i);
  });

  it("bootstraps the signed-in view from the Supabase session", async () => {
    const text = await page();

    expect(text).toContain("sb.auth.getSession()");
    expect(text).toContain("sb.auth.onAuthStateChange");
    expect(text).toContain("https://test.supabase.co");
    expect(text).toContain('"Sesión iniciada como "');
  });

  it("respects reduced motion for the card's entrance", async () => {
    const text = await page();

    expect(text).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.table-card \.paper\s*\{\s*animation:\s*none;/);
  });

  it("credits the developer in the footer, linking to juancode.dev", async () => {
    const text = await page();
    const footer = text.slice(text.indexOf("<footer>"), text.indexOf("</footer>"));

    expect(footer).toContain('Desarrollado por <a href="https://www.juancode.dev">juancode.dev</a>');
    expect(footer).not.toContain("Hecho con");
  });
});
