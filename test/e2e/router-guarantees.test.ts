import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { AccountNeedsReauthError } from "../../src/accounts/account-vault.ts";
import { defaultConfig } from "../../src/config.ts";
import { classifyFailure } from "../../src/recovery/failure-classifier.ts";
import { waitForRecovery } from "../../src/recovery/wait-for-recovery.ts";
import { createRouterController } from "../../src/router-controller.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import { resolveRouterPaths } from "../../src/storage/paths.ts";
import {
  defaultRuntimeState,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";
import {
  createRoutedStream,
  type RoutedStreamDependencies,
} from "../../src/stream/routed-stream.ts";
import { makeCredentials } from "../fixtures/oauth.ts";
import {
  eventStream,
  message,
  quotaError,
  start,
  successfulText,
} from "../fixtures/provider-streams.ts";
import { createStorageFixture } from "../fixtures/storage.ts";
import { fakeCodexUsage } from "../helpers/fake-codex-server.ts";
import { createIsolatedPiHome } from "../helpers/isolated-home.ts";

const NOW = 2_000_000_000_000;
const model = Object.values(OPENAI_CODEX_MODELS)[0] as Model<"openai-codex-responses">;
const context = { messages: [] } as Context;
const cleanups: Array<() => Promise<void>> = [];

setDefaultTimeout(30_000);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("quota router end-to-end guarantees", () => {
  test("selects a healthy account only after fetching fresh usage", async () => {
    const home = await createIsolatedPiHome();
    cleanups.push(home.cleanup);
    const credential = makeCredentials("healthy-account", NOW + 3_600_000);
    let usageCalls = 0;
    let backendKey: string | undefined;
    const controller = await createRouterController({
      paths: resolveRouterPaths(home.agentDirectory),
      clock: () => NOW,
      oauth: { refresh: async () => credential },
      fetchImpl: fakeCodexUsage(() => {
        usageCalls += 1;
        return usageResponse({ weeklyUsed: 35, weeklyResetAt: NOW + 72 * 3_600_000 });
      }),
      baseStream: (_model, _context, options) => {
        backendKey = options?.apiKey;
        return eventStream(successfulText());
      },
    });
    await controller.vault.addFromOAuth("healthy", credential);

    expect((await collect(controller.routedStream(model, context))).at(-1)?.type).toBe("done");
    expect(usageCalls).toBe(1);
    expect(backendKey).toBe(credential.access);
    await controller.shutdown();
  });

  test("two concurrent controllers reserve different accounts", async () => {
    const home = await createIsolatedPiHome();
    cleanups.push(home.cleanup);
    const paths = resolveRouterPaths(home.agentDirectory);
    const credentials = [
      makeCredentials("concurrent-a", NOW + 3_600_000),
      makeCredentials("concurrent-b", NOW + 3_600_000),
    ];
    const refreshCredential = makeCredentials("concurrent-refresh", NOW + 3_600_000);
    const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
    const keys: string[] = [];
    const delayedStream: RoutedStreamDependencies["baseStream"] = (_model, _context, options) => {
      keys.push(options?.apiKey ?? "");
      const stream = createAssistantMessageEventStream();
      streams.push(stream);
      if (streams.length === 2) {
        queueMicrotask(() => {
          for (const pending of streams) {
            for (const event of successfulText()) pending.push(event);
          }
        });
      }
      return stream;
    };
    const options = {
      paths,
      clock: () => NOW,
      oauth: { refresh: async () => refreshCredential },
      fetchImpl: fakeCodexUsage(() =>
        usageResponse({ weeklyUsed: 30, weeklyResetAt: NOW + 48 * 3_600_000 }),
      ),
      baseStream: delayedStream,
    };
    const first = await createRouterController(options);
    const second = await createRouterController(options);
    for (const [index, credential] of credentials.entries()) {
      await first.vault.addFromOAuth(`account-${index + 1}`, credential);
    }

    const results = await Promise.all([
      collect(first.routedStream(model, context, { sessionId: "first" })),
      collect(second.routedStream(model, context, { sessionId: "second" })),
    ]);

    expect(results.every((events) => events.at(-1)?.type === "done")).toBeTrue();
    expect(new Set(keys)).toEqual(new Set(credentials.map((value) => value.access)));
    await Promise.all([first.shutdown(), second.shutdown()]);
  });

  test("drains the useful quota whose weekly reset is most urgent", async () => {
    const home = await createIsolatedPiHome();
    cleanups.push(home.cleanup);
    const urgent = makeCredentials("urgent-account", NOW + 3_600_000);
    const relaxed = makeCredentials("relaxed-account", NOW + 3_600_000);
    let backendKey: string | undefined;
    const controller = await createRouterController({
      paths: resolveRouterPaths(home.agentDirectory),
      clock: () => NOW,
      oauth: { refresh: async () => urgent },
      fetchImpl: fakeCodexUsage((accountId) =>
        accountId === "urgent-account"
          ? usageResponse({ weeklyUsed: 60, weeklyResetAt: NOW + 24 * 3_600_000 })
          : usageResponse({ weeklyUsed: 20, weeklyResetAt: NOW + 7 * 24 * 3_600_000 }),
      ),
      baseStream: (_model, _context, options) => {
        backendKey = options?.apiKey;
        return eventStream(successfulText());
      },
    });
    await controller.vault.addFromOAuth("urgent", urgent);
    await controller.vault.addFromOAuth("relaxed", relaxed);

    await collect(controller.routedStream(model, context));
    expect(backendKey).toBe(urgent.access);
    await controller.shutdown();
  });

  test("rotates a pre-output 429 but never replays after visible output", async () => {
    const pre = routedDependencies((_model, _context, options) =>
      options?.apiKey === "token-a"
        ? eventStream([start(), quotaError()])
        : eventStream(successfulText()),
    );
    const preEvents = await collect(createRoutedStream(pre.dependencies)(model, context));
    expect(pre.selected).toEqual(["a", "b"]);
    expect(preEvents.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);

    const post = routedDependencies(() =>
      eventStream([
        start(),
        { type: "text_start", contentIndex: 0, partial: message() },
        quotaError(),
      ]),
    );
    const postEvents = await collect(createRoutedStream(post.dependencies)(model, context));
    expect(post.selected).toEqual(["a"]);
    expect(postEvents.map((event) => event.type)).toEqual(["start", "text_start", "error"]);
  });

  test("requires confirmation, primes an untouched account once, then routes it normally", async () => {
    const home = await createIsolatedPiHome();
    cleanups.push(home.cleanup);
    const credential = makeCredentials("untouched-account", NOW + 3_600_000);
    let primed = false;
    let primerCalls = 0;
    let normalCalls = 0;
    const controller = await createRouterController({
      paths: resolveRouterPaths(home.agentDirectory),
      clock: () => NOW,
      oauth: { refresh: async () => credential },
      fetchImpl: fakeCodexUsage(() =>
        usageResponse({
          shortUsed: 0,
          weeklyUsed: 0,
          ...(primed ? { weeklyResetAt: NOW + 7 * 24 * 3_600_000 } : {}),
        }),
      ),
      baseStream: (_model, _context, options) => {
        if (options?.maxTokens === 1) {
          primerCalls += 1;
          primed = true;
        } else {
          normalCalls += 1;
        }
        return eventStream(successfulText());
      },
    });
    await controller.vault.addFromOAuth("untouched", credential);

    expect(await controller.operations.prime()).toContain("not_authorized");
    expect(primerCalls).toBe(0);
    await controller.operations.confirmPriming();
    expect(await controller.operations.prime()).toContain("confirmed");
    expect(await controller.operations.prime()).toContain("not_candidate");
    expect(primerCalls).toBe(1);
    expect((await collect(controller.routedStream(model, context))).at(-1)?.type).toBe("done");
    expect(normalCalls).toBe(1);
    await controller.shutdown();
  });

  test("keeps invalid_grant accounts excluded until reauthentication", async () => {
    const home = await createIsolatedPiHome();
    cleanups.push(home.cleanup);
    const invalid = makeCredentials("invalid-account", NOW + 60_000);
    const healthy = makeCredentials("fallback-account", NOW + 3_600_000);
    let refreshes = 0;
    let backendKey: string | undefined;
    const controller = await createRouterController({
      paths: resolveRouterPaths(home.agentDirectory),
      clock: () => NOW,
      oauth: {
        refresh: async () => {
          refreshes += 1;
          throw Object.assign(new Error("invalid_grant"), { code: "invalid_grant" });
        },
      },
      fetchImpl: fakeCodexUsage(() =>
        usageResponse({ weeklyUsed: 25, weeklyResetAt: NOW + 72 * 3_600_000 }),
      ),
      baseStream: (_model, _context, options) => {
        backendKey = options?.apiKey;
        return eventStream(successfulText());
      },
    });
    const invalidId = await controller.vault.addFromOAuth("invalid", invalid);
    await controller.vault.addFromOAuth("healthy", healthy);
    await expect(controller.vault.getFreshCredential(invalidId)).rejects.toBeInstanceOf(
      AccountNeedsReauthError,
    );

    await collect(controller.routedStream(model, context));
    expect(backendKey).toBe(healthy.access);
    expect(refreshes).toBe(1);
    expect(await controller.vault.list()).toContainEqual(
      expect.objectContaining({ id: invalidId, needsReauth: true }),
    );
    await controller.shutdown();
  });

  test("Ctrl-C aborts an all-limited recovery wait", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await store.update((state) => ({
      ...state,
      blocks: [
        {
          accountId: "limited",
          kind: "quota",
          blockedAt: NOW,
          retryAt: NOW + 3_600_000,
          estimated: false,
        },
      ],
    }));
    const ctrlC = new AbortController();
    ctrlC.abort(new Error("SIGINT"));

    await expect(
      waitForRecovery({ stateStore: store, clock: () => NOW, signal: ctrlC.signal }),
    ).rejects.toThrow("SIGINT");
  });

  test("writes fixture credentials only to accounts.json", async () => {
    const home = await createIsolatedPiHome();
    cleanups.push(home.cleanup);
    const credential = makeCredentials(
      "raw-secret-account-id",
      NOW + 3_600_000,
      "fixture-secret-suffix",
    );
    const controller = await createRouterController({
      paths: resolveRouterPaths(home.agentDirectory),
      clock: () => NOW,
      oauth: { refresh: async () => credential },
      fetchImpl: fakeCodexUsage(() =>
        usageResponse({ weeklyUsed: 30, weeklyResetAt: NOW + 48 * 3_600_000 }),
      ),
      baseStream: () => eventStream(successfulText()),
    });
    await controller.vault.addFromOAuth("secret-check", credential);
    await collect(controller.routedStream(model, context));
    await controller.shutdown();

    const paths = resolveRouterPaths(home.agentDirectory);
    expect(await readFile(paths.accounts, "utf8")).toContain(credential.refresh);
    for (const relative of await readdir(paths.directory, { recursive: true })) {
      const path = join(paths.directory, relative);
      if (path === paths.accounts || !relative.includes(".")) continue;
      const content = await readFile(path, "utf8").catch(() => "");
      expect(content).not.toContain(credential.access);
      expect(content).not.toContain(credential.refresh);
      expect(content).not.toContain("raw-secret-account-id");
      expect(content).not.toContain("fixture-secret-suffix");
    }
  });
});

function usageResponse(options: {
  shortUsed?: number;
  weeklyUsed: number;
  weeklyResetAt?: number;
}) {
  return {
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: options.shortUsed ?? 20,
        reset_at: NOW + 5 * 3_600_000,
      },
      secondary_window: {
        used_percent: options.weeklyUsed,
        ...(options.weeklyResetAt ? { reset_at: options.weeklyResetAt } : {}),
      },
    },
  };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function routedDependencies(baseStream: RoutedStreamDependencies["baseStream"]): {
  dependencies: RoutedStreamDependencies;
  selected: string[];
} {
  const selected: string[] = [];
  const accounts = ["a", "b"];
  return {
    selected,
    dependencies: {
      selectAndReserve: async ({ excludedAccountIds }) => {
        const accountId = accounts.find((value) => !excludedAccountIds.has(value));
        if (!accountId) {
          return {
            kind: "unavailable",
            reason: "no_eligible_accounts",
            recoverableAccountIds: [],
            knownAccountIds: accounts,
          };
        }
        selected.push(accountId);
        return {
          kind: "selected",
          lease: {
            accountId,
            leaseToken: `lease-${accountId}`,
            reservationTtlMs: defaultConfig.reservationTtlMs,
          },
        };
      },
      getFreshCredential: async (accountId) => ({
        accountId,
        accessToken: `token-${accountId}`,
        expiresAt: NOW + 3_600_000,
      }),
      forceRefreshCredential: async (accountId) => ({
        accountId,
        accessToken: `refreshed-${accountId}`,
        expiresAt: NOW + 3_600_000,
      }),
      baseStream,
      classifyFailure: (error) => classifyFailure(error, NOW),
      recordFailure: async () => undefined,
      release: async () => undefined,
      renew: async () => true,
      waitForRecovery: async () => undefined,
      maxAttempts: () => defaultConfig.maxRotationAttempts,
    },
  };
}
