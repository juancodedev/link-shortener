import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCachedSchema, setCachedSchema, invalidateCachedSchema } from "../../src/cache/tenant";

// ---------------------------------------------------------------------------
// Mock KV namespace for tenant cache
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
    TENANT_CACHE: kv as unknown as KVNamespace,
  } as any;
}

// ---------------------------------------------------------------------------
// getCachedSchema tests (REQ-R002)
// ---------------------------------------------------------------------------

describe("getCachedSchema", () => {
  let kv: ReturnType<typeof mockKV>;
  let env: ReturnType<typeof mockEnv>;

  beforeEach(() => {
    kv = mockKV();
    env = mockEnv(kv);
  });

  it("returns the cached schema name on KV hit", async () => {
    kv.get.mockResolvedValueOnce("tenant_a7f3");

    const result = await getCachedSchema(env, "acme");

    expect(result).toBe("tenant_a7f3");
    expect(kv.get).toHaveBeenCalledWith("acme");
  });

  it("returns null on KV miss", async () => {
    kv.get.mockResolvedValueOnce(null);

    const result = await getCachedSchema(env, "unknown");

    expect(result).toBeNull();
  });

  it("returns null on KV error (graceful degradation)", async () => {
    kv.get.mockRejectedValueOnce(new Error("KV unreachable"));

    const result = await getCachedSchema(env, "acme");

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setCachedSchema tests
// ---------------------------------------------------------------------------

describe("setCachedSchema", () => {
  let kv: ReturnType<typeof mockKV>;
  let env: ReturnType<typeof mockEnv>;

  beforeEach(() => {
    kv = mockKV();
    env = mockEnv(kv);
  });

  it("writes with correct key (slug only) and TTL 3600", async () => {
    await setCachedSchema(env, "acme", "tenant_a7f3");

    expect(kv.put).toHaveBeenCalledWith("acme", "tenant_a7f3", {
      expirationTtl: 3600,
    });
  });

  it("does not throw on KV write error (non-fatal)", async () => {
    kv.put.mockRejectedValueOnce(new Error("KV write failed"));

    await expect(
      setCachedSchema(env, "acme", "tenant_a7f3"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// invalidateCachedSchema tests
// ---------------------------------------------------------------------------

describe("invalidateCachedSchema", () => {
  let kv: ReturnType<typeof mockKV>;
  let env: ReturnType<typeof mockEnv>;

  beforeEach(() => {
    kv = mockKV();
    env = mockEnv(kv);
  });

  it("deletes the tenant slug key", async () => {
    await invalidateCachedSchema(env, "acme");

    expect(kv.delete).toHaveBeenCalledWith("acme");
  });

  it("does not throw on KV delete error (non-fatal)", async () => {
    kv.delete.mockRejectedValueOnce(new Error("KV delete failed"));

    await expect(
      invalidateCachedSchema(env, "acme"),
    ).resolves.toBeUndefined();
  });
});
