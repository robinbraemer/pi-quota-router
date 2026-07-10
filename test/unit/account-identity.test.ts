import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  deriveManagedAccountId,
  extractCodexAccountId,
  normalizeAccountLabel,
} from "../../src/accounts/account-identity.ts";
import { makeAccessToken } from "../fixtures/oauth.ts";

describe("Codex account identity", () => {
  test("extracts the account id from the namespaced JWT claim", () => {
    expect(extractCodexAccountId(makeAccessToken("account-123"))).toBe("account-123");
  });

  test("derives a stable non-secret managed id", () => {
    const expected = createHash("sha256").update("account-123").digest("hex").slice(0, 12);
    expect(deriveManagedAccountId("account-123")).toBe(`codex-${expected}`);
  });

  test("rejects tokens without exposing their contents", () => {
    const secret = "sensitive-token-value";
    try {
      extractCodexAccountId(secret);
      throw new Error("expected identity extraction to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  test("normalizes labels to one printable bounded line", () => {
    const long = `  work\naccount\u0000 ${"x".repeat(100)}`;
    const normalized = normalizeAccountLabel(long, "fallback");
    expect(normalized).not.toContain("\n");
    expect(normalized).not.toContain("\u0000");
    expect(Array.from(normalized).length).toBeLessThanOrEqual(80);
    expect(normalizeAccountLabel("   ", "fallback")).toBe("fallback");
  });
});
