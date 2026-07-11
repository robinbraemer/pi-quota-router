import { describe, expect, test } from "bun:test";
import { findSecretLeaks } from "../../scripts/check-secrets.ts";

describe("release secret scanner", () => {
  test("classifies synthetic credentials without echoing their values", () => {
    const bearer = `Bearer ${"a".repeat(32)}`;
    const refresh = `rt_${"b".repeat(32)}`;
    const apiKey = `sk-${"c".repeat(32)}`;
    const jwt = ["d".repeat(20), "e".repeat(24), "f".repeat(16)].join(".");
    const credentials = [bearer, refresh, apiKey, jwt];
    const leaks = findSecretLeaks([
      {
        path: "bad.txt",
        content: credentials.join("\n"),
      },
    ]);

    expect(leaks.map((leak) => leak.kind)).toEqual([
      "bearer token",
      "refresh token",
      "OpenAI API key",
      "JWT",
    ]);
    expect(
      credentials.every((credential) => !JSON.stringify(leaks).includes(credential)),
    ).toBeTrue();
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
