import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../../src/config.ts";
import { resolveRouterPaths } from "../../src/storage/paths.ts";
import {
  AccountVaultFileSchema,
  defaultRuntimeState,
  RouterConfigSchema,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";

describe("router storage contracts", () => {
  test("resolves every file below the extension directory", () => {
    const base = join("/tmp", "pi-agent");
    expect(resolveRouterPaths(base)).toEqual({
      directory: join(base, "pi-quota-router"),
      accounts: join(base, "pi-quota-router", "accounts.json"),
      config: join(base, "pi-quota-router", "config.json"),
      state: join(base, "pi-quota-router", "state.json"),
      log: join(base, "pi-quota-router", "events.ndjson"),
    });
  });

  test("accepts valid version-one files", () => {
    expect(RouterConfigSchema.parse(defaultConfig)).toEqual(defaultConfig);
    expect(RuntimeStateFileSchema.parse(defaultRuntimeState)).toEqual(defaultRuntimeState);
    expect(
      AccountVaultFileSchema.parse({
        version: 1,
        accounts: [
          {
            id: "codex-0123456789ab",
            label: "work",
            accountId: "account-1",
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 10,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    ).toHaveProperty("accounts.0.label", "work");
  });

  test("rejects unknown persisted fields", () => {
    expect(() =>
      RouterConfigSchema.parse({
        ...defaultConfig,
        unsafeAutomaticPriming: true,
      }),
    ).toThrow();
  });
});
