import { afterEach, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { deriveManagedAccountId } from "../../src/accounts/account-identity.ts";
import {
  createRouterController,
  type RouterControllerOptions,
} from "../../src/router-controller.ts";
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
  test("successful reauthentication clears a permanent auth block", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const credentials = makeCredentials("account-1", 3_000_000_000_000);
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => credentials },
      login: async () => credentials,
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => eventStream(successfulText()),
    });
    const accountId = await controller.vault.addFromOAuth("work", credentials);
    await controller.vault.markNeedsReauth(accountId, credentials.access, "invalid_grant");
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await stateStore.update((state) => ({
      ...state,
      blocks: [{ accountId, kind: "auth", blockedAt: 2_000_000_000_000, estimated: false }],
    }));

    await controller.operations.login("work", { ui: {} } as ExtensionCommandContext);

    expect((await controller.vault.list())[0]?.needsReauth).toBe(false);
    expect((await stateStore.read()).blocks).toEqual([]);
    await controller.shutdown();
  });

  test("forced usage refresh clears an estimated block when quota is available", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const credentials = makeCredentials("account-1", 3_000_000_000_000);
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => credentials },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => eventStream(successfulText()),
    });
    const accountId = await controller.vault.addFromOAuth("work", credentials);
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await stateStore.update((state) => ({
      ...state,
      blocks: [
        {
          accountId,
          kind: "transient",
          blockedAt: 2_000_000_000_000,
          retryAt: 2_000_003_600_000,
          estimated: true,
        },
      ],
    }));

    await controller.operations.refresh(accountId);

    expect((await stateStore.read()).blocks).toEqual([]);
    await controller.shutdown();
  });

  test("force refreshes a credential after a usage 401", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const original = makeCredentials("account-1", 3_000_000_000_000, "original");
    const refreshed = makeCredentials("account-1", 3_000_000_000_000, "refreshed");
    const authorizationHeaders: string[] = [];
    let refreshes = 0;
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: {
        refresh: async () => {
          refreshes += 1;
          return refreshed;
        },
      },
      fetchImpl: async (_input, init) => {
        authorizationHeaders.push(String(new Headers(init?.headers).get("authorization")));
        return authorizationHeaders.length === 1
          ? new Response(null, { status: 401 })
          : Response.json(completeUsageResponse);
      },
      baseStream: () => eventStream(successfulText()),
    });
    const accountId = await controller.vault.addFromOAuth("work", original);

    await controller.operations.refresh(accountId);

    expect(authorizationHeaders).toEqual([
      `Bearer ${original.access}`,
      `Bearer ${refreshed.access}`,
    ]);
    expect(refreshes).toBe(1);
    await controller.shutdown();
  });

  test("marks an account for reauthentication after a refreshed usage credential is rejected", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const original = makeCredentials("account-1", 3_000_000_000_000, "original");
    const refreshed = makeCredentials("account-1", 3_000_000_000_000, "refreshed");
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => refreshed },
      fetchImpl: async () => new Response(null, { status: 401 }),
      baseStream: () => eventStream(successfulText()),
    });
    const accountId = await controller.vault.addFromOAuth("work", original);

    await expect(controller.operations.refresh(accountId)).rejects.toThrow(
      "must be authenticated again",
    );

    expect((await controller.vault.list())[0]?.needsReauth).toBe(true);
    await controller.shutdown();
  });

  test("does not block credentials replaced during a routed auth failure", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const rejected = makeCredentials("account-1", 3_000_000_000_000, "rejected");
    const relogged = makeCredentials("account-1", 3_000_000_000_000, "relogged");
    let markAttemptStarted: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolve) => {
      markAttemptStarted = resolve;
    });
    let finishAttempt: (() => void) | undefined;
    const attemptHeld = new Promise<void>((resolve) => {
      finishAttempt = resolve;
    });
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => relogged },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (() => {
        const stream = (async function* () {
          markAttemptStarted?.();
          await attemptHeld;
          yield {
            type: "error",
            reason: "error",
            error: message("error", "invalid_grant"),
          } as AssistantMessageEvent;
        })();
        return stream;
      }) as unknown as RouterControllerOptions["baseStream"],
    });
    const accountId = await controller.vault.addFromOAuth("work", rejected);
    const request = collectController(controller);
    await attemptStarted;

    await controller.vault.addFromOAuth("work", relogged);
    finishAttempt?.();
    await request;

    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    expect((await controller.vault.list())[0]?.needsReauth).toBe(false);
    expect((await stateStore.read()).blocks).toEqual([]);
    expect((await controller.vault.getFreshCredential(accountId)).accessToken).toBe(
      relogged.access,
    );
    await controller.shutdown();
  });

  test("rejects an ambiguous label for manual routing", async () => {
    const controller = await setupDuplicateLabels();

    await expect(controller.operations.use("shared")).rejects.toThrow(
      "Ambiguous Codex account label: shared",
    );

    await controller.shutdown();
  });

  test("rejects an ambiguous label for refresh", async () => {
    const controller = await setupDuplicateLabels();

    await expect(controller.operations.refresh("shared")).rejects.toThrow(
      "Ambiguous Codex account label: shared",
    );

    await controller.shutdown();
  });

  test("rejects an ambiguous label for priming", async () => {
    const controller = await setupDuplicateLabels();

    await expect(controller.operations.prime("shared")).rejects.toThrow(
      "Ambiguous Codex account label: shared",
    );

    await controller.shutdown();
  });

  test("manual routing does not fetch account usage", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    let usageCalls = 0;
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => {
        usageCalls += 1;
        return Response.json(completeUsageResponse);
      },
      baseStream: () => eventStream(successfulText()),
    });
    const selectedId = await controller.vault.addFromOAuth(
      "first",
      makeCredentials("account-1", 3_000_000_000_000),
    );
    await controller.vault.addFromOAuth("second", makeCredentials("account-2", 3_000_000_000_000));
    await controller.operations.use(selectedId);

    await collectController(controller);

    expect(usageCalls).toBe(0);
    await controller.shutdown();
  });

  test("rejects an unsupported primer model without applying a retry cooldown", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    let usageCalls = 0;
    let primerCalls = 0;
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => {
        usageCalls += 1;
        return Response.json(completeUsageResponse);
      },
      baseStream: () => {
        primerCalls += 1;
        return eventStream(successfulText());
      },
    });
    const accountId = await controller.vault.addFromOAuth(
      "work",
      makeCredentials("account-1", 3_000_000_000_000),
    );
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });

    await expect(controller.operations.prime(accountId, "unsupported-model")).rejects.toThrow(
      "Codex model unsupported-model is unavailable for priming",
    );

    expect(usageCalls).toBe(0);
    expect(primerCalls).toBe(0);
    expect((await stateStore.read()).priming.retryAfter).toEqual({});
    await controller.shutdown();
  });

  test("shows the first authenticated account before the first routed turn", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => eventStream(successfulText()),
    });

    await controller.vault.addFromOAuth("work", makeCredentials("account-1", 3_000_000_000_000));

    expect(await controller.operations.status()).toBe("Codex · work · auto");
    await controller.shutdown();
  });

  test("shows a login without treating it as a successful automatic route", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const { preferredAccountId, otherAccountId } = automaticTieAccountIds();
    const preferred = makeCredentials(preferredAccountId, 3_000_000_000_000, "preferred");
    const loggedIn = makeCredentials(otherAccountId, 3_000_000_000_000, "logged-in");
    let routedToken: string | undefined;
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => loggedIn },
      login: async () => loggedIn,
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (_model, _context, options) => {
        routedToken = options?.apiKey;
        return eventStream(successfulText());
      },
    });
    await controller.vault.addFromOAuth("preferred", preferred);

    await controller.operations.login("recent", { ui: {} } as ExtensionCommandContext);

    expect(await controller.operations.status()).toContain("recent");
    await collectController(controller);
    expect(routedToken).toBe(preferred.access);
    await controller.shutdown();
  });

  test("does not use a failed manual route for automatic hysteresis", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const { preferredAccountId, otherAccountId } = automaticTieAccountIds();
    const preferred = makeCredentials(preferredAccountId, 3_000_000_000_000, "preferred");
    const manual = makeCredentials(otherAccountId, 3_000_000_000_000, "manual");
    const routedTokens: string[] = [];
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => manual },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (_model, _context, options) => {
        routedTokens.push(options?.apiKey ?? "");
        return routedTokens.length === 1
          ? eventStream([
              {
                type: "error",
                reason: "error",
                error: message("error", "invalid request"),
              },
            ])
          : eventStream(successfulText());
      },
    });
    await controller.vault.addFromOAuth("preferred", preferred);
    const manualId = await controller.vault.addFromOAuth("manual", manual);
    await controller.operations.use(manualId);

    await collectController(controller);
    await controller.operations.use("auto");
    await collectController(controller);

    expect(routedTokens).toEqual([manual.access, preferred.access]);
    await controller.shutdown();
  });

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
    const list = await controller.operations.list();
    expect(list).toContain("work");
    expect(list).toContain("5h 88% remaining");
    expect(list).toContain("7d 63% remaining");
    const dashboard = await controller.operations.dashboard();
    expect(dashboard).toContain("AVAILABLE COMMANDS");
    for (const command of ["login", "list", "status", "use auto", "refresh", "prime"]) {
      expect(dashboard).toMatch(new RegExp(`^> /quota-router ${command}`, "m"));
    }
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
    const configStore = createAtomicJsonStore<RouterConfig>({
      path: paths.config,
      schema: RouterConfigSchema,
      createDefault: () => {
        throw new Error("config should already exist");
      },
    });
    await configStore.update((config) => ({ ...config, maxRotationAttempts: 1 }));

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

  test("waits for recovery after the final candidate fails before output", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () =>
        eventStream([
          { type: "error", reason: "error", error: message("error", "usage limit reached") },
        ]),
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
      maxRotationAttempts: 2,
      maxRecoveryWaitMs: 0,
    }));

    const events = await collectController(controller);

    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].error.errorMessage).toContain("configured wait limit");
    }
    await controller.shutdown();
  });

  test("reports cancellation during initial usage collection as aborted", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const controller = new AbortController();
    let markUsageStarted: (() => void) | undefined;
    const usageStarted = new Promise<void>((resolve) => {
      markUsageStarted = resolve;
    });
    const router = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async (_input, init) => {
        markUsageStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
      baseStream: () => eventStream(successfulText()),
    });
    await router.vault.addFromOAuth("work", makeCredentials("account-1", 3_000_000_000_000));
    const model = Object.values(OPENAI_CODEX_MODELS)[0] as Model<"openai-codex-responses">;
    const collecting = (async () => {
      const events: AssistantMessageEvent[] = [];
      for await (const event of router.routedStream(model, { messages: [] } as Context, {
        signal: controller.signal,
      })) {
        events.push(event);
      }
      return events;
    })();
    await usageStarted;
    controller.abort(new DOMException("cancelled", "AbortError"));

    const events = await collecting;

    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].reason).toBe("aborted");
    }
    await router.shutdown();
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

function automaticTieAccountIds() {
  const [preferredAccountId, otherAccountId] = ["account-1", "account-2"].sort((left, right) =>
    deriveManagedAccountId(left).localeCompare(deriveManagedAccountId(right)),
  );
  if (!preferredAccountId || !otherAccountId) {
    throw new Error("expected two test accounts");
  }
  return { preferredAccountId, otherAccountId };
}

async function setupDuplicateLabels() {
  const fixture = await createStorageFixture();
  cleanups.push(fixture.cleanup);
  const controller = await createRouterController({
    paths: resolveRouterPaths(fixture.directory),
    clock: () => 2_000_000_000_000,
    oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
    fetchImpl: async () => Response.json(completeUsageResponse),
    baseStream: () => eventStream(successfulText()),
  });
  await controller.vault.addFromOAuth("shared", makeCredentials("account-1", 3_000_000_000_000));
  await controller.vault.addFromOAuth("shared", makeCredentials("account-2", 3_000_000_000_000));
  return controller;
}
