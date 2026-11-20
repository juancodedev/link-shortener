import type { Handler } from "hono";
import type { AppEnv } from "../types/env";
import { SUPABASE_JS_SCRIPT } from "./supabase-cdn";
import { renderReviewCard } from "../cards/render";

/**
 * Serves the landing page at `GET /`: what the review cards are, for the owner
 * of a local business who has never seen them.
 *
 * - The hero is a real card, drawn by the same renderer the print sheet uses
 *   (src/cards/render.ts); its QR opens /signup on this host.
 * - "Lo que ve tu cliente" repeats the action screen's labels verbatim
 *   (src/handlers/action-screen.ts), so the page never promises a screen the
 *   diner will not see.
 * - The compliance section is the product's real position: every diner sees
 *   the Google button, whatever they rated. Do not rewrite it into "protect
 *   your rating": routing unhappy diners away from Google is review gating,
 *   which Google prohibits, and the product deliberately does not do it.
 * - Inline CSS and system fonts only: no external stylesheet. The one external
 *   script is the Supabase client, which swaps the guest view for the
 *   signed-in one.
 */
export const landingHandler: Handler<{ Bindings: AppEnv }> = (c) => {
  const signupUrl = originOf(c.req?.url) + "/signup";
  const card = renderReviewCard({ shortUrl: signupUrl, design: "official", variant: "qr" });

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tarjetas de reseñas con QR para tu local — Link Shortener</title>
  <meta name="description" content="Una tarjeta con QR en cada mesa. Tu cliente califica su visita y elige: publicar su reseña en Google o escribirte directo.">
  <style>
    :root {
      --pizarra: #1f3b34;
      --pizarra-alta: #2b4d44;
      --papel: #fbfaf6;
      --tinta: #1c2421;
      --gris: #55615c;
      --linea: #dde2dc;
      --estrella: #f2b01e;
      --sobre-pizarra: #e9efe9;
      --serif: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
      --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--sans);
      font-size: 1.0625rem;
      line-height: 1.6;
      color: var(--tinta);
      background: var(--papel);
      -webkit-font-smoothing: antialiased;
    }

    h1, h2, h3 { font-family: var(--serif); font-weight: 600; line-height: 1.15; }
    h2 { font-size: clamp(1.75rem, 3.5vw, 2.4rem); margin-bottom: 1rem; }
    h3 { font-size: 1.25rem; margin-bottom: 0.35rem; }
    p { max-width: 62ch; }

    a { color: inherit; }
    :focus-visible { outline: 3px solid var(--estrella); outline-offset: 3px; border-radius: 4px; }

    .wrap { max-width: 1120px; margin: 0 auto; padding: 0 1.25rem; }

    /* ---- Buttons ---- */
    .btn {
      display: inline-block;
      padding: 0.8rem 1.4rem;
      border-radius: 999px;
      font: 600 1rem/1.2 var(--sans);
      text-decoration: none;
      border: 2px solid transparent;
      cursor: pointer;
    }
    .btn-primary { background: var(--estrella); color: var(--tinta); }
    .btn-primary:hover { background: #ffc43d; }
    .btn-ghost { border-color: currentColor; background: transparent; color: inherit; }
    .btn-ghost:hover { background: rgba(255, 255, 255, 0.08); }
    .btn-dark { background: var(--pizarra); color: var(--papel); }
    .btn-dark:hover { background: var(--pizarra-alta); }
    .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.75rem; }

    /* ---- Hero: the card on the table ---- */
    .hero { background: var(--pizarra); color: var(--sobre-pizarra); }
    .topline { display: flex; justify-content: space-between; align-items: center; padding: 1.25rem 0; }
    .brand { font-family: var(--serif); font-size: 1.2rem; font-weight: 600; color: var(--papel); text-decoration: none; }
    .topline a.login { font-weight: 600; text-decoration: none; }
    .topline a.login:hover { text-decoration: underline; }
    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
      gap: 3rem;
      align-items: center;
      padding: 3.5rem 0 5rem;
    }
    .hero h1 { font-size: clamp(2.4rem, 6vw, 4.2rem); color: var(--papel); max-width: 14ch; }
    .hero .lead { font-size: 1.2rem; margin-top: 1.25rem; max-width: 46ch; }
    .hero .note { margin-top: 1rem; font-size: 0.95rem; opacity: 0.85; }
    .table-card { justify-self: center; width: min(340px, 80vw); }
    .table-card .paper {
      aspect-ratio: 1;
      background: #fff;
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.2), 0 24px 40px -12px rgba(0, 0, 0, 0.55);
      transform: rotate(-3deg);
      animation: settle 700ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }
    .table-card svg { width: 100%; height: 100%; }
    .table-card figcaption { margin-top: 1.4rem; text-align: center; font-size: 0.9rem; color: var(--sobre-pizarra); }
    @keyframes settle {
      from { transform: translateY(-24px) rotate(-9deg); opacity: 0; }
      to { transform: rotate(-3deg); opacity: 1; }
    }

    /* ---- Sections ---- */
    section.band { padding: 4.5rem 0; }
    section.band + section.band { border-top: 1px solid var(--linea); }
    .intro { color: var(--gris); margin-bottom: 2.25rem; }

    .steps { list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2rem; counter-reset: paso; }
    .steps li { counter-increment: paso; }
    .steps li::before {
      content: counter(paso);
      display: grid;
      place-items: center;
      width: 2.4rem;
      height: 2.4rem;
      margin-bottom: 0.9rem;
      border-radius: 50%;
      background: var(--pizarra);
      color: var(--papel);
      font: 600 1.1rem/1 var(--serif);
    }
    .steps p { color: var(--gris); }

    /* ---- What the diner sees ---- */
    .diner { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); gap: 3rem; align-items: center; }
    .phone {
      justify-self: center;
      width: min(300px, 100%);
      border: 10px solid var(--tinta);
      border-radius: 32px;
      background: #fff;
      padding: 1.75rem 1.25rem 1.5rem;
      text-align: center;
      font-family: var(--sans);
    }
    .phone .place { font-weight: 700; font-size: 1.15rem; }
    .phone .ask { color: var(--gris); font-size: 0.95rem; margin: 0.25rem auto 0.75rem; }
    .phone .stars { color: var(--estrella); font-size: 1.9rem; letter-spacing: 0.15rem; }
    .phone .fake-btn { display: block; margin-top: 0.75rem; padding: 0.7rem; border-radius: 10px; font-weight: 600; font-size: 0.95rem; }
    .phone .google { background: #1a73e8; color: #fff; }
    .phone .private { border: 1px solid var(--linea); color: var(--tinta); }
    .phone .small { font-size: 0.8rem; color: var(--gris); margin: 0.9rem auto 0; }

    /* ---- The honest part ---- */
    .fair { background: #f1f4ef; }
    .fair .rule { font-family: var(--serif); font-size: clamp(1.3rem, 2.4vw, 1.65rem); line-height: 1.35; max-width: 34ch; margin-bottom: 1.25rem; }
    .fair p + p { margin-top: 0.9rem; }

    /* ---- Dashboard ---- */
    .features { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.75rem 3rem; }
    .features dt { font-weight: 700; }
    .features dd { color: var(--gris); }

    /* ---- Closing ---- */
    .closing { text-align: left; }
    .closing p { color: var(--gris); }

    footer { padding: 2rem 0 2.5rem; font-size: 0.9rem; color: var(--gris); border-top: 1px solid var(--linea); }

    @media (max-width: 860px) {
      .hero-grid, .diner { grid-template-columns: minmax(0, 1fr); gap: 2.5rem; }
      .hero-grid { padding: 2rem 0 3.5rem; }
      .diner > div:last-child { order: -1; }
      .steps, .features { grid-template-columns: minmax(0, 1fr); }
      section.band { padding: 3.25rem 0; }
    }

    @media (prefers-reduced-motion: reduce) {
      .table-card .paper { animation: none; }
    }
  </style>
</head>
<body>
  <header class="hero">
    <div class="wrap">
      <div class="topline">
        <a class="brand" href="/">Link Shortener</a>
        <a class="login" href="/login">Iniciar sesión</a>
      </div>
      <div class="hero-grid">
        <div>
          <h1>Las reseñas se piden en la mesa.</h1>
          <p class="lead">Una tarjeta con QR en cada mesa o mostrador. Tu cliente la escanea, califica su visita y elige: publicar su reseña en Google o escribirte directo a ti.</p>

          <!-- Logged-out state -->
          <div id="guest-view">
            <div class="actions">
              <a href="/signup" class="btn btn-primary">Crear cuenta</a>
              <a href="/login" class="btn btn-ghost">Iniciar sesión</a>
            </div>
          </div>

          <!-- Logged-in state (hidden by default, shown by JS) -->
          <div id="user-view" style="display:none;">
            <p class="note" id="user-greeting"></p>
            <div class="actions">
              <a href="/dashboard" class="btn btn-primary">Ir al panel</a>
              <button id="logout-btn" class="btn btn-ghost">Cerrar sesión</button>
            </div>
          </div>
        </div>

        <figure class="table-card">
          <div class="paper">${card}</div>
          <figcaption>Así se ve impresa, a 10 × 10 cm. Su QR abre el registro.</figcaption>
        </figure>
      </div>
    </div>
  </header>

  <main>
    <section class="band" aria-labelledby="como">
      <div class="wrap">
        <h2 id="como">Cómo funciona</h2>
        <p class="intro">Tres pasos, y el segundo lo da tu cliente.</p>
        <ol class="steps">
          <li>
            <h3>Imprimes tus tarjetas</h3>
            <p>Eliges el diseño y la hoja, y las imprimes tú mismo a 10 × 10 cm, con guías para recortar.</p>
          </li>
          <li>
            <h3>Tu cliente escanea</h3>
            <p>Ve el nombre de tu local, cinco estrellas y dos botones. No descarga nada ni crea una cuenta.</p>
          </li>
          <li>
            <h3>Tú ves qué pasó</h3>
            <p>Cada escaneo, calificación y comentario llega a tu panel, separado por local y sucursal.</p>
          </li>
        </ol>
      </div>
    </section>

    <section class="band" aria-labelledby="cliente">
      <div class="wrap diner">
        <div class="phone" aria-hidden="true">
          <p class="place">Café del Puerto</p>
          <p class="ask">¿Cómo fue tu experiencia hoy?</p>
          <p class="stars">★★★★★</p>
          <span class="fake-btn google">Publicar reseña en Google</span>
          <span class="fake-btn private">Enviar comentario privado</span>
          <p class="small">Tus comentarios los recibe directamente el local.</p>
        </div>
        <div>
          <h2 id="cliente">Lo que ve tu cliente</h2>
          <p>Una sola pantalla, en su celular, con el nombre de tu local. Las estrellas son opcionales y quedan registradas para ti.</p>
          <p style="margin-top:0.9rem">Si elige Google, llega directo a escribir su reseña en tu perfil. Si prefiere hablarte a ti, te deja un mensaje y, si quiere, su teléfono o correo para que lo contactes.</p>
        </div>
      </div>
    </section>

    <section class="band fair" aria-labelledby="justo">
      <div class="wrap">
        <h2 id="justo">Todos ven el botón de Google</h2>
        <p class="rule">Con una estrella o con cinco, cada cliente ve las mismas dos opciones, en el mismo orden.</p>
        <p>Hay sistemas que muestran Google solo a quien quedó contento y esconden el resto. Google lo llama filtrado de reseñas y lo prohíbe: un perfil que lo hace puede perder sus reseñas.</p>
        <p>Aquí no se filtra a nadie. El comentario privado existe porque hay clientes que prefieren contarte un problema a ti antes que publicarlo, y tú prefieres enterarte.</p>
      </div>
    </section>

    <section class="band" aria-labelledby="panel">
      <div class="wrap">
        <h2 id="panel">Lo que tienes en tu panel</h2>
        <p class="intro">Para decidir con datos de tu propio local, no con intuición.</p>
        <dl class="features">
          <div>
            <dt>Satisfacción</dt>
            <dd>El promedio de estrellas de quienes calificaron, y cuántos lo hicieron.</dd>
          </div>
          <div>
            <dt>Horas de más movimiento</dt>
            <dd>Los escaneos por hora del día, para saber cuándo pasa tu gente.</dd>
          </div>
          <div>
            <dt>Comentarios privados</dt>
            <dd>Cada mensaje con su contacto, filtrable por local y sucursal, y exportable a CSV.</dd>
          </div>
          <div>
            <dt>Locales y sucursales</dt>
            <dd>Cada tarjeta pertenece a una sucursal, así sabes de dónde viene cada opinión.</dd>
          </div>
          <div>
            <dt>Cambios sin reimprimir</dt>
            <dd>El QR apunta a tu enlace, no a Google directo: si cambia tu perfil, cambias el destino y la tarjeta impresa sigue sirviendo.</dd>
          </div>
        </dl>
      </div>
    </section>

    <section class="band closing" aria-labelledby="empezar">
      <div class="wrap">
        <h2 id="empezar">Empieza con tu primera hoja de tarjetas</h2>
        <p>Creas tu cuenta e imprimes tus tarjetas. Al dejar cada una en su mesa, le asignas el enlace de reseñas de Google de tu local, y puedes cambiarlo cuando quieras.</p>
        <div class="actions">
          <a href="/signup" class="btn btn-dark">Crear cuenta</a>
        </div>
      </div>
    </section>
  </main>

  <footer>
    <div class="wrap">Link Shortener. Hecho con Cloudflare Workers y Supabase.</div>
  </footer>

  ${SUPABASE_JS_SCRIPT}
  <script>
    (async () => {
      if (!window.supabase) return;
      var sb = window.supabase.createClient("${c.env.SUPABASE_URL}", "${c.env.SUPABASE_ANON_KEY}");

      const { data: { session } } = await sb.auth.getSession();
      const guestView = document.getElementById("guest-view");
      const userView = document.getElementById("user-view");
      const greeting = document.getElementById("user-greeting");

      if (session?.user) {
        guestView.style.display = "none";
        userView.style.display = "";
        greeting.textContent = "Sesión iniciada como " + (session.user.email || "tu cuenta") + ".";

        document.getElementById("logout-btn").addEventListener("click", async () => {
          await sb.auth.signOut();
          window.location.reload();
        });
      }

      // Listen for auth changes (login from other tab, etc.)
      sb.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_IN" && session) {
          window.location.reload();
        } else if (event === "SIGNED_OUT") {
          window.location.reload();
        }
      });
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

/** The page's own origin, so the hero card's QR opens /signup on this host; empty if the URL is unknown. */
function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}
