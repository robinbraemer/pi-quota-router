import { describe, expect, test } from "bun:test";
import {
  AccountNeedsReauthError,
  TokenRefreshTransientError,
} from "../../src/accounts/account-vault.ts";
import { classifyFailure } from "../../src/recovery/failure-classifier.ts";

const NOW = 2_000_000_000_000;

describe("failure classifier", () => {
  test("classifies quota status, codes, and messages", () => {
    expect(classifyFailure({ status: 429 }, NOW)).toEqual({ kind: "quota" });
    expect(classifyFailure({ code: "usage_limit_reached" }, NOW)).toEqual({
      kind: "quota",
    });
    expect(classifyFailure(new Error("rate limit reached"), NOW)).toEqual({
      kind: "quota",
    });
  });

  test("separates retryable and definitive authentication", () => {
    expect(classifyFailure({ status: 401 }, NOW)).toEqual({ kind: "auth-retry" });
    expect(classifyFailure({ code: "invalid_grant" }, NOW)).toEqual({
      kind: "auth-invalid",
    });
    expect(classifyFailure(new Error("refresh token was revoked"), NOW)).toEqual({
      kind: "auth-invalid",
    });
  });

  test("classifies abort, timeout, and unrelated failures", () => {
    expect(classifyFailure({ name: "AbortError" }, NOW)).toEqual({ kind: "aborted" });
    expect(classifyFailure({ code: "ETIMEDOUT" }, NOW)).toEqual({
      kind: "transient",
      retryAt: NOW + 60_000,
    });
    expect(classifyFailure(new Error("bad request"), NOW)).toEqual({ kind: "fatal" });
  });

  test("classifies sanitized credential errors by their typed names", () => {
    expect(classifyFailure(new AccountNeedsReauthError(), NOW)).toEqual({
      kind: "auth-invalid",
    });
    expect(classifyFailure(new TokenRefreshTransientError(), NOW)).toEqual({
      kind: "transient",
      retryAt: NOW + 60_000,
    });
  });
});
