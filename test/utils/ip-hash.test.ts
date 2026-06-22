import { describe, it, expect } from "vitest";
import { hashIp } from "../../src/utils/ip-hash";

describe("hashIp", () => {
  const salt = "test-salt-abc";
  const ip = "1.2.3.4";

  it("produces a 64-character lowercase hex string", async () => {
    const result = await hashIp(ip, salt);

    expect(result).toBeDefined();
    expect(result!.length).toBe(64);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces deterministic output for the same input and salt", async () => {
    const result1 = await hashIp(ip, salt);
    const result2 = await hashIp(ip, salt);

    expect(result1).toBe(result2);
  });

  it("returns null when IP is null", async () => {
    const result = await hashIp(null, salt);
    expect(result).toBeNull();
  });

  it("returns null when IP is undefined", async () => {
    const result = await hashIp(undefined as unknown as null, salt);
    expect(result).toBeNull();
  });

  it("produces different output for different IPs with the same salt", async () => {
    const hash1 = await hashIp("1.2.3.4", salt);
    const hash2 = await hashIp("5.6.7.8", salt);

    expect(hash1).not.toBe(hash2);
  });

  it("produces different output for the same IP with different salts", async () => {
    const hash1 = await hashIp(ip, "salt-alpha");
    const hash2 = await hashIp(ip, "salt-beta");

    expect(hash1).not.toBe(hash2);
  });

  it("handles IPv6 addresses", async () => {
    const result = await hashIp("2001:db8::1", salt);

    expect(result!.length).toBe(64);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("handles empty string IP (hashes empty string + salt)", async () => {
    const result = await hashIp("", salt);

    // Empty string is not null, so it gets hashed
    expect(result).toBeDefined();
    expect(result!.length).toBe(64);
  });
});
