import { afterEach, describe, expect, test } from "bun:test";
import { chmod, readFile, stat, utimes } from "node:fs/promises";
import type {
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { deriveManagedAccountId } from "../../src/accounts/account-identity.ts";
import { defaultConfig } from "../../src/config.ts";
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
import {
  completeUsageResponse,
  weeklyOnlyPrimaryUsageResponse,
} from "../fixtures/usage-responses.ts";

const AUTHORIZATION_URL = `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge=${"a".repeat(43)}&code_challenge_method=S256&state=oauth-state`;
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

    expect((await stateStore.read()).blocks).toEqual([
      {
        accountId,
        kind: "transient",
        blockedAt: 2_000_000_000_000,
        retryAt: 2_000_003_600_000,
        estimated: true,
      },
    ]);
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
      baseStream: (...args: Parameters<RouterControllerOptions["baseStream"]>) => {
        const streamOptions = args[2];
        if (streamOptions?.apiKey === relogged.access) {
          return eventStream(successfulText());
        }
        const stream = (async function* () {
          markAttemptStarted?.();
          await attemptHeld;
          yield {
            type: "error",
            reason: "error",
            error: message("error", "invalid_grant"),
          } as AssistantMessageEvent;
        })();
        return stream as unknown as ReturnType<RouterControllerOptions["baseStream"]>;
      },
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

  test("keeps successful hysteresis controller-local per effective session", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const { preferredAccountId, otherAccountId } = automaticTieAccountIds();
    const preferred = makeCredentials(preferredAccountId, 3_000_000_000_000, "preferred");
    const other = makeCredentials(otherAccountId, 3_000_000_000_000, "other");
    const routedTokens: string[] = [];
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => preferred },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (_model, _context, options) => {
        routedTokens.push(options?.apiKey ?? "");
        return eventStream(successfulText());
      },
    });
    const preferredId = await controller.vault.addFromOAuth("preferred", preferred);
    const otherId = await controller.vault.addFromOAuth("other", other);

    await controller.operations.use(preferredId);
    await collectController(controller, { sessionId: "s1" });
    await controller.operations.use(otherId);
    await collectController(controller, { sessionId: "s2" });
    await collectController(controller, { sessionId: "   " });
    await controller.operations.use("auto");

    await collectController(controller, { sessionId: "s1" });
    await collectController(controller, { sessionId: "s2" });
    await collectController(controller);
    await collectController(controller, { sessionId: "" });
    await collectController(controller, { sessionId: "  " });

    expect(routedTokens).toEqual([
      preferred.access,
      other.access,
      other.access,
      preferred.access,
      other.access,
      other.access,
      other.access,
      other.access,
    ]);
    await controller.shutdown();
  });

  test("releases overlapping same-account streams independently", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const credential = makeCredentials("overlap-account", 3_000_000_000_000, "overlap");
    const streams = new Map<string, ReturnType<typeof createAssistantMessageEventStream>>();
    let markBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => credential },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (_model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        streams.set(options?.sessionId ?? "", stream);
        if (streams.size === 2) markBothStarted?.();
        return stream;
      },
    });
    await controller.vault.addFromOAuth("overlap", credential);
    const first = collectController(controller, { sessionId: "s1" });
    const second = collectController(controller, { sessionId: "s2" });
    const completed = new Set<string>();
    try {
      await bothStarted;
      const firstStream = streams.get("s1");
      const secondStream = streams.get("s2");
      if (!firstStream || !secondStream) throw new Error("expected held streams for both sessions");
      const stateStore = createAtomicJsonStore<RuntimeStateFile>({
        path: paths.state,
        schema: RuntimeStateFileSchema,
        createDefault: () => structuredClone(defaultRuntimeState),
      });
      const during = await stateStore.read();
      expect(during.reservations).toHaveLength(2);
      expect(new Set(during.reservations.map((value) => value.leaseToken)).size).toBe(2);

      for (const event of successfulText()) firstStream.push(event);
      completed.add("s1");
      await first;
      expect((await stateStore.read()).reservations).toHaveLength(1);
      for (const event of successfulText()) secondStream.push(event);
      completed.add("s2");
      await second;
      expect((await stateStore.read()).reservations).toEqual([]);
    } finally {
      for (const [sessionId, stream] of streams) {
        if (!completed.has(sessionId)) {
          for (const event of successfulText()) stream.push(event);
        }
      }
      await Promise.allSettled([first, second]);
      await controller.shutdown();
    }
  }, 2_000);

  test("cancels only one token while a same-account peer continues", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const credential = makeCredentials("cancel-overlap", 3_000_000_000_000, "cancel-overlap");
    const attempts = new Map<string, number>();
    let markBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    let finishPeer: (() => void) | undefined;
    const peerHeld = new Promise<void>((resolve) => {
      finishPeer = resolve;
    });
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => credential },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: ((
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: SimpleStreamOptions,
      ) => {
        const sessionId = options?.sessionId ?? "";
        return (async function* () {
          const attempt = (attempts.get(sessionId) ?? 0) + 1;
          attempts.set(sessionId, attempt);
          if (attempts.size === 2) markBothStarted?.();
          yield { type: "start", partial: message() } as AssistantMessageEvent;
          if (sessionId === "cancelled" && attempt === 1) {
            const signal = options?.signal;
            if (!signal) throw new Error("cancelled fixture requires an abort signal");
            signal.throwIfAborted();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          } else {
            await peerHeld;
            for (const event of successfulText().slice(1)) yield event;
          }
        })();
      }) as unknown as RouterControllerOptions["baseStream"],
    });
    await controller.vault.addFromOAuth("overlap", credential);
    const abort = new AbortController();
    const cancelled = collectController(controller, {
      sessionId: "cancelled",
      signal: abort.signal,
    });
    const peer = collectController(controller, { sessionId: "peer" });
    try {
      await bothStarted;
      const stateStore = createAtomicJsonStore<RuntimeStateFile>({
        path: paths.state,
        schema: RuntimeStateFileSchema,
        createDefault: () => structuredClone(defaultRuntimeState),
      });
      const before = await stateStore.read();
      expect(before.reservations).toHaveLength(2);
      const cancelledLease = before.reservations.find(
        (reservation) => reservation.owner.sessionId === "cancelled",
      );
      const peerLease = before.reservations.find(
        (reservation) => reservation.owner.sessionId === "peer",
      );
      if (!cancelledLease || !peerLease) throw new Error("expected both owned leases");
      abort.abort(new Error("synthetic caller cancellation"));
      expect((await cancelled).at(-1)?.type).toBe("error");
      const afterCancel = await stateStore.read();
      expect(afterCancel.reservations.map((reservation) => reservation.leaseToken)).toEqual([
        peerLease.leaseToken,
      ]);
      expect(afterCancel.reservations[0]?.leaseToken).not.toBe(cancelledLease.leaseToken);
      expect(afterCancel.blocks).toEqual([]);
      expect(Object.fromEntries(attempts)).toEqual({ cancelled: 1, peer: 1 });
      finishPeer?.();
      expect((await peer).at(-1)?.type).toBe("done");
      expect((await stateStore.read()).reservations).toEqual([]);

      expect((await collectController(controller, { sessionId: "cancelled" })).at(-1)?.type).toBe(
        "done",
      );
      expect(Object.fromEntries(attempts)).toEqual({ cancelled: 2, peer: 1 });
      const selectedEvents = (await readFile(paths.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; detail?: { reason?: string } })
        .filter((event) => event.type === "account_selected");
      const finalSelection = selectedEvents.at(-1);
      if (!finalSelection) throw new Error("expected a follow-up account_selected event");
      expect(finalSelection.detail?.reason).toBe("highest_weekly_urgency");
    } finally {
      abort.abort();
      finishPeer?.();
      await Promise.allSettled([cancelled, peer]);
      await controller.shutdown();
    }
  }, 2_000);

  test("coalesces credential refresh while same-account foreground streams overlap", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const original = makeCredentials("refresh-overlap", 1_999_999_999_999, "expired");
    const refreshed = makeCredentials("refresh-overlap", 3_000_000_000_000, "refreshed");
    let refreshes = 0;
    const streams = new Map<string, ReturnType<typeof createAssistantMessageEventStream>>();
    let markBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    let releaseRefresh: (() => void) | undefined;
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: {
        refresh: async () => {
          refreshes += 1;
          await refreshHeld;
          return refreshed;
        },
      },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (_model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        streams.set(options?.sessionId ?? "", stream);
        if (streams.size === 2) markBothStarted?.();
        return stream;
      },
    });
    const accountId = await controller.vault.addFromOAuth("overlap", original);
    await controller.operations.use(accountId);
    let credentialEntries = 0;
    let markBothCredentialEntries: (() => void) | undefined;
    const bothCredentialEntries = new Promise<void>((resolve) => {
      markBothCredentialEntries = resolve;
    });
    const getFreshCredential = controller.vault.getFreshCredential.bind(controller.vault);
    controller.vault.getFreshCredential = async (...args) => {
      credentialEntries += 1;
      if (credentialEntries === 2) markBothCredentialEntries?.();
      return getFreshCredential(...args);
    };
    const first = collectController(controller, { sessionId: "refresh-one" });
    const second = collectController(controller, { sessionId: "refresh-two" });
    let streamsCompleted = false;
    try {
      await bothCredentialEntries;
      expect(refreshes).toBe(1);
      releaseRefresh?.();
      await bothStarted;
      for (const stream of streams.values()) {
        for (const event of successfulText()) stream.push(event);
      }
      streamsCompleted = true;
      const results = await Promise.all([first, second]);
      expect(results.every((events) => events.at(-1)?.type === "done")).toBeTrue();
      expect(refreshes).toBe(1);
    } finally {
      releaseRefresh?.();
      if (!streamsCompleted) {
        for (const stream of streams.values()) {
          for (const event of successfulText()) stream.push(event);
        }
      }
      await Promise.allSettled([first, second]);
      await controller.shutdown();
    }
  }, 2_000);

  test("keeps concurrent generic 401 refresh caller-local under overlap", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const original = makeCredentials("401-overlap", 3_000_000_000_000, "original");
    const refreshed = makeCredentials("401-overlap", 3_000_000_000_000, "refreshed");
    let refreshes = 0;
    let markRefreshStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let releaseRefresh: (() => void) | undefined;
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let originalAttempts = 0;
    let markBothOriginal: (() => void) | undefined;
    const bothOriginal = new Promise<void>((resolve) => {
      markBothOriginal = resolve;
    });
    let releaseOriginal: (() => void) | undefined;
    const originalHeld = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    const keys = new Map<string, string[]>();
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: {
        refresh: async () => {
          refreshes += 1;
          markRefreshStarted?.();
          await refreshHeld;
          return refreshed;
        },
      },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: ((
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: SimpleStreamOptions,
      ) => {
        const sessionId = options?.sessionId ?? "";
        keys.set(sessionId, [...(keys.get(sessionId) ?? []), options?.apiKey ?? ""]);
        if (options?.apiKey !== original.access) return eventStream(successfulText());
        return (async function* () {
          originalAttempts += 1;
          if (originalAttempts === 2) markBothOriginal?.();
          await originalHeld;
          yield { type: "start", partial: message() } as AssistantMessageEvent;
          yield {
            type: "error",
            reason: "error",
            error: message("error", "unauthorized"),
          } as AssistantMessageEvent;
        })();
      }) as unknown as RouterControllerOptions["baseStream"],
    });
    await controller.vault.addFromOAuth("overlap", original);
    let forceRefreshEntries = 0;
    let markBothForceRefreshEntries: (() => void) | undefined;
    const bothForceRefreshEntries = new Promise<void>((resolve) => {
      markBothForceRefreshEntries = resolve;
    });
    const forceRefreshCredential = controller.vault.forceRefreshCredential.bind(controller.vault);
    controller.vault.forceRefreshCredential = async (...args) => {
      forceRefreshEntries += 1;
      if (forceRefreshEntries === 2) markBothForceRefreshEntries?.();
      return forceRefreshCredential(...args);
    };
    const abort = new AbortController();
    const cancelled = collectController(controller, {
      sessionId: "cancelled-401",
      signal: abort.signal,
    });
    const peer = collectController(controller, { sessionId: "peer-401" });
    try {
      await bothOriginal;
      const stateStore = createAtomicJsonStore<RuntimeStateFile>({
        path: paths.state,
        schema: RuntimeStateFileSchema,
        createDefault: () => structuredClone(defaultRuntimeState),
      });
      const during = await stateStore.read();
      expect(during.reservations).toHaveLength(2);
      expect(new Set(during.reservations.map((value) => value.leaseToken)).size).toBe(2);
      releaseOriginal?.();
      await refreshStarted;
      await bothForceRefreshEntries;
      abort.abort(new Error("synthetic caller cancellation"));
      releaseRefresh?.();
      expect((await cancelled).at(-1)?.type).toBe("error");
      expect((await peer).at(-1)?.type).toBe("done");
      expect(refreshes).toBe(1);
      expect(keys.get("cancelled-401")).toEqual([original.access]);
      expect(keys.get("peer-401")).toEqual([original.access, refreshed.access]);
      expect((await stateStore.read()).reservations).toEqual([]);
      expect((await stateStore.read()).blocks).toEqual([]);
    } finally {
      abort.abort();
      releaseOriginal?.();
      releaseRefresh?.();
      await Promise.allSettled([cancelled, peer]);
      await controller.shutdown();
    }
  }, 2_000);

  test("keeps headroom and manual policy authoritative with foreground peers", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const low = makeCredentials("headroom-low", 3_000_000_000_000, "low");
    const safe = makeCredentials("headroom-safe", 3_000_000_000_000, "safe");
    const routedKeys: string[] = [];
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => low },
      fetchImpl: async (_input, init) => {
        const rawAccountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
        return Response.json({
          ...completeUsageResponse,
          rate_limit: {
            ...completeUsageResponse.rate_limit,
            secondary_window: {
              ...completeUsageResponse.rate_limit.secondary_window,
              used_percent: rawAccountId === "headroom-low" ? 99 : 20,
            },
          },
        });
      },
      baseStream: (_model, _context, options) => {
        routedKeys.push(options?.apiKey ?? "");
        return eventStream(successfulText());
      },
    });
    const lowId = await controller.vault.addFromOAuth("low", low);
    const safeId = await controller.vault.addFromOAuth("safe", safe);
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await stateStore.update((state) => ({
      ...state,
      reservations: [lowId, safeId].map((accountId, index) => ({
        accountId,
        leaseToken: `foreground-policy-peer-${index}`,
        owner: { processId: 7, sessionId: `peer-${index}`, requestId: `peer-${index}` },
        createdAt: 2_000_000_000_000,
        expiresAt: 2_000_000_060_000,
        kind: "foreground" as const,
      })),
    }));

    await collectController(controller);
    await controller.operations.use(lowId);
    await collectController(controller);

    expect(routedKeys).toEqual([safe.access, low.access]);
    expect((await stateStore.read()).reservations).toHaveLength(2);
    await controller.shutdown();
  });

  test("keeps replay-safe quota failover token-local while a foreground peer remains", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const { preferredAccountId, otherAccountId } = automaticTieAccountIds();
    const preferred = makeCredentials(preferredAccountId, 3_000_000_000_000, "preferred");
    const other = makeCredentials(otherAccountId, 3_000_000_000_000, "other");
    let peerStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
    let markPeerStarted: (() => void) | undefined;
    const peerStarted = new Promise<void>((resolve) => {
      markPeerStarted = resolve;
    });
    const keys = new Map<string, string[]>();
    const affinityOrder: string[] = [];
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => preferred },
      fetchImpl: async () => Response.json(completeUsageResponse),
      closeSessionWebSockets: (sessionId) => affinityOrder.push(`close:${sessionId}`),
      baseStream: (_model, _context, options) => {
        const sessionId = options?.sessionId ?? "";
        keys.set(sessionId, [...(keys.get(sessionId) ?? []), options?.apiKey ?? ""]);
        affinityOrder.push(
          `stream:${sessionId}:${options?.apiKey === preferred.access ? "preferred" : "other"}`,
        );
        if (sessionId === "peer") {
          peerStream = createAssistantMessageEventStream();
          markPeerStarted?.();
          return peerStream;
        }
        return options?.apiKey === preferred.access
          ? eventStream([
              { type: "start", partial: message() },
              {
                type: "error",
                reason: "error",
                error: message("error", "usage limit reached"),
              },
            ])
          : eventStream(successfulText());
      },
    });
    const preferredId = await controller.vault.addFromOAuth("preferred", preferred);
    await controller.vault.addFromOAuth("other", other);
    const peer = collectController(controller, { sessionId: "peer" });
    try {
      await peerStarted;
      const stateStore = createAtomicJsonStore<RuntimeStateFile>({
        path: paths.state,
        schema: RuntimeStateFileSchema,
        createDefault: () => structuredClone(defaultRuntimeState),
      });
      const peerToken = (await stateStore.read()).reservations.find(
        (reservation) => reservation.owner.sessionId === "peer",
      )?.leaseToken;
      if (!peerToken) throw new Error("expected held peer lease token");
      const failedOver = await collectController(controller, { sessionId: "failing" });
      expect(failedOver.map((event) => event.type)).toEqual([
        "start",
        "text_start",
        "text_delta",
        "text_end",
        "done",
      ]);
      expect(keys.get("failing")).toEqual([preferred.access, other.access]);
      expect(affinityOrder.filter((entry) => entry.includes("failing"))).toEqual([
        "stream:failing:preferred",
        "close:failing",
        "stream:failing:other",
      ]);
      const during = await stateStore.read();
      expect(during.reservations.map((reservation) => reservation.leaseToken)).toEqual([peerToken]);
      expect(during.reservations[0]?.accountId).toBe(preferredId);
      expect(during.blocks.some((block) => block.accountId === preferredId)).toBeTrue();
    } finally {
      if (peerStream) {
        for (const event of successfulText()) peerStream.push(event);
      }
      await peer;
      await controller.shutdown();
    }
  }, 2_000);

  test("clears successful session affinity on shutdown", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const { preferredAccountId, otherAccountId } = automaticTieAccountIds();
    const preferred = makeCredentials(preferredAccountId, 3_000_000_000_000, "preferred");
    const other = makeCredentials(otherAccountId, 3_000_000_000_000, "other");
    const routedTokens: string[] = [];
    const options: RouterControllerOptions = {
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => preferred },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (_model, _context, options) => {
        routedTokens.push(options?.apiKey ?? "");
        return eventStream(successfulText());
      },
    };
    const controller = await createRouterController(options);
    await controller.vault.addFromOAuth("preferred", preferred);
    const otherId = await controller.vault.addFromOAuth("other", other);
    await controller.operations.use(otherId);
    await collectController(controller, { sessionId: "s1" });
    await controller.operations.use("auto");
    await controller.shutdown();

    const restarted = await createRouterController(options);
    await collectController(restarted, { sessionId: "s1" });
    await restarted.shutdown();

    expect(routedTokens).toEqual([other.access, preferred.access]);
  });

  test("lets urgency outside the hysteresis band override session affinity", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const { preferredAccountId, otherAccountId } = automaticTieAccountIds();
    const preferred = makeCredentials(preferredAccountId, 3_000_000_000_000, "preferred");
    const other = makeCredentials(otherAccountId, 3_000_000_000_000, "other");
    const routedTokens: string[] = [];
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => preferred },
      fetchImpl: async (_input, init) => {
        const rawAccountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
        return Response.json({
          ...completeUsageResponse,
          rate_limit: {
            ...completeUsageResponse.rate_limit,
            secondary_window: {
              ...completeUsageResponse.rate_limit.secondary_window,
              used_percent: rawAccountId === preferredAccountId ? 50 : 20,
            },
          },
        });
      },
      baseStream: (_model, _context, options) => {
        routedTokens.push(options?.apiKey ?? "");
        return eventStream(successfulText());
      },
    });
    const preferredId = await controller.vault.addFromOAuth("preferred", preferred);
    await controller.vault.addFromOAuth("other", other);

    await controller.operations.use(preferredId);
    await collectController(controller, { sessionId: "s1" });
    await controller.operations.use("auto");
    await collectController(controller, { sessionId: "s1" });

    expect(routedTokens).toEqual([preferred.access, other.access]);
    await controller.shutdown();
  });

  test("does not share successful affinity between controllers", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const { preferredAccountId, otherAccountId } = automaticTieAccountIds();
    const preferred = makeCredentials(preferredAccountId, 3_000_000_000_000, "preferred");
    const other = makeCredentials(otherAccountId, 3_000_000_000_000, "other");
    const routedTokens: string[] = [];
    const options: RouterControllerOptions = {
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => preferred },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (_model, _context, streamOptions) => {
        routedTokens.push(streamOptions?.apiKey ?? "");
        return eventStream(successfulText());
      },
    };
    const first = await createRouterController(options);
    await first.vault.addFromOAuth("preferred", preferred);
    const otherId = await first.vault.addFromOAuth("other", other);
    await first.operations.use(otherId);
    await collectController(first, { sessionId: "s1" });
    await first.operations.use("auto");

    const second = await createRouterController(options);
    await collectController(second, { sessionId: "s1" });

    expect(routedTokens).toEqual([other.access, preferred.access]);
    await first.shutdown();
    await second.shutdown();
  });

  test("applies health vetoes before remembered session affinity", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const { preferredAccountId, otherAccountId } = automaticTieAccountIds();
    const preferred = makeCredentials(preferredAccountId, 3_000_000_000_000, "preferred");
    const other = makeCredentials(otherAccountId, 3_000_000_000_000, "other");
    const routedTokens: string[] = [];
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => preferred },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (_model, _context, options) => {
        routedTokens.push(options?.apiKey ?? "");
        return eventStream(successfulText());
      },
    });
    const preferredId = await controller.vault.addFromOAuth("preferred", preferred);
    await controller.vault.addFromOAuth("other", other);
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });

    await controller.operations.use(preferredId);
    await collectController(controller, { sessionId: "s1" });
    await controller.operations.use("auto");
    await stateStore.update((state) => ({
      ...state,
      blocks: [
        {
          accountId: preferredId,
          kind: "quota",
          blockedAt: 2_000_000_000_000,
          retryAt: 2_000_003_600_000,
          estimated: false,
        },
      ],
    }));
    await collectController(controller, { sessionId: "s1" });

    await stateStore.update((state) => ({ ...state, blocks: [] }));
    await controller.operations.use(preferredId);
    await collectController(controller, { sessionId: "s1" });
    await controller.operations.use("auto");
    await controller.vault.markNeedsReauth(preferredId, preferred.access, "invalid_grant");
    await collectController(controller, { sessionId: "s1" });

    await controller.vault.addFromOAuth("preferred", preferred);
    await controller.operations.use(preferredId);
    await collectController(controller, { sessionId: "s1" });
    await controller.operations.use("auto");
    await stateStore.update((state) => ({
      ...state,
      reservations: [
        {
          accountId: preferredId,
          leaseToken: "synthetic-primer-affinity-veto",
          owner: { processId: 7, sessionId: "primer", requestId: "primer" },
          createdAt: 2_000_000_000_000,
          expiresAt: 2_000_000_060_000,
          kind: "primer",
        },
      ],
    }));
    await collectController(controller, { sessionId: "s1" });

    expect(routedTokens).toEqual([
      preferred.access,
      other.access,
      preferred.access,
      other.access,
      preferred.access,
      other.access,
    ]);
    await controller.shutdown();
  });

  test("prefers a fresh tier over remembered stale usage", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const { preferredAccountId, otherAccountId } = automaticTieAccountIds();
    const preferred = makeCredentials(preferredAccountId, 3_000_000_000_000, "preferred");
    const other = makeCredentials(otherAccountId, 3_000_000_000_000, "other");
    let now = 2_000_000_000_000;
    let preferredOffline = false;
    const routedTokens: string[] = [];
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => now,
      oauth: { refresh: async () => preferred },
      fetchImpl: async (_input, init) => {
        const rawAccountId = new Headers(init?.headers).get("ChatGPT-Account-Id");
        if (preferredOffline && rawAccountId === preferredAccountId) {
          throw new Error("synthetic usage outage");
        }
        return Response.json(completeUsageResponse);
      },
      baseStream: (_model, _context, options) => {
        routedTokens.push(options?.apiKey ?? "");
        return eventStream(successfulText());
      },
    });
    const preferredId = await controller.vault.addFromOAuth("preferred", preferred);
    await controller.vault.addFromOAuth("other", other);
    await controller.operations.refresh(preferredId);
    await controller.operations.use(preferredId);
    await collectController(controller, { sessionId: "s1" });
    await controller.operations.use("auto");
    now += defaultConfig.usageFreshnessMs + 1;
    preferredOffline = true;

    await collectController(controller, { sessionId: "s1" });

    expect(routedTokens).toEqual([preferred.access, other.access]);
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
    expect(await controller.operations.dashboard()).toContain("work");
    expect(await controller.operations.verify()).toContain("healthy");
    expect(await controller.operations.paths()).toContain("accounts.json");
    await controller.shutdown();
  });

  test("routes and lists an account with only a duration-tagged weekly window", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    let backendKey: string | undefined;
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(weeklyOnlyPrimaryUsageResponse),
      baseStream: (_model, _context, options) => {
        backendKey = options?.apiKey;
        return eventStream(successfulText());
      },
    });
    await controller.vault.addFromOAuth(
      "weekly-only",
      makeCredentials("account-1", 3_000_000_000_000),
    );

    const events = await collectController(controller);
    const list = await controller.operations.list();

    expect(events.at(-1)?.type).toBe("done");
    expect(backendKey).toContain(".");
    expect(list).toContain("5h n/a");
    expect(list).toContain("7d 97% remaining");
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

  test("force refreshes a usage 401 before routing", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const original = makeCredentials("account-1", 3_000_000_000_000, "original");
    const refreshed = makeCredentials("account-1", 3_000_000_000_000, "refreshed");
    const usageKeys: string[] = [];
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
        const authorization = new Headers(init?.headers).get("Authorization") ?? "";
        usageKeys.push(authorization);
        return authorization === `Bearer ${original.access}`
          ? new Response(null, { status: 401 })
          : Response.json(completeUsageResponse);
      },
      baseStream: () => eventStream(successfulText()),
    });
    await controller.vault.addFromOAuth("work", original);

    const events = await collectController(controller);

    expect(events.at(-1)?.type).toBe("done");
    expect(usageKeys).toEqual([`Bearer ${original.access}`, `Bearer ${refreshed.access}`]);
    expect(refreshes).toBe(1);
    await controller.shutdown();
  });

  test("propagates caller aborts during usage collection", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const cancellation = new AbortController();
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
          cancellation.abort(new Error("SIGINT"));
        }),
      baseStream: () => eventStream(successfulText()),
    });
    await controller.vault.addFromOAuth("work", makeCredentials("account-1", 3_000_000_000_000));

    const events = await collectController(controller, { signal: cancellation.signal });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].error.errorMessage).toBe("SIGINT");
    }
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    expect((await stateStore.read()).reservations).toEqual([]);
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

  test("records fresh exhausted usage as a quota block and fails promptly", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const now = 2_000_000_000_000;
    const resetAt = now + 600_000;
    let streamCalls = 0;
    const controller = await createRouterController({
      paths,
      clock: () => now,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () =>
        Response.json({
          ...completeUsageResponse,
          rate_limit: {
            ...completeUsageResponse.rate_limit,
            primary_window: {
              ...completeUsageResponse.rate_limit.primary_window,
              used_percent: 100,
              reset_at: resetAt,
            },
          },
        }),
      baseStream: () => {
        streamCalls += 1;
        return eventStream(successfulText());
      },
    });
    await controller.vault.addFromOAuth("work", makeCredentials("account-1", 3_000_000_000_000));
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    const events = await collectController(controller);
    const block = (await stateStore.read()).blocks[0];

    expect(block).toEqual({
      accountId: expect.any(String),
      kind: "quota",
      blockedAt: now,
      retryAt: resetAt,
      estimated: false,
    });
    expect(streamCalls).toBe(0);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].reason).toBe("error");
      expect(events[0].error.errorMessage).toBe(
        "No Codex account is currently eligible; quota, usage data, or account health must recover before retrying",
      );
    }
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

  test("routes a manual account without fetching usage", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    let usageCalls = 0;
    let routedAccessToken: string | undefined;
    const manualCredentials = makeCredentials("account-2", 3_000_000_000_000, "manual");
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => manualCredentials },
      fetchImpl: async () => {
        usageCalls += 1;
        throw new Error("usage endpoint unavailable");
      },
      baseStream: (_model, _context, options) => {
        routedAccessToken = options?.apiKey;
        return eventStream(successfulText());
      },
    });
    await controller.vault.addFromOAuth(
      "unrelated",
      makeCredentials("account-1", 3_000_000_000_000, "unrelated"),
    );
    const manualAccountId = await controller.vault.addFromOAuth("manual", manualCredentials);
    await controller.operations.use(manualAccountId);

    await collectController(controller);

    expect(usageCalls).toBe(0);
    expect(routedAccessToken).toBe(manualCredentials.access);
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

  test("primes at most one account without enabling automatic priming", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const usageCalls = new Map<string, number>();
    let primerCalls = 0;
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async (_input, init) => {
        const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id") ?? "unknown";
        const calls = (usageCalls.get(accountId) ?? 0) + 1;
        usageCalls.set(accountId, calls);
        return Response.json({
          rate_limit: {
            primary_window: { used_percent: 0, reset_at: 2_000_018_000 },
            secondary_window: {
              used_percent: 0,
              ...(calls > 1 ? { reset_at: 2_000_604_800 } : {}),
            },
          },
        });
      },
      baseStream: () => {
        primerCalls += 1;
        return eventStream(successfulText());
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

    const model = Object.values(OPENAI_CODEX_MODELS)[0] as Model<"openai-codex-responses">;
    const result = await controller.operations.prime("all", model.id);
    const config = await configStore.read();

    expect(result).toContain("first: confirmed");
    expect(primerCalls).toBe(1);
    expect(usageCalls.has("account-2")).toBe(false);
    expect(config.priming.enabled).toBe(false);
    expect(config.priming.confirmedFirstUseRollingWindow).toBe(false);
    await controller.shutdown();
  });

  test("rejects ambiguous labels for use, refresh, and one-shot prime", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    let usageCalls = 0;
    let primerCalls = 0;
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
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
    await controller.vault.addFromOAuth(
      "duplicate",
      makeCredentials("account-1", 3_000_000_000_000),
    );
    await controller.vault.addFromOAuth(
      "duplicate",
      makeCredentials("account-2", 3_000_000_000_000),
    );

    const outcomes: string[] = [];
    for (const operation of [
      () => controller.operations.use("duplicate"),
      () => controller.operations.refresh("duplicate"),
      () => controller.operations.prime("duplicate"),
    ]) {
      try {
        await operation();
        outcomes.push("resolved");
      } catch (error) {
        outcomes.push(error instanceof Error ? error.message : String(error));
      }
    }

    expect(outcomes).toEqual(
      Array.from(
        { length: 3 },
        () =>
          "Ambiguous Codex account label: duplicate. Use a managed account id: codex-07e998012c11, codex-703039e88185",
      ),
    );
    expect(usageCalls).toBe(0);
    expect(primerCalls).toBe(0);
    await controller.shutdown();
  });

  test("ignores the legacy recovery wait and fails a blocked foreground route promptly", async () => {
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
      expect(events[0].error.errorMessage).toBe(
        "No Codex account is currently eligible; quota, usage data, or account health must recover before retrying",
      );
    }
    await controller.shutdown();
  });

  test("fails immediately after every account fails before output", async () => {
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
    await configStore.update((config) => ({
      ...config,
      maxRotationAttempts: 3,
    }));

    const events = await collectController(controller);

    expect(streamCalls).toBe(2);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].error.errorMessage).toBe(
        "No Codex account is currently eligible; quota, usage data, or account health must recover before retrying",
      );
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

  test("clears an account auth block after successful reauthentication", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const credentials = makeCredentials("account-1", 3_000_000_000_000);
    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => credentials },
      login: async (callbacks) => {
        callbacks.onAuth({ url: AUTHORIZATION_URL });
        return credentials;
      },
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
          kind: "auth",
          blockedAt: 2_000_000_000_000,
          estimated: false,
        },
      ],
    }));

    await controller.operations.login("work", {
      ui: {
        notify: () => undefined,
        select: async () => "Show authorization URL for manual use",
        input: async () => "manual-code",
      },
    } as never);

    expect((await stateStore.read()).blocks).toEqual([]);
    await controller.shutdown();
  });

  test("updates the active label after successful reauthentication", async () => {
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
    await controller.vault.addFromOAuth("old", credentials);
    await collectController(controller);

    await controller.operations.login("new", {
      ui: {
        notify: () => undefined,
        select: async () => "Show authorization URL for manual use",
        input: async () => "manual-code",
      },
    } as never);

    expect(await controller.operations.status()).toContain("new");
    await controller.shutdown();
  });

  test("restores a manual account label after restart", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const options = {
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => eventStream(successfulText()),
    };
    const first = await createRouterController(options);
    const accountId = await first.vault.addFromOAuth(
      "work",
      makeCredentials("account-1", 3_000_000_000_000),
    );
    await first.operations.use(accountId);
    await first.shutdown();

    const second = await createRouterController(options);

    expect(await second.operations.status()).toBe("Codex · work · manual");
    await second.shutdown();
  });

  test("restores the persisted selected account label after restart", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const options = {
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => eventStream(successfulText()),
    };
    const first = await createRouterController(options);
    await first.vault.addFromOAuth("work", makeCredentials("account-1", 3_000_000_000_000));
    await collectController(first);
    await first.shutdown();

    const second = await createRouterController(options);

    expect(await second.operations.status()).toContain("Codex · work ·");
    expect(await second.operations.status()).toEndWith("· auto");
    await second.shutdown();
  });

  test("reports automatic routing after restart when the vault has accounts", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const options = {
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => eventStream(successfulText()),
    };
    const first = await createRouterController(options);
    await first.vault.addFromOAuth("work", makeCredentials("account-1", 3_000_000_000_000));
    await first.shutdown();

    const second = await createRouterController(options);

    expect(await second.operations.status()).toBe("Codex · work · auto");
    await second.shutdown();
  });

  test("reports login after restart when manual configuration outlives the vault account", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const options = {
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => eventStream(successfulText()),
    };
    const first = await createRouterController(options);
    const accountId = await first.vault.addFromOAuth(
      "work",
      makeCredentials("account-1", 3_000_000_000_000),
    );
    await first.operations.use(accountId);
    await first.vault.remove(accountId);
    await first.shutdown();

    const second = await createRouterController(options);

    expect(await second.operations.status()).toBe("Codex · none · login");
    await second.shutdown();
  });

  test("persists usage for restart fallback and reconciles estimated blocks", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    let now = 2_000_000_000_000;
    let usageCalls = 0;
    let usageOffline = false;
    const options = {
      paths,
      clock: () => now,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => {
        usageCalls += 1;
        if (usageOffline) {
          throw new Error("offline");
        }
        return Response.json(completeUsageResponse);
      },
      baseStream: () => eventStream(successfulText()),
    };
    const first = await createRouterController(options);
    const accountId = await first.vault.addFromOAuth(
      "work",
      makeCredentials("account-1", 3_000_000_000_000),
    );
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
          kind: "quota",
          blockedAt: now,
          retryAt: now + 3_600_000,
          estimated: true,
        },
      ],
    }));

    now += 1;
    await first.operations.refresh();
    const persisted = await stateStore.read();
    expect(persisted.usageSnapshots).toHaveLength(1);
    expect(persisted.blocks).toEqual([]);
    await first.shutdown();

    now += 60_000;
    const second = await createRouterController(options);
    expect(await second.operations.list()).toContain("5h 88% remaining");
    await collectController(second);
    expect(usageCalls).toBe(1);
    now += 300_001;
    usageOffline = true;
    expect((await collectController(second)).at(-1)?.type).toBe("done");
    expect(usageCalls).toBe(2);
    expect((await stateStore.read()).usageSnapshots[0]?.observedAt).toBe(2_000_000_000_001);
    await second.shutdown();
  });

  test("does not rewrite valid version-one state during startup", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const paths = resolveRouterPaths(fixture.directory);
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await stateStore.update((state) => ({
      ...state,
      reservations: ["one", "two"].map((leaseToken, index) => ({
        accountId: "a",
        leaseToken,
        owner: { processId: index + 1, sessionId: `s${index}`, requestId: `r${index}` },
        createdAt: 2_000_000_000_000,
        expiresAt: 2_000_000_060_000,
        kind: "foreground" as const,
      })),
    }));
    const knownOldTime = new Date(1_900_000_000_000);
    await utimes(paths.state, knownOldTime, knownOldTime);
    const beforeText = await readFile(paths.state, "utf8");
    const beforeStat = await stat(paths.state);

    const controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("unused", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => eventStream(successfulText()),
    });

    expect(await readFile(paths.state, "utf8")).toBe(beforeText);
    const afterStat = await stat(paths.state);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.ino).toBe(beforeStat.ino);
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

async function collectController(
  controller: Awaited<ReturnType<typeof createRouterController>>,
  options?: SimpleStreamOptions,
) {
  const model = Object.values(OPENAI_CODEX_MODELS)[0] as Model<"openai-codex-responses">;
  const events: AssistantMessageEvent[] = [];
  for await (const event of controller.routedStream(model, { messages: [] } as Context, options)) {
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
