/**
 * The test double for web/src/api.ts, installed for every web test by
 * ./setup.ts. Island tests answer requests through `stubApi(handler)` and hold
 * the auth gate with `stubApiReady(promise)`, the way they used to assign
 * window.__api and window.__apiReady. A stub keeps the real helper's contract:
 * it THROWS on a non-ok status (harnesses build that in), and the gate is read
 * at call time, so a test can swap it before a load starts.
 *
 * Module state lives per test file (vitest isolates modules per file), the
 * same lifetime the old window properties had in each file's jsdom window.
 * Tests of the real module (web/test/api.test.ts, web/test/shell) unmock it.
 */
export type ApiFn = (method: string, path: string, body?: unknown) => Promise<Response>;

let impl: ApiFn | undefined;
let ready: Promise<void> = Promise.resolve();

/** Answers every request with `fn`; `undefined` is the page before the session resolves. */
export function stubApi(fn: ApiFn | undefined): void {
  impl = fn;
}

/** The handler currently answering, so a helper can put it back. */
export function stubbedApi(): ApiFn | undefined {
  return impl;
}

/** The auth gate every island awaits before its first request. */
export function stubApiReady(gate: Promise<void>): void {
  ready = gate;
}

/** The gate currently installed, so a helper can put it back. */
export function stubbedApiReady(): Promise<void> {
  return ready;
}

/** Stands in for web/src/api.ts. */
export const fakeApiModule = {
  api(method: string, path: string, body?: unknown): Promise<Response> {
    if (!impl) throw new TypeError("api is not available before the auth gate opens");
    return impl(method, path, body);
  },
  whenApiReady(): Promise<void> {
    return ready;
  },
  openApi(): void {},
};
