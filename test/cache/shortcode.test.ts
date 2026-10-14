import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getCachedUrl,
  setCachedUrl,
  invalidateCachedUrl,
  setCachedRegistryEntry,
} from "../../src/cache/shortcode";

// ---------------------------------------------------------------------------
// Mock KV namespace for short URL cache
// ---------------------------------------------------------------------------

function mockKV() {
  return {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
}

function mockEnv(kv: ReturnType<typeof mockKV>) {
  return {
    SHORT_URL_CACHE: kv as unknown as KVNamespace,
  } as any;
}

// ---------------------------------------------------------------------------
// getCachedUrl tests (REQ-R001, REQ-O002)
// ---------------------------------------------------------------------------

describe("getCachedUrl", () => {
  let kv: ReturnType<typeof mockKV>;
  let env: ReturnType<typeof mockEnv>;

  beforeEach(() => {
    kv = mockKV();
    env = mockEnv(kv);
  });

  it("returns the cached value on KV hit", async () => {
    kv.get.mockResolvedValueOnce("https://example.com/target");

    const result = await getCachedUrl(env, "acme", "abc123");

    expect(result).toBe("https://example.com/target");
    expect(kv.get).toHaveBeenCalledWith("acme:abc123");
  });

  it("returns null on KV miss", async () => {
    kv.get.mockResolvedValueOnce(null);

    const result = await getCachedUrl(env, "acme", "unknown");

    expect(result).toBeNull();
    expect(kv.get).toHaveBeenCalledWith("acme:unknown");
  });

  it("returns null on KV error (graceful degradation)", async () => {
    kv.get.mockRejectedValueOnce(new Error("KV unreachable"));

    const result = await getCachedUrl(env, "acme", "abc123");

    expect(result).toBeNull();
  });

  it("uses correct key format: {slug}:{code}", async () => {
    kv.get.mockResolvedValueOnce(null);

    await getCachedUrl(env, "my-tenant", "xyz789");

    expect(kv.get).toHaveBeenCalledWith("my-tenant:xyz789");
  });
});

// ---------------------------------------------------------------------------
// setCachedUrl tests
// ---------------------------------------------------------------------------

describe("setCachedUrl", () => {
  let kv: ReturnType<typeof mockKV>;
  let env: ReturnType<typeof mockEnv>;

  beforeEach(() => {
    kv = mockKV();
    env = mockEnv(kv);
  });

  it("writes with correct key format and TTL 86400", async () => {
    await setCachedUrl(env, "acme", "abc123", "https://example.com");

    expect(kv.put).toHaveBeenCalledWith("acme:abc123", "https://example.com", {
      expirationTtl: 86400,
    });
  });

  it("does not throw on KV write error (non-fatal)", async () => {
    kv.put.mockRejectedValueOnce(new Error("KV write failed"));

    // Should not throw
    await expect(
      setCachedUrl(env, "acme", "abc123", "https://example.com"),
    ).resolves.toBeUndefined();
  });

  it("writes with different tenant slugs", async () => {
    await setCachedUrl(env, "tenant-a", "code1", "https://a.com");
    await setCachedUrl(env, "tenant-b", "code2", "https://b.com");

    expect(kv.put).toHaveBeenCalledWith(
      "tenant-a:code1",
      "https://a.com",
      { expirationTtl: 86400 },
    );
    expect(kv.put).toHaveBeenCalledWith(
      "tenant-b:code2",
      "https://b.com",
      { expirationTtl: 86400 },
    );
  });
});

// ---------------------------------------------------------------------------
// invalidateCachedUrl tests
// ---------------------------------------------------------------------------

describe("invalidateCachedUrl", () => {
  let kv: ReturnType<typeof mockKV>;
  let env: ReturnType<typeof mockEnv>;

  beforeEach(() => {
    kv = mockKV();
    env = mockEnv(kv);
  });

  it("deletes with correct key format", async () => {
    await invalidateCachedUrl(env, "acme", "abc123");

    expect(kv.delete).toHaveBeenCalledWith("acme:abc123");
  });

  it("does not throw on KV delete error (non-fatal)", async () => {
    kv.delete.mockRejectedValueOnce(new Error("KV delete failed"));

    await expect(
      invalidateCachedUrl(env, "acme", "abc123"),
    ).resolves.toBeUndefined();
  });
});

describe("setCachedRegistryEntry", () => {
  let kv: ReturnType<typeof mockKV>;
  let env: AppEnv;

  beforeEach(() => {
    kv = mockKV();
    env = mockEnv(kv);
  });

  // This is the guard that matters. The registry entry carries
  // `subscriptionStatus` -- billing state. KV deletes are eventually consistent,
  // so when one fails to propagate the TTL is the ONLY thing that bounds how
  // long stale billing state is served. Unifying these two TTLs quietly puts
  // that bound at 24 hours, and the suite stays green.
  //
  // Nobody is going to remember this reasoning in eight months. This test is
  // what remembers it.
  it("bounds stale billing state well below the destination-URL TTL", async () => {
    await setCachedRegistryEntry(env, "abc123", {
      shortCode: "abc123",
      tenantId: "t1",
      tenantSlug: "acme",
      subdomain: "acme",
      isActive: true,
      actionScreenEnabled: false,
      customMessage: null,
      screenTitle: null,
      isGated: false,
      subscriptionStatus: "past_due",
    });

    const ttl = kv.put.mock.calls.at(-1)?.[2]?.expirationTtl as number;

    // Bounded: a 24h window on billing state is not a backstop.
    expect(ttl).toBeLessThanOrEqual(900);
    // Still meaningfully longer than the ~60s KV propagation window, so the
    // TTL is a backstop and not a reason to query on every single scan.
    expect(ttl).toBeGreaterThanOrEqual(300);
  });

  it("keeps the destination URL cache long-lived", async () => {
    await setCachedUrl(env, "acme", "abc123", "https://example.com");

    const ttl = kv.put.mock.calls.at(-1)?.[2]?.expirationTtl as number;
    expect(ttl).toBe(86400);
  });
});
