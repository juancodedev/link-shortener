import { describe, it, expect } from "vitest";
import { generateShortCode } from "../../src/utils/short-code";

describe("generateShortCode", () => {
  const EXPECTED_ALPHABET = new Set(
    "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  );

  it("produces a string of exactly 7 characters", () => {
    const code = generateShortCode();

    expect(code.length).toBe(7);
  });

  it("uses only characters from the defined alphabet", () => {
    // Generate multiple codes to exercise the randomness
    for (let i = 0; i < 10; i++) {
      const code = generateShortCode();
      for (const char of code) {
        expect(EXPECTED_ALPHABET.has(char)).toBe(true);
      }
    }
  });

  it("does not contain ambiguous characters (0, O, I, 1, l)", () => {
    const ambiguous = new Set(["0", "O", "I", "1", "l"]);

    for (let i = 0; i < 10; i++) {
      const code = generateShortCode();
      for (const char of code) {
        expect(ambiguous.has(char)).toBe(false);
      }
    }
  });

  it("produces different codes on consecutive calls", () => {
    const code1 = generateShortCode();
    const code2 = generateShortCode();

    expect(code1).not.toBe(code2);
  });

  it("produces unique codes across many generations (collision check)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      codes.add(generateShortCode());
    }

    // All 1000 codes should be unique
    expect(codes.size).toBe(1000);
  });
});
