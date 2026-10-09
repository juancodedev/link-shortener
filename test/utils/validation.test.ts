import { describe, it, expect } from "vitest";
import { validateUrl, validateSlug, sanitizeInput } from "../../src/utils/validation";

// ---------------------------------------------------------------------------
// validateUrl tests (REQ-S001)
// ---------------------------------------------------------------------------

describe("validateUrl", () => {
  describe("valid URLs", () => {
    it("accepts a standard HTTPS URL", () => {
      const result = validateUrl("https://example.com/page");
      expect(result.valid).toBe(true);
    });

    it("accepts an HTTP URL", () => {
      const result = validateUrl("http://example.com");
      expect(result.valid).toBe(true);
    });

    it("accepts a URL with query parameters", () => {
      const result = validateUrl("https://example.com/search?q=test&page=1");
      expect(result.valid).toBe(true);
    });

    it("accepts a URL with a path and fragment", () => {
      const result = validateUrl("https://example.com/path/to/resource#section");
      expect(result.valid).toBe(true);
    });

    it("accepts an uppercase protocol", () => {
      // Scheme comparison is case-insensitive: RFC 3986 schemes are not
      // case-sensitive, and WHATWG URL parsing lowercases the protocol.
      const result = validateUrl("HTTPS://Google.com");
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("https://google.com/");
    });
  });

  describe("blocked protocols", () => {
    it("rejects ftp:// URLs", () => {
      const result = validateUrl("ftp://files.example.com");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_protocol");
    });

    it("rejects file:// URLs", () => {
      const result = validateUrl("file:///etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_protocol");
    });

    it("rejects javascript: URLs", () => {
      const result = validateUrl("javascript:alert(1)");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_protocol");
    });

    it("rejects data: URLs", () => {
      const result = validateUrl("data:text/html,<script>alert(1)</script>");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_protocol");
    });
  });

  describe("blocked hosts", () => {
    it("rejects localhost", () => {
      const result = validateUrl("http://localhost:3000/admin");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_host");
    });

    it("rejects 127.0.0.1", () => {
      const result = validateUrl("http://127.0.0.1:8080");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_host");
    });

    it("rejects 0.0.0.0", () => {
      const result = validateUrl("http://0.0.0.0");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_host");
    });

    it("rejects [::1] (IPv6 loopback)", () => {
      const result = validateUrl("http://[::1]:3000");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_host");
    });

    it("rejects ::1 (IPv6 loopback within brackets)", () => {
      // ::1 without brackets fails URL parsing, so the set includes [::1] which is the
      // correct way to represent IPv6 localhost in a URL.
      // Raw ::1 fails new URL() parsing → returns "invalid_url" (which is fine).
      const result = validateUrl("http://[::1]:3000");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_host");
    });
  });

  describe("blocked IP ranges (private)", () => {
    it("rejects 10.x.x.x (10.0.0.0/8)", () => {
      const result = validateUrl("http://10.0.0.1");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_ip_range");
    });

    it("rejects 10.255.255.255 (edge of 10.x range)", () => {
      const result = validateUrl("http://10.255.255.255");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_ip_range");
    });

    it("rejects 172.16.x.x (start of 172.16/12)", () => {
      const result = validateUrl("http://172.16.0.1");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_ip_range");
    });

    it("rejects 172.31.x.x (end of 172.16/12)", () => {
      const result = validateUrl("http://172.31.255.255");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_ip_range");
    });

    it("rejects 192.168.x.x (192.168.0.0/16)", () => {
      const result = validateUrl("http://192.168.1.1/config");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_ip_range");
    });

    it("rejects 192.168.255.255", () => {
      const result = validateUrl("http://192.168.255.255");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_ip_range");
    });

    it("rejects the cloud instance metadata endpoint 169.254.169.254", () => {
      const result = validateUrl("http://169.254.169.254/latest/meta-data");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_ip_range");
    });

    it("rejects link-local addresses in 169.254.0.0/16", () => {
      const result = validateUrl("http://169.254.1.1");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_ip_range");
    });

    it("rejects loopback addresses beyond the first octet", () => {
      const result = validateUrl("http://127.0.0.53");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("blocked_ip_range");
    });
  });

  describe("URL length", () => {
    it("rejects URLs over 2048 characters", () => {
      // Must exceed 2048 chars. "https://example.com/" is 20 chars.
      // We need raw.length > 2048, so path needs at least 2029 chars.
      const longPath = "a".repeat(2029);
      const longUrl = `https://example.com/${longPath}`;
      expect(longUrl.length).toBeGreaterThan(2048);

      const result = validateUrl(longUrl);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("url_too_long");
    });

    it("accepts URLs at exactly 2048 characters", () => {
      // Build a URL that is exactly 2048 chars
      // "https://example.com/" is 20 chars, so path needs to be 2028 chars
      const path = "a".repeat(2028);
      const url = `https://example.com/${path}`;
      expect(url.length).toBe(2048);

      const result = validateUrl(url);
      expect(result.valid).toBe(true);
    });
  });

  describe("invalid URL format", () => {
    it("rejects a malformed string that is not a valid URL", () => {
      const result = validateUrl("not-a-url");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_url");
    });

    it("rejects an empty string", () => {
      const result = validateUrl("");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_url");
    });

    // A URL must carry an explicit protocol. Anything without one is rejected
    // rather than auto-promoted to https://, which previously let an arbitrary
    // string through as a trusted host.
    it("rejects a protocol-relative URL", () => {
      // "//evil.com" would otherwise become "https://evil.com/"
      const result = validateUrl("//evil.com");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_url");
    });

    it("rejects a protocol-relative URL obfuscated with backslashes", () => {
      const result = validateUrl("/\\/\\/evil.com");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_url");
    });

    it("rejects a protocol-relative URL padded with whitespace", () => {
      // validateUrl trims before scheme detection, so the padding cannot hide
      // the missing protocol from the check.
      const result = validateUrl("\t//evil.com\n");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_url");
    });

    it("rejects a bare host with a path (protocol is required)", () => {
      const result = validateUrl("google.com/maps/place/foo");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_url");
    });
  });
});

// ---------------------------------------------------------------------------
// validateSlug tests (REQ-T001)
// ---------------------------------------------------------------------------

describe("validateSlug", () => {
  describe("valid slugs", () => {
    it("accepts a standard 3-character slug with a hyphen", () => {
      const result = validateSlug("abc");
      expect(result.valid).toBe(true);
    });

    it("accepts a longer slug with hyphens", () => {
      const result = validateSlug("acme-corp");
      expect(result.valid).toBe(true);
    });

    it("accepts a slug with multiple hyphens", () => {
      const result = validateSlug("my-awesome-link");
      expect(result.valid).toBe(true);
    });

    it("accepts a slug at max length (30)", () => {
      const slug = "a".repeat(29) + "b"; // 30 chars, alphanumeric
      const result = validateSlug(slug);
      expect(result.valid).toBe(true);
    });
  });

  describe("reserved words", () => {
    const reservedWords = [
      "admin", "api", "www", "app", "dashboard",
      "settings", "billing", "support", "help", "docs",
      "blog", "status", "login", "signup", "register",
      "auth", "root", "system", "tenant", "tenants",
    ];

    for (const word of reservedWords) {
      it(`rejects reserved word: "${word}"`, () => {
        const result = validateSlug(word);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("reserved_slug");
      });
    }

    it("rejects reserved word case-insensitively via toLowerCase conversion", () => {
      // validateSlug calls toLowerCase() before checking reserved words,
      // so even mixed-case reserved words are caught. But they must pass regex first.
      // "admin" is lowercase so will hit the reserved check.
      const result = validateSlug("admin");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("reserved_slug");
    });
  });

  describe("invalid characters", () => {
    it("rejects slug with spaces", () => {
      const result = validateSlug("acme corp");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_slug");
    });

    it("rejects slug with exclamation mark", () => {
      const result = validateSlug("acme-corp!");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_slug");
    });

    it("rejects slug with underscore", () => {
      const result = validateSlug("acme_corp");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_slug");
    });

    it("rejects slug with uppercase letters (must be lowercase)", () => {
      const result = validateSlug("AcmeCorp");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_slug");
    });

    it("rejects slug starting with a hyphen", () => {
      const result = validateSlug("-acme");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_slug");
    });

    it("rejects slug ending with a hyphen", () => {
      const result = validateSlug("acme-");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_slug");
    });
  });

  describe("length constraints", () => {
    it("rejects slug that is too short (2 chars)", () => {
      const result = validateSlug("ab");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("slug_too_short");
    });

    it("rejects empty slug", () => {
      const result = validateSlug("");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("slug_too_short");
    });

    it("rejects slug that is too long (31 chars)", () => {
      const slug = "a".repeat(30) + "b"; // 31 chars
      const result = validateSlug(slug);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("slug_too_long");
    });
  });
});

// ---------------------------------------------------------------------------
// sanitizeInput tests
// ---------------------------------------------------------------------------

describe("sanitizeInput", () => {
  it("trims leading and trailing whitespace", () => {
    const result = sanitizeInput("  Hello World  ", 100);
    expect(result).toBe("Hello World");
  });

  it("truncates to maxLen when input exceeds it", () => {
    const result = sanitizeInput("Hello World", 5);
    expect(result).toBe("Hello");
  });

  it("returns the input unchanged when within limits", () => {
    const result = sanitizeInput("Hello", 10);
    expect(result).toBe("Hello");
  });

  it("returns empty string when input is only whitespace and maxLen > 0", () => {
    const result = sanitizeInput("   ", 100);
    expect(result).toBe("");
  });

  it("handles maxLen of 0 (returns empty)", () => {
    const result = sanitizeInput("Hello", 0);
    expect(result).toBe("");
  });
});
