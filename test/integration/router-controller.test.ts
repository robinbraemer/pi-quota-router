import { afterEach, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { createRouterController } from "../../src/router-controller.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import { resolveRouterPaths } from "../../src/storage/paths.ts";
import {
  defaultRuntimeState,
  RouterConfigSchema,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";
import type { RouterConfig } from "../../src/types.ts";
import { makeCredentials } from "../fixtures/oauth.ts";
import { eventStream, message, successfulText } from "../fixtures/provider-streams.ts";
import { createStorageFixture } from "../fixtures/storage.ts";
import { completeUsageResponse } from "../fixtures/usage-responses.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("RouterController", () => {
  test("routes after login and refuses to expose the bootstrap sentinel", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    let backendKey: string | undefined;
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (_model, _context, options) => {
        backendKey = options?.apiKey;
        return eventStream(successfulText());
      },
    });
    await expect(controller.assertReady()).rejects.toThrow("/quota-router login");
    await controller.vault.addFromOAuth("work", makeCredentials("account-1", 3_000_000_000_000));
    await controller.assertReady();
    expect(await controller.operations.accounts()).toContain("work");
    expect(await controller.operations.use("auto")).toContain("automatic");

    const model = Object.values(OPENAI_CODEX_MODELS)[0] as Model<"openai-codex-responses">;
    const events: AssistantMessageEvent[] = [];
    for await (const event of controller.routedStream(model, { messages: [] } as Context)) {
      events.push(event);
    }
    expect(events.at(-1)?.type).toBe("done");
    expect(backendKey).not.toBe("pending-login");
    expect(backendKey).toContain(".");
    expect(await controller.operations.status()).toContain("work");
    expect(await controller.operations.verify()).toContain("healthy");
    expect(await controller.operations.paths()).toContain("accounts.json");
    await controller.shutdown();
  });

  test("force refreshes a generic 401 and retries the same account", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const original = makeCredentials("account-1", 3_000_000_000_000, "original");
    const refreshed = makeCredentials("account-1", 3_000_000_000_000, "refreshed");
    const keys: string[] = [];
    let refreshes = 0;
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: {
        refresh: async () => {
          refreshes += 1;
          return refreshed;
        },
      },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (_model, _context, options) => {
        keys.push(options?.apiKey ?? "");
        return options?.apiKey === original.access
          ? eventStream([
              {
                type: "error",
                reason: "error",
                error: message("error", "401 unauthorized"),
              },
            ])
          : eventStream(successfulText());
      },
    });
    await controller.vault.addFromOAuth("work", original);

    const events = await collectController(controller);

    expect(events.at(-1)?.type).toBe("done");
    expect(keys).toEqual([original.access, refreshed.access]);
    expect(refreshes).toBe(1);
    await controller.shutdown();
  });

  test("refreshes exhausted usage before deriving a quota block", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    let usageCalls = 0;
    const resetAt = 2_000_000_000_000 + 600_000;
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => {
        usageCalls += 1;
        return Response.json({
          ...completeUsageResponse,
          rate_limit: {
            ...completeUsageResponse.rate_limit,
            primary_window: {
              ...completeUsageResponse.rate_limit.primary_window,
              used_percent: usageCalls === 1 ? 20 : 100,
              reset_at: resetAt,
            },
          },
        });
      },
      baseStream: () =>
        eventStream([
          {
            type: "error",
            reason: "error",
            error: message("error", "usage limit reached"),
          },
        ]),
    });
    await controller.vault.addFromOAuth("work", makeCredentials("account-1", 3_000_000_000_000));

    await collectController(controller);
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    const block = (await stateStore.read()).blocks[0];

    expect(usageCalls).toBe(2);
    expect(block?.retryAt).toBe(resetAt);
    expect(block?.estimated).toBe(false);
    await controller.shutdown();
  });

  test("uses live usage freshness and rotation configuration", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    let now = 2_000_000_000_000;
    let usageCalls = 0;
    let streamCalls = 0;
    const controller = await createRouterController({
      paths,
      clock: () => now,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => {
        usageCalls += 1;
        return Response.json(completeUsageResponse);
      },
      baseStream: () => {
        streamCalls += 1;
        return eventStream(successfulText());
      },
    });
    await controller.vault.addFromOAuth("work", makeCredentials("account-1", 3_000_000_000_000));
    const configStore = createAtomicJsonStore<RouterConfig>({
      path: paths.config,
      schema: RouterConfigSchema,
      createDefault: () => {
        throw new Error("config should already exist");
      },
    });
    await configStore.update((config) => ({
      ...config,
      usageFreshnessMs: 1,
      maxRotationAttempts: 1,
    }));

    await collectController(controller);
    now += 2;
    await collectController(controller);

    expect(usageCalls).toBe(2);
    expect(streamCalls).toBe(2);
    await controller.shutdown();
  });

  test("uses the configured maximum rotation attempts", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    let streamCalls = 0;
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => {
        streamCalls += 1;
        return eventStream([
          { type: "error", reason: "error", error: message("error", "usage limit reached") },
        ]);
      },
    });
    await controller.vault.addFromOAuth("first", makeCredentials("account-1", 3_000_000_000_000));
    await controller.vault.addFromOAuth("second", makeCredentials("account-2", 3_000_000_000_000));
    const configStore = createAtomicJsonStore<RouterConfig>({
      path: paths.config,
      schema: RouterConfigSchema,
      createDefault: () => {
        throw new Error("config should already exist");
      },
    });
    await configStore.update((config) => ({ ...config, maxRotationAttempts: 1 }));

    await collectController(controller);

    expect(streamCalls).toBe(1);
    await controller.shutdown();
  });

  test("uses the configured maximum recovery wait", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const now = 2_000_000_000_000;
    const controller = await createRouterController({
      paths,
      clock: () => now,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => eventStream(successfulText()),
    });
    const accountId = await controller.vault.addFromOAuth(
      "work",
      makeCredentials("account-1", 3_000_000_000_000),
    );
    const configStore = createAtomicJsonStore<RouterConfig>({
      path: paths.config,
      schema: RouterConfigSchema,
      createDefault: () => {
        throw new Error("config should already exist");
      },
    });
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await configStore.update((config) => ({ ...config, maxRecoveryWaitMs: 0 }));
    await stateStore.update((state) => ({
      ...state,
      blocks: [
        {
          accountId,
          kind: "quota",
          blockedAt: now,
          retryAt: now + 60_000,
          estimated: false,
        },
      ],
    }));

    const events = await collectController(controller);

    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].error.errorMessage).toContain("configured wait limit");
    }
    await controller.shutdown();
  });

  test("reports unsafe persisted file modes as invalid", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => eventStream(successfulText()),
    });
    await controller.vault.addFromOAuth("work", makeCredentials("account-1", 3_000_000_000_000));
    await collectController(controller);
    await chmod(paths.accounts, 0o644);

    const result = await controller.operations.verify();

    expect(result).toContain("invalid");
    expect(result).toContain("accounts.json=0644");
    await controller.shutdown();
  });
});

async function collectController(controller: Awaited<ReturnType<typeof createRouterController>>) {
  const model = Object.values(OPENAI_CODEX_MODELS)[0] as Model<"openai-codex-responses">;
  const events: AssistantMessageEvent[] = [];
  for await (const event of controller.routedStream(model, { messages: [] } as Context)) {
    events.push(event);
  }
  return events;
}
