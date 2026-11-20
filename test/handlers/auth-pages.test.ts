import { describe, expect, it } from "vitest";
import {
  authCallbackHandler,
  loginHandler,
  resetPasswordHandler,
  signupHandler,
} from "../../src/handlers/auth";

// The account pages (sign-up, login, password reset, email confirmation) are
// served in Spanish under the "Más Reseñas" brand.

function render(handler: (c: any) => Response | Promise<Response>, url = "https://example.com/") {
  return Promise.resolve(
    handler({
      env: { SUPABASE_URL: "https://test.supabase.co", SUPABASE_ANON_KEY: "k" },
      req: { url, query: (name: string) => new URL(url).searchParams.get(name) ?? undefined },
      html: (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } }),
    }),
  ).then((res) => res.text());
}

describe("account pages in Spanish", () => {
  it.each([
    ["signup", () => render(signupHandler), ["<title>Crear cuenta — Más Reseñas</title>", ">Crear cuenta</button>", ">Correo</label>", ">Contraseña</label>"]],
    ["login", () => render(loginHandler), ["<title>Iniciar sesión — Más Reseñas</title>", ">Iniciar sesión</button>", "¿Olvidaste tu contraseña?"]],
    ["reset request", () => render(resetPasswordHandler, "https://example.com/reset-password"), ["<title>Restablecer contraseña — Más Reseñas</title>", ">Enviar enlace</button>"]],
    ["reset callback", () => render(resetPasswordHandler, "https://example.com/reset-password?type=recovery"), ["<title>Nueva contraseña — Más Reseñas</title>", ">Actualizar contraseña</button>"]],
    ["auth callback", () => render(authCallbackHandler), ["<title>Correo confirmado — Más Reseñas</title>", "Ir a iniciar sesión"]],
  ])("%s page is Spanish and branded Más Reseñas", async (_name, load, markers) => {
    const html = await load();

    expect(html).toContain('<html lang="es">');
    expect(html).toContain("Más Reseñas");
    expect(html).not.toContain("Link Shortener");
    for (const marker of markers) expect(html).toContain(marker);
  });
});
