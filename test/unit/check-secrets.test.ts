import { describe, expect, test } from "bun:test";
import { findSecretLeaks } from "../../scripts/check-secrets.ts";

describe("release secret scanner", () => {
  test("detects bearer, refresh, API key, and JWT-shaped credentials", () => {
    const jwt = ["a".repeat(20), "b".repeat(24), "c".repeat(16)].join(".");
    const leaks = findSecretLeaks([
      {
        path: "bad.txt",
        content: [
          `Bearer ${"a".repeat(32)}`,
          `"refreshToken": "rt_${"b".repeat(32)}"`,
          `sk-${"c".repeat(32)}`,
          jwt,
        ].join("\n"),
      },
    ]);

    expect(leaks.map((leak) => leak.kind)).toEqual([
      "bearer token",
      "refresh token",
      "OpenAI API key",
      "JWT",
    ]);
  });

  test("allows documentation, templates, and low-entropy synthetic markers", () => {
    expect(
      findSecretLeaks([
        {
          path: "safe.ts",
          content: [
            "Bearer secret-token-value",
            String.raw`refresh-\${accountId}-\${suffix}`,
            'accessToken: "secret-access"',
            "header.payload.signature",
          ].join("\n"),
        },
      ]),
    ).toEqual([]);
  });
});
