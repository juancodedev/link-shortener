/**
 * The Supabase browser client the server-rendered pages load (login, signup,
 * password reset, auth callback, landing, setup).
 *
 * Pinned to the exact version package.json declares, which is also the one
 * the dashboard bundles (web/src/shell/auth.ts): both read the session the
 * login page stores, so they must agree on its format. The integrity hash is
 * the sha384 of dist/umd/supabase.js in that npm release; bump the version
 * and the hash together (test/handlers/supabase-cdn.test.ts pins the version).
 */
export const SUPABASE_JS_URL = "https://unpkg.com/@supabase/supabase-js@2.119.0/dist/umd/supabase.js";

const SUPABASE_JS_INTEGRITY = "sha384-uteMfOloLDGt042uDz+xHGF3ym63/WQ6rFq7murQRG8Ih7QrXGEGNtWd8688sb4O";

export const SUPABASE_JS_SCRIPT = `<script src="${SUPABASE_JS_URL}" integrity="${SUPABASE_JS_INTEGRITY}" crossorigin="anonymous"></script>`;
