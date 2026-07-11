import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { AccountNeedsReauthError } from "../../src/accounts/account-vault.ts";
import { defaultConfig } from "../../src/config.ts";
import { createPrimingController } from "../../src/priming/priming-controller.ts";
import { classifyFailure } from "../../src/recovery/failure-classifier.ts";
import { waitForRecovery } from "../../src/recovery/wait-for-recovery.ts";
import { createRouterController } from "../../src/router-controller.ts";
import { createReservationStore } from "../../src/routing/reservation-store.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import { resolveRouterPaths } from "../../src/storage/paths.ts";
import {
  defaultRuntimeState,
  RouterConfigSchema,
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

  test("two concurrent controllers share one account with distinct leases", async () => {
    const home = await createIsolatedPiHome();
    cleanups.push(home.cleanup);
    const paths = resolveRouterPaths(home.agentDirectory);
    const credential = makeCredentials("concurrent-a", NOW + 3_600_000);
    const refreshCredential = makeCredentials("concurrent-refresh", NOW + 3_600_000);
    const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
    const keys: string[] = [];
    let markBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const delayedStream: RoutedStreamDependencies["baseStream"] = (_model, _context, options) => {
      keys.push(options?.apiKey ?? "");
      const stream = createAssistantMessageEventStream();
      streams.push(stream);
      if (streams.length === 2) {
        markBothStarted?.();
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
    await first.vault.addFromOAuth("account", credential);

    const firstResult = collect(first.routedStream(model, context, { sessionId: "first" }));
    const secondResult = collect(second.routedStream(model, context, { sessionId: "second" }));
    let completed = false;
    try {
      await bothStarted;
      const stateStore = createAtomicJsonStore<RuntimeStateFile>({
        path: paths.state,
        schema: RuntimeStateFileSchema,
        createDefault: () => structuredClone(defaultRuntimeState),
      });
      const during = await stateStore.read();
      expect(during.reservations).toHaveLength(2);
      expect(new Set(during.reservations.map((value) => value.leaseToken)).size).toBe(2);
      for (const stream of streams) {
        for (const event of successfulText()) stream.push(event);
      }
      completed = true;
      const results = await Promise.all([firstResult, secondResult]);

      expect(results.every((events) => events.at(-1)?.type === "done")).toBeTrue();
      expect(keys).toEqual([credential.access, credential.access]);
      expect((await stateStore.read()).reservations).toEqual([]);
    } finally {
      if (!completed) {
        for (const stream of streams) {
          for (const event of successfulText()) stream.push(event);
        }
      }
      await Promise.allSettled([firstResult, secondResult]);
      await Promise.all([first.shutdown(), second.shutdown()]);
    }
  }, 2_000);

  test("an account primer lease fences a foreground worker across processes", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await stateStore.update((state) => ({
      ...state,
      reservations: [
        {
          accountId: "a",
          leaseToken: "synthetic-cross-process-primer",
          owner: { processId: 7, sessionId: "primer", requestId: "primer" },
          createdAt: NOW,
          expiresAt: NOW + 60_000,
          kind: "primer",
        },
      ],
    }));
    const worker = new URL("../helpers/worker-select.ts", import.meta.url).pathname;
    const select = async (requestId: string, accountIds = "a") => {
      const child = Bun.spawn(
        [process.execPath, worker, fixture.file, requestId, accountIds, "false"],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const result = Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      try {
        const [exitCode, stdout, stderr] = await Promise.race([
          result,
          Bun.sleep(5_000).then(() => {
            throw new Error("foreground worker timed out");
          }),
        ]);
        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        return JSON.parse(stdout) as { accountId?: string };
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    };

    expect((await select("primer-blocked", "a,b")).accountId).toBe("b");
    expect((await stateStore.read()).lastSelection?.candidates[0]?.rejectionCode).toBe(
      "primer_active",
    );
    await stateStore.update((state) => ({ ...state, reservations: [] }));
    expect((await select("primer-released")).accountId).toBe("a");

    await stateStore.update((state) => ({
      ...state,
      reservations: [
        {
          accountId: "__primer_sweep__",
          leaseToken: "synthetic-sweep-only",
          owner: { processId: 7, sessionId: "sweep", requestId: "sweep" },
          createdAt: NOW,
          expiresAt: NOW + 60_000,
          kind: "primer",
        },
      ],
    }));
    expect((await select("sweep-does-not-veto")).accountId).toBe("a");
  });

  test("a held foreground worker fences primer acquisition across processes", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await stateStore.read();
    const reservations = createReservationStore(stateStore);
    let usageCalls = 0;
    let providerCalls = 0;
    const primer = createPrimingController({
      config: () => ({ ...defaultConfig, priming: { ...defaultConfig.priming, enabled: true } }),
      stateStore,
      reservations,
      usage: {
        get: async () => {
          usageCalls += 1;
          return {
            accountId: "a",
            observedAt: NOW,
            shortWindow: { usedPercent: 0, resetsAt: NOW + 18_000_000 },
            weeklyWindow: { usedPercent: 0 },
            stale: false,
          };
        },
      },
      listAccountIds: async () => ["a"],
      executePrimer: async () => {
        providerCalls += 1;
      },
      clock: () => NOW,
      owner: { processId: process.pid, sessionId: "test-primer", requestId: "test-primer" },
      currentModelId: () => "gpt-test",
      lowestReasoning: () => "minimal",
    });
    const worker = new URL("../helpers/worker-select.ts", import.meta.url).pathname;
    const child = Bun.spawn(
      [process.execPath, worker, fixture.file, "held-foreground", "a", "true"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = child.stdout.getReader();
    const stderr = new Response(child.stderr).text();
    try {
      const line = await Promise.race([
        readLine(reader),
        Bun.sleep(5_000).then(() => {
          throw new Error("held foreground worker timed out");
        }),
      ]);
      const selected = JSON.parse(line) as { leaseToken?: string };
      expect(await primer.primeAccount("a", { authorization: "one-shot" })).toEqual({
        status: "reserved",
      });
      expect(usageCalls).toBe(0);
      expect(providerCalls).toBe(0);
      child.kill();
      await child.exited;
      expect(await stderr).toBe("");
      if (!selected.leaseToken) throw new Error("foreground worker did not return a lease token");
      await reservations.release(selected.leaseToken);
      expect(await primer.primeAccount("a", { authorization: "one-shot" })).toEqual({
        status: "inconclusive",
      });
      expect(usageCalls).toBe(2);
      expect(providerCalls).toBe(1);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await reader.cancel().catch(() => undefined);
      await stderr;
      await primer.shutdown();
    }
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

  test("primes one untouched account without enabling future background priming", async () => {
    const home = await createIsolatedPiHome();
    cleanups.push(home.cleanup);
    const credentials = [
      makeCredentials("untouched-account-a", NOW + 3_600_000),
      makeCredentials("untouched-account-b", NOW + 3_600_000),
    ] as const;
    let primedAccountId: string | undefined;
    let primerCalls = 0;
    let normalCalls = 0;
    let primerModelId: string | undefined;
    const selectedModel = Object.values(OPENAI_CODEX_MODELS)[1] as Model<"openai-codex-responses">;
    const controller = await createRouterController({
      paths: resolveRouterPaths(home.agentDirectory),
      clock: () => NOW,
      oauth: { refresh: async () => credentials[0] },
      fetchImpl: fakeCodexUsage((accountId) =>
        usageResponse({
          shortUsed: 0,
          weeklyUsed: 0,
          ...(primedAccountId === accountId ? { weeklyResetAt: NOW + 7 * 24 * 3_600_000 } : {}),
        }),
      ),
      baseStream: (streamModel, _context, options) => {
        if (options?.maxTokens === 1) {
          primerCalls += 1;
          primedAccountId =
            options.apiKey === credentials[0]?.access
              ? "untouched-account-a"
              : "untouched-account-b";
          primerModelId = streamModel.id;
        } else {
          normalCalls += 1;
        }
        return eventStream(successfulText());
      },
    });
    await controller.vault.addFromOAuth("untouched-a", credentials[0]);
    await controller.vault.addFromOAuth("untouched-b", credentials[1]);

    expect(await controller.operations.prime(undefined, selectedModel.id)).toContain("confirmed");
    expect(primerCalls).toBe(1);
    expect(JSON.parse(await controller.operations.policy()).priming).toMatchObject({
      enabled: false,
      confirmedFirstUseRollingWindow: false,
    });
    expect(primerCalls).toBe(1);
    expect(primerModelId).toBe(selectedModel.id);
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

  test("keeps synthetic secrets and content out of every routed diagnostic surface", async () => {
    const home = await createIsolatedPiHome();
    cleanups.push(home.cleanup);
    const boundary = syntheticBoundaryFixture();
    const paths = resolveRouterPaths(home.agentDirectory);
    const configStore = createAtomicJsonStore({
      path: paths.config,
      schema: RouterConfigSchema,
      createDefault: () => structuredClone(defaultConfig),
    });
    await configStore.update((config) => ({
      ...config,
      maxRotationAttempts: 2,
      reservationTtlMs: 15,
    }));
    let mode:
      | "success"
      | "auth-retry"
      | "auth-exhausted"
      | "pre-quota"
      | "post-quota"
      | "thrown"
      | "hold" = "success";
    let modeCalls = 0;
    let streamEntered: (() => void) | undefined;
    const waitForAbort = (options?: SimpleStreamOptions) =>
      (async function* () {
        yield start();
        streamEntered?.();
        const signal = options?.signal;
        if (!signal) throw new Error("missing heartbeat signal");
        signal.throwIfAborted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })();
    const controller = await createRouterController({
      paths,
      clock: () => NOW,
      oauth: {
        refresh: async (refreshToken) =>
          boundary.credentials.find((credential) => credential.refresh === refreshToken) ??
          boundary.credentials[0],
      },
      fetchImpl: fakeCodexUsage(() =>
        usageResponse({ weeklyUsed: 30, weeklyResetAt: NOW + 48 * 3_600_000 }),
      ),
      baseStream: (_model, _context, options) => {
        modeCalls += 1;
        if (mode === "hold") {
          return waitForAbort(options) as unknown as ReturnType<
            RoutedStreamDependencies["baseStream"]
          >;
        }
        if ((mode === "auth-retry" && modeCalls === 1) || mode === "auth-exhausted") {
          return eventStream([
            start(),
            {
              type: "error",
              reason: "error",
              error: message("error", `401 unauthorized ${boundary.providerPayload}`),
            },
          ]);
        }
        if (mode === "pre-quota" && options?.apiKey === boundary.credentials[0]?.access) {
          return eventStream([
            start(),
            {
              type: "error",
              reason: "error",
              error: message("error", `usage limit reached ${boundary.providerPayload}`),
            },
          ]);
        }
        if (mode === "post-quota") {
          return eventStream([
            start(),
            { type: "text_start", contentIndex: 0, partial: message() },
            {
              type: "error",
              reason: "error",
              error: message(
                "error",
                `usage limit reached ${boundary.providerPayload} ${boundary.authorizationHeader}`,
              ),
            },
          ]);
        }
        if (mode === "thrown") {
          throw Object.assign(
            new Error(`provider request failed ${boundary.providerPayload} ${boundary.cookie}`),
            {
              body: boundary.providerPayload,
              headers: {
                authorization: boundary.authorizationHeader,
                cookie: boundary.cookie,
              },
            },
          );
        }
        return eventStream(successfulText());
      },
    });
    const managedIds = await Promise.all([
      controller.vault.addFromOAuth("secret-check-a", boundary.credentials[0]),
      controller.vault.addFromOAuth("secret-check-b", boundary.credentials[1]),
    ]);
    const captured: unknown[] = [await collect(controller.routedStream(model, boundary.context))];

    mode = "auth-retry";
    modeCalls = 0;
    captured.push(await collect(controller.routedStream(model, boundary.context)));

    mode = "auth-exhausted";
    modeCalls = 0;
    const exhaustedAuthEvents = await collect(controller.routedStream(model, boundary.context));
    expect(terminalErrorMessage(exhaustedAuthEvents)).toBe(
      "No Codex account completed the request",
    );
    captured.push(exhaustedAuthEvents);
    captured.push(await controller.operations.reset("cooldowns"));

    mode = "pre-quota";
    modeCalls = 0;
    const preQuotaEvents = await collect(controller.routedStream(model, boundary.context));
    expect(preQuotaEvents.at(-1)?.type).toBe("done");
    captured.push(preQuotaEvents);
    captured.push(await controller.operations.reset("cooldowns"));

    mode = "post-quota";
    modeCalls = 0;
    const postQuotaEvents = await collect(controller.routedStream(model, boundary.context));
    expect(terminalErrorMessage(postQuotaEvents)).toBe("No Codex account completed the request");
    captured.push(postQuotaEvents);
    captured.push(await controller.operations.reset("cooldowns"));

    mode = "thrown";
    modeCalls = 0;
    const thrownEvents = await collect(controller.routedStream(model, boundary.context));
    expect(terminalErrorMessage(thrownEvents)).toBe("No Codex account completed the request");
    captured.push(thrownEvents);

    mode = "hold";
    const cancelled = new AbortController();
    const cancelEntered = new Promise<void>((resolve) => {
      streamEntered = resolve;
    });
    const cancelledResult = collect(
      controller.routedStream(model, boundary.context, { signal: cancelled.signal }),
    );
    await cancelEntered;
    cancelled.abort(new Error(`cancelled ${boundary.cookie}`));
    const cancelledEvents = await cancelledResult;
    expect(terminalErrorMessage(cancelledEvents)).toBe("The Codex request was cancelled");
    captured.push(cancelledEvents);

    captured.push(await controller.operations.use(managedIds[0] ?? "missing"));
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await stateStore.update((state) => ({
      ...state,
      reservations: [
        ...state.reservations,
        {
          accountId: managedIds[0] ?? "missing",
          leaseToken: "synthetic-primer-boundary",
          owner: { processId: 7, sessionId: "primer-session", requestId: "primer-request" },
          createdAt: NOW,
          expiresAt: NOW + 60_000,
          kind: "primer",
        },
      ],
    }));
    const primerAbort = new AbortController();
    const primerResult = collect(
      controller.routedStream(model, boundary.context, { signal: primerAbort.signal }),
    );
    setTimeout(
      () => primerAbort.abort(new Error(`primer cancelled ${boundary.providerPayload}`)),
      5,
    );
    const primerEvents = await primerResult;
    expect(terminalErrorMessage(primerEvents)).toBe("The Codex request was cancelled");
    captured.push(primerEvents);
    captured.push(await controller.operations.reset("reservations"));
    captured.push(await controller.operations.use("auto"));

    mode = "hold";
    const renewalEntered = new Promise<void>((resolve) => {
      streamEntered = resolve;
    });
    const renewalResult = collect(controller.routedStream(model, boundary.context));
    await renewalEntered;
    await stateStore.update((state) => ({
      ...state,
      reservations: state.reservations.filter((reservation) => reservation.kind !== "foreground"),
    }));
    const renewalEvents = await renewalResult;
    expect(terminalErrorMessage(renewalEvents)).toBe(
      "The Codex account reservation could not be renewed",
    );
    captured.push(renewalEvents);

    await stateStore.update((state) => ({
      ...state,
      reservations: [
        {
          accountId: "local-managed-account",
          leaseToken: "local-boundary-lease",
          owner: {
            processId: process.pid,
            sessionId: boundary.ownerSession,
            requestId: boundary.ownerRequest,
          },
          createdAt: NOW,
          expiresAt: NOW + 60_000,
          kind: "foreground",
        },
      ],
    }));
    captured.push(
      await controller.operations.status(),
      await controller.operations.accounts(),
      await controller.operations.policy(),
      await controller.operations.verify(),
    );
    await controller.shutdown();

    const accountsText = await readFile(paths.accounts, "utf8");
    expect(boundary.credentialMarkers.every((marker) => accountsText.includes(marker))).toBeTrue();
    expect(boundary.transientMarkers.every((marker) => !accountsText.includes(marker))).toBeTrue();
    const stateText = await readFile(paths.state, "utf8");
    expect(stateText.includes(boundary.ownerSession)).toBeTrue();
    expect(stateText.includes(boundary.ownerRequest)).toBeTrue();
    const capturedText = JSON.stringify(captured);
    expect(boundary.allMarkers.every((marker) => !capturedText.includes(marker))).toBeTrue();
    expect(capturedText.includes(boundary.ownerSession)).toBeFalse();
    expect(capturedText.includes(boundary.ownerRequest)).toBeFalse();
    for (const relative of await readdir(paths.directory, { recursive: true })) {
      const path = join(paths.directory, relative);
      if (path === paths.accounts || !relative.includes(".")) continue;
      const content = await readFile(path, "utf8").catch(() => "");
      expect(boundary.allMarkers.every((marker) => !content.includes(marker))).toBeTrue();
      if (path !== paths.state) {
        expect(content.includes(boundary.ownerSession)).toBeFalse();
        expect(content.includes(boundary.ownerRequest)).toBeFalse();
      }
    }
  });
});

async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("worker stdout ended before a complete line");
    buffered += decoder.decode(value, { stream: true });
    const newline = buffered.indexOf("\n");
    if (newline >= 0) return buffered.slice(0, newline);
  }
}

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

function terminalErrorMessage(events: AssistantMessageEvent[]): string | undefined {
  const terminal = events.at(-1);
  expect(terminal?.type).toBe("error");
  return terminal?.type === "error" ? terminal.error.errorMessage : undefined;
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
      recordSuccess: () => undefined,
      release: async () => undefined,
      renew: async () => true,
      recoveryDeadline: () => NOW + defaultConfig.maxRecoveryWaitMs,
      waitForRecovery: async () => undefined,
      maxAttempts: () => defaultConfig.maxRotationAttempts,
    },
  };
}

function syntheticBoundaryFixture() {
  const marker = (kind: string) => `synthetic-${kind}-${"z".repeat(36)}`;
  const rawIdentities = [marker("provider-identity-a"), marker("provider-identity-b")] as const;
  const accessCredentials = [
    makeCredentials(rawIdentities[0], NOW + 3_600_000, marker("access-a")),
    makeCredentials(rawIdentities[1], NOW + 3_600_000, marker("access-b")),
  ] as const;
  const refreshToken = `refresh_${marker("refresh")}`;
  const jwt = [marker("jwt-header"), marker("jwt-payload"), marker("jwt-signature")].join(".");
  const authorizationHeader = `Bearer ${marker("authorization")}`;
  const prompt = marker("prompt");
  const providerPayload = marker("payload-body");
  const cookie = `session=${marker("cookie")}`;
  const credentialMarkers = [
    ...accessCredentials.map((credential) => credential.access),
    refreshToken,
    jwt,
    ...rawIdentities,
  ];
  const transientMarkers = [authorizationHeader, prompt, providerPayload, cookie];
  return {
    credentials: [
      {
        ...accessCredentials[0],
        refresh: [refreshToken, jwt, rawIdentities[0]].join("|"),
      },
      {
        ...accessCredentials[1],
        refresh: [refreshToken, jwt, rawIdentities[1]].join("|"),
      },
    ] as const,
    context: {
      messages: [
        {
          role: "user",
          content: `${prompt}\n${authorizationHeader}\n${cookie}`,
          timestamp: NOW,
        },
      ],
    } as unknown as Context,
    credentialMarkers,
    transientMarkers,
    allMarkers: [...credentialMarkers, ...transientMarkers],
    authorizationHeader,
    providerPayload,
    cookie,
    ownerSession: marker("owner-session"),
    ownerRequest: marker("owner-request"),
  };
}
