import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/client", () => ({ withClient: vi.fn() }));
vi.mock("../../src/cache/shortcode", () => ({ invalidateCachedRegistryEntry: vi.fn() }));

import { withClient } from "../../src/db/client";
import { invalidateCachedRegistryEntry } from "../../src/cache/shortcode";
import { listTenantSubscriptions, setTenantSubscription } from "../../src/handlers/ops";

const TOKEN = "ops-token-abc123";

function ctx(opts: {
  token?: string | null;
  body?: unknown;
  rawBody?: string;
} = {}) {
  const jsonFn = vi.fn().mockImplementation(
    (b: unknown, s: number) => new Response(JSON.stringify(b), { status: s }),
  );
  const headerFn = vi.fn((name: string) => {
    if (name.toLowerCase() !== "authorization") return undefined;
    if (opts.token === null) return undefined;
    return `Bearer ${opts.token ?? TOKEN}`;
  });
  return {
    c: {
      req: {
        header: headerFn,
        json: vi.fn().mockResolvedValue(opts.body ?? {}),
        raw: new Request("https://x/api/ops", { method: "POST" }),
        text: vi.fn().mockResolvedValue(opts.rawBody ?? "{}"),
      },
      env: { OPERATIONS_TOKEN: TOKEN } as any,
      json: jsonFn,
    } as any,
    jsonFn,
  };
}

/** Answers the UPDATE then the code list, the two queries the setter runs. */
function db(updateRows: unknown[], codes: string[] = []) {
  let call = 0;
  const seen: { sql: string; params?: unknown[] }[] = [];
  vi.mocked(withClient).mockImplementation(async (_e: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
        seen.push({ sql, params });
        call += 1;
        if (/UPDATE public\.tenants/i.test(sql)) return Promise.resolve({ rows: updateRows });
        if (/short_code_registry WHERE tenant_id/i.test(sql)) {
          return Promise.resolve({ rows: codes.map((c) => ({ short_code: c })) });
        }
        return Promise.resolve({ rows: [] });
      }),
    }),
  );
  return seen;
}

describe("operator routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(invalidateCachedRegistryEntry).mockResolvedValue(undefined);
  });

  describe("authentication", () => {
    // The capability that matters: `active` is exactly what a non-paying
    // customer would grant themselves, so this route must never accept a
    // customer credential — not even the tenant owner's.
    it("refuses a request with no token", async () => {
      const { c, jsonFn } = ctx({ token: null });
      await setTenantSubscription(c, vi.fn() as any);
      expect(jsonFn).toHaveBeenCalledWith({ error: "forbidden" }, 403);
    });

    it("refuses a wrong token", async () => {
      const { c, jsonFn } = ctx({ token: "not-the-token" });
      await setTenantSubscription(c, vi.fn() as any);
      expect(jsonFn).toHaveBeenCalledWith({ error: "forbidden" }, 403);
      expect(withClient).not.toHaveBeenCalled();
    });

    // A prefix of the real token must not pass. Without hashing both sides the
    // comparison would exit early on the first differing byte.
    it("refuses a token that is a prefix of the real one", async () => {
      const { c, jsonFn } = ctx({ token: TOKEN.slice(0, -1) });
      await setTenantSubscription(c, vi.fn() as any);
      expect(jsonFn).toHaveBeenCalledWith({ error: "forbidden" }, 403);
    });

    it("refuses a token that extends the real one", async () => {
      const { c, jsonFn } = ctx({ token: TOKEN + "x" });
      await setTenantSubscription(c, vi.fn() as any);
      expect(jsonFn).toHaveBeenCalledWith({ error: "forbidden" }, 403);
    });

    // Fail closed: an unset secret disables the route instead of letting
    // anything through.
    it("refuses everything when OPERATIONS_TOKEN is not configured", async () => {
      const { c, jsonFn } = ctx();
      c.env = {} as any;
      await setTenantSubscription(c, vi.fn() as any);
      expect(jsonFn).toHaveBeenCalledWith({ error: "service_unavailable" }, 503);
      expect(withClient).not.toHaveBeenCalled();
    });

    it("accepts the correct token", async () => {
      db([{ id: "t1" }]);
      const { c, jsonFn } = ctx({ body: { slug: "mesa", status: "past_due" } });
      await setTenantSubscription(c, vi.fn() as any);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "mesa", status: "past_due" }),
      );
    });

    it("guards the list route too", async () => {
      const { c, jsonFn } = ctx({ token: "wrong" });
      await listTenantSubscriptions(c, vi.fn() as any);
      expect(jsonFn).toHaveBeenCalledWith({ error: "forbidden" }, 403);
    });
  });

  describe("validation", () => {
    it("rejects a status outside the CHECK vocabulary", async () => {
      const { c, jsonFn } = ctx({ body: { slug: "mesa", status: "vip" } });
      await setTenantSubscription(c, vi.fn() as any);
      expect(jsonFn).toHaveBeenCalledWith({ error: "invalid_request" }, 400);
      expect(withClient).not.toHaveBeenCalled();
    });

    it("rejects a missing slug", async () => {
      const { c, jsonFn } = ctx({ body: { status: "active" } });
      await setTenantSubscription(c, vi.fn() as any);
      expect(jsonFn).toHaveBeenCalledWith({ error: "invalid_request" }, 400);
    });
  });

  describe("setting a status", () => {
    it("records the change and returns 404 for an unknown tenant", async () => {
      db([]);
      const { c, jsonFn } = ctx({ body: { slug: "nope", status: "active" } });
      await setTenantSubscription(c, vi.fn() as any);
      expect(jsonFn).toHaveBeenCalledWith({ error: "not_found" }, 404);
    });

    it("writes the new status against the tenant", async () => {
      const seen = db([{ id: "t1" }]);
      const { c } = ctx({ body: { slug: "mesa", status: "past_due" } });
      await setTenantSubscription(c, vi.fn() as any);
      const update = seen.find((q) => /UPDATE public\.tenants/i.test(q.sql))!;
      // Parameterised on both sides: the slug is operator input and lands in a
      // WHERE clause, so interpolating it would be an injection.
      expect(update.sql).toContain("$1");
      expect(update.sql).toContain("$2");
      expect(update.params).toEqual(["past_due", "mesa"]);
    });

    // Without this, a paused tenant keeps serving from cache until the TTL
    // ends — up to 24 h of billable service given away after payment is taken.
    it("invalidates every cached registry entry for the tenant", async () => {
      db([{ id: "t1" }], ["aa111", "bb222", "cc333"]);
      const { c, jsonFn } = ctx({ body: { slug: "mesa", status: "active" } });

      await setTenantSubscription(c, vi.fn() as any);

      expect(invalidateCachedRegistryEntry).toHaveBeenCalledTimes(3);
      expect(vi.mocked(invalidateCachedRegistryEntry).mock.calls.map((c2) => c2[1]).sort())
        .toEqual(["aa111", "bb222", "cc333"]);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({ tagsFlushed: 3 }),
      );
    });

    it("succeeds even when a flush fails — the TTL re-reads the truth", async () => {
      db([{ id: "t1" }], ["aa111"]);
      vi.mocked(invalidateCachedRegistryEntry).mockRejectedValue(new Error("kv down"));
      const { c, jsonFn } = ctx({ body: { slug: "mesa", status: "active" } });

      await setTenantSubscription(c, vi.fn() as any);

      // Postgres holds the truth; a missed cache delete costs at most one TTL.
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({ status: "active" }),
      );
    });
  });

  describe("listing", () => {
    it("reports subscription and activation as separate facts", async () => {
      vi.mocked(withClient).mockImplementation(async (_e: any, fn: any) =>
        fn({
          query: vi.fn().mockResolvedValue({
            rows: [
              {
                id: "t1",
                subdomain: "mesa",
                display_name: "Mesa Dorada",
                subscription_status: "past_due",
                is_active: true,
                links: "4",
                updated_at: null,
              },
            ],
          }),
        }),
      );
      const { c, jsonFn } = ctx();

      await listTenantSubscriptions(c, vi.fn() as any);

      const [body] = jsonFn.mock.calls[0];
      expect(body).toEqual({
        tenants: [
          expect.objectContaining({
            slug: "mesa",
            // "removed" and "unpaid" need different emails; collapsing them
            // into one field is how a churned customer gets a "your account
            // was deleted" message.
            status: "past_due",
            isActive: true,
            tags: 4,
          }),
        ],
      });
    });
  });
});
