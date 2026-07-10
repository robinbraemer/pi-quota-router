import { describe, expect, test } from "bun:test";
import { redact, sanitizeDisplay } from "../../src/logging/redact.ts";

describe("credential redaction", () => {
  test("redacts bearer, JWT, API-key-like, and long opaque values", () => {
    const jwt = [`eyJ${"a".repeat(16)}`, `eyJ${"b".repeat(16)}`, "c".repeat(12)].join(".");
    const apiKey = `sk-proj-${"d".repeat(32)}`;
    const value = [
      "Bearer secret-bearer-value",
      jwt,
      apiKey,
      "0123456789abcdef0123456789abcdef0123456789abcdef",
    ].join(" ");
    const result = redact(value);
    expect(result).not.toContain("secret-bearer-value");
    expect(result).not.toContain(jwt);
    expect(result).not.toContain(apiKey);
    expect(result).not.toContain("0123456789abcdef");
    expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test("normalizes untrusted display values to one bounded line", () => {
    const result = sanitizeDisplay(` work\naccount\u0000 ${"x".repeat(120)}`, 80);
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\u0000");
    expect(Array.from(result)).toHaveLength(80);
  });
});
