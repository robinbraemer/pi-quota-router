import { describe, expect, test } from "bun:test";
import { redact, sanitizeDisplay } from "../../src/logging/redact.ts";

describe("credential redaction", () => {
  test("redacts bearer, JWT, API-key-like, and long opaque values", () => {
    const value = [
      "Bearer secret-bearer-value",
      "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.signature",
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "0123456789abcdef0123456789abcdef0123456789abcdef",
    ].join(" ");
    const result = redact(value);
    expect(result).not.toContain("secret-bearer-value");
    expect(result).not.toContain("eyJhbGci");
    expect(result).not.toContain("sk-proj");
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
