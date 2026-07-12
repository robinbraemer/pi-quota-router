import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { classifyFailure } from "../../src/recovery/failure-classifier.ts";
import {
  createRoutedStream,
  type RoutedStreamDependencies,
} from "../../src/stream/routed-stream.ts";
import {
  eventStream,
  message,
  quotaError,
  start,
  successfulText,
} from "../fixtures/provider-streams.ts";

const model = {
  id: "gpt-test",
  provider: "openai-codex",
  api: "openai-codex-responses",
} as Model<"openai-codex-responses">;
const context = { messages: [] } as Context;

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function dependencies(accounts: string[], baseStream: RoutedStreamDependencies["baseStream"]) {
  const selected: string[] = [];
  const released: string[] = [];
  const recorded: string[] = [];
  const succeeded: Array<[string, string | undefined]> = [];
  const renewed: string[] = [];
  const value: RoutedStreamDependencies = {
    selectAndReserve: async ({ excludedAccountIds }) => {
      const accountId = accounts.find((account) => !excludedAccountIds.has(account));
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
        lease: { accountId, leaseToken: `lease-${accountId}`, reservationTtlMs: 120_000 },
      };
    },
    getFreshCredential: async (accountId) => ({
      accountId: `raw-${accountId}`,
      accessToken: `token-${accountId}`,
      expiresAt: 3_000_000_000_000,
    }),
    forceRefreshCredential: async (accountId) => ({
      accountId: `raw-${accountId}`,
      accessToken: `refreshed-${accountId}`,
      expiresAt: 3_000_000_000_000,
    }),
    baseStream,
    classifyFailure: (error) => classifyFailure(error, 2_000_000_000_000),
    recordFailure: async (accountId) => {
      recorded.push(accountId);
    },
    recordSuccess: (accountId, sessionId?: string) => {
      succeeded.push([accountId, sessionId]);
    },
    release: async (leaseToken) => {
      released.push(leaseToken);
    },
    renew: async (leaseToken) => {
      renewed.push(leaseToken);
      return true;
    },
    maxAttempts: () => 5,
  };
  return { value, selected, released, recorded, renewed, succeeded };
}

describe("RoutedStream", () => {
  test("rotates a pre-output quota failure and forwards one coherent stream", async () => {
    const optionsSeen: SimpleStreamOptions[] = [];
    const setup = dependencies(["a", "b"], (_model, _context, options) => {
      optionsSeen.push(options ?? {});
      return options?.apiKey === "token-a"
        ? eventStream([start(), quotaError()])
        : eventStream(successfulText());
    });
    const routed = createRoutedStream(setup.value);

    const events = await collect(
      routed(model, context, { reasoning: "high", sessionId: "  session-1  " }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(setup.selected).toEqual(["a", "b"]);
    expect(setup.released.sort()).toEqual(["lease-a", "lease-b"]);
    expect(setup.recorded).toEqual(["a"]);
    expect(setup.succeeded).toEqual([["b", "  session-1  "]]);
    expect(optionsSeen[1]).toEqual(
      expect.objectContaining({
        apiKey: "token-b",
        reasoning: "high",
        sessionId: "  session-1  ",
      }),
    );
  });

  test("never rotates after visible model output begins", async () => {
    const setup = dependencies(["a", "b"], () =>
      eventStream([
        start(),
        { type: "text_start", contentIndex: 0, partial: message() },
        quotaError(),
      ]),
    );
    const events = await collect(createRoutedStream(setup.value)(model, context));

    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "error"]);
    expect(setup.selected).toEqual(["a"]);
    expect(setup.recorded).toEqual(["a"]);
    expect(setup.succeeded).toEqual([]);
  });

  test("preserves safe terminal content and usage while sanitizing provider diagnostics", async () => {
    const secret = "secret-provider-diagnostic";
    const terminal: AssistantMessage & { rawIdentity: string } = {
      ...message("error", `usage limit reached ${secret}`),
      content: [{ type: "text", text: "partial answer" }],
      responseId: secret,
      diagnostics: [
        {
          type: "provider-error",
          timestamp: 2,
          details: { body: secret, authorization: `Bearer ${secret}` },
        },
      ],
      usage: {
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 3,
        cacheWrite1h: 2,
        reasoning: 4,
        totalTokens: 26,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
      rawIdentity: secret,
    };
    const setup = dependencies(["a", "b"], () =>
      eventStream([
        start(),
        { type: "text_start", contentIndex: 0, partial: message() },
        { type: "error", reason: "error", error: terminal },
      ]),
    );

    const events = await collect(createRoutedStream(setup.value)(model, context));
    const error = events.at(-1);

    expect(error?.type).toBe("error");
    if (error?.type !== "error") throw new Error("expected a terminal error event");
    expect(error.error.content).toEqual(terminal.content);
    expect(error.error.usage).toEqual(terminal.usage);
    expect(error.error.errorMessage).toBe("No Codex account completed the request");
    expect(error.error.stopReason).toBe("error");
    expect(error.error.responseId).toBeUndefined();
    expect(error.error.diagnostics).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(setup.selected).toEqual(["a"]);
  });

  test("never rotates when an iterator throws after visible output", async () => {
    const setup = dependencies(["a", "b"], (() => {
      const stream = (async function* () {
        yield start();
        yield { type: "text_start", contentIndex: 0, partial: message() } as AssistantMessageEvent;
        throw new Error("usage limit reached");
      })();
      return stream;
    }) as unknown as RoutedStreamDependencies["baseStream"]);

    const events = await collect(createRoutedStream(setup.value)(model, context));

    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "error"]);
    expect(setup.selected).toEqual(["a"]);
    expect(setup.recorded).toEqual(["a"]);
    expect(setup.succeeded).toEqual([]);
  });

  test("does not record success for an aborted request", async () => {
    const setup = dependencies(["a"], () => eventStream(successfulText()));
    const controller = new AbortController();
    controller.abort(new Error("synthetic cancellation"));

    const events = await collect(
      createRoutedStream(setup.value)(model, context, {
        signal: controller.signal,
        sessionId: "cancelled-session",
      }),
    );

    expect(events.at(-1)?.type).toBe("error");
    expect(setup.succeeded).toEqual([]);
  });

  test("does not record success when the provider iterator ends without done", async () => {
    const setup = dependencies(["a"], (() =>
      (async function* () {
        yield start();
      })()) as unknown as RoutedStreamDependencies["baseStream"]);

    const events = await collect(
      createRoutedStream(setup.value)(model, context, { sessionId: "unterminated-session" }),
    );

    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(setup.succeeded).toEqual([]);
  });

  test("force refreshes the first generic 401 and retries the same account", async () => {
    const keys: string[] = [];
    const setup = dependencies(["a", "b"], (_model, _context, options) => {
      keys.push(options?.apiKey ?? "");
      return options?.apiKey === "token-a"
        ? eventStream([
            start(),
            { type: "error", reason: "error", error: message("error", "unauthorized") },
          ])
        : eventStream(successfulText());
    });
    setup.value.classifyFailure = (error) =>
      error instanceof Object && "errorMessage" in error
        ? { kind: "auth-retry" }
        : classifyFailure(error, 2_000_000_000_000);

    const events = await collect(createRoutedStream(setup.value)(model, context));

    expect(events.at(-1)?.type).toBe("done");
    expect(setup.selected).toEqual(["a"]);
    expect(keys).toEqual(["token-a", "refreshed-a"]);
    expect(setup.recorded).toEqual([]);
  });

  test("retries concurrent generic 401 requests under their unchanged distinct leases", async () => {
    const keys = new Map<string, string[]>();
    const setup = dependencies(["a"], (_model, _context, options) => {
      const sessionId = options?.sessionId ?? "";
      keys.set(sessionId, [...(keys.get(sessionId) ?? []), options?.apiKey ?? ""]);
      return options?.apiKey === "token-a"
        ? eventStream([
            start(),
            { type: "error", reason: "error", error: message("error", "unauthorized") },
          ])
        : eventStream(successfulText());
    });
    const selections = new Map<string, number>();
    setup.value.selectAndReserve = async ({ options }) => {
      const sessionId = options?.sessionId ?? "";
      selections.set(sessionId, (selections.get(sessionId) ?? 0) + 1);
      return {
        kind: "selected",
        lease: {
          accountId: "a",
          leaseToken: `lease-${sessionId}`,
          reservationTtlMs: 120_000,
        },
      };
    };
    setup.value.classifyFailure = (error) =>
      error instanceof Object && "errorMessage" in error
        ? { kind: "auth-retry" }
        : classifyFailure(error, 2_000_000_000_000);
    const routed = createRoutedStream(setup.value);

    const results = await Promise.all([
      collect(routed(model, context, { sessionId: "one" })),
      collect(routed(model, context, { sessionId: "two" })),
    ]);

    expect(results.every((events) => events.at(-1)?.type === "done")).toBeTrue();
    expect(Object.fromEntries(selections)).toEqual({ one: 1, two: 1 });
    expect(keys.get("one")).toEqual(["token-a", "refreshed-a"]);
    expect(keys.get("two")).toEqual(["token-a", "refreshed-a"]);
    expect(setup.released.sort()).toEqual(["lease-one", "lease-two"]);
    expect(setup.recorded).toEqual([]);
  });

  test("records a recoverable failure on the final attempt", async () => {
    const setup = dependencies(["a"], () => eventStream([start(), quotaError()]));
    setup.value.maxAttempts = () => 1;

    await collect(createRoutedStream(setup.value)(model, context));

    expect(setup.recorded).toEqual(["a"]);
  });

  test("fails immediately when every account is temporarily unavailable", async () => {
    const setup = dependencies(["a"], () => eventStream(successfulText()));
    setup.value.selectAndReserve = async () => ({
      kind: "unavailable",
      reason: "no_eligible_accounts",
      recoverableAccountIds: ["a"],
      knownAccountIds: ["a"],
    });

    const events = await collect(createRoutedStream(setup.value)(model, context));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].error.errorMessage).toBe(
        "No Codex account is currently eligible; quota, usage data, or account health must recover before retrying",
      );
    }
  });

  test("reports an unavailable manual account distinctly", async () => {
    const setup = dependencies([], () => eventStream(successfulText()));
    setup.value.selectAndReserve = async () => ({
      kind: "unavailable",
      reason: "manual_account_unavailable",
      recoverableAccountIds: [],
      knownAccountIds: ["a"],
    });

    const events = await collect(createRoutedStream(setup.value)(model, context));
    const terminal = events[0];

    expect(terminal?.type).toBe("error");
    if (terminal?.type === "error") {
      expect(terminal.error.errorMessage).toBe(
        "The selected Codex account is currently unavailable",
      );
    }
  });

  test("renews a lease while a request remains active", async () => {
    const setup = dependencies(["a"], (() => {
      const stream = (async function* () {
        yield start();
        await Bun.sleep(30);
        for (const event of successfulText().slice(1)) {
          yield event;
        }
      })();
      return stream;
    }) as unknown as RoutedStreamDependencies["baseStream"]);
    setup.value.selectAndReserve = async () => ({
      kind: "selected",
      lease: { accountId: "a", leaseToken: "lease-a", reservationTtlMs: 15 },
    });

    const events = await collect(createRoutedStream(setup.value)(model, context));

    expect(events.at(-1)?.type).toBe("done");
    expect(setup.renewed.length).toBeGreaterThan(0);
  });

  test("isolates renewal loss to the affected lease token", async () => {
    let finishPeer: (() => void) | undefined;
    const peerHeld = new Promise<void>((resolve) => {
      finishPeer = resolve;
    });
    const baseStream = ((
      _model: Model<"openai-codex-responses">,
      _context: Context,
      options?: SimpleStreamOptions,
    ) =>
      (async function* () {
        yield start();
        if (options?.sessionId === "peer") {
          await peerHeld;
        } else {
          const signal = options?.signal;
          if (!signal) throw new Error("renewal-loss fixture requires a heartbeat signal");
          signal.throwIfAborted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        }
        for (const event of successfulText().slice(1)) yield event;
      })()) as unknown as RoutedStreamDependencies["baseStream"];
    const setup = dependencies(["a"], baseStream);
    setup.value.selectAndReserve = async ({ options }) => ({
      kind: "selected",
      lease: {
        accountId: "a",
        leaseToken: options?.sessionId === "lost" ? "lost-token" : "peer-token",
        reservationTtlMs: 15,
      },
    });
    setup.value.renew = async (leaseToken) => leaseToken !== "lost-token";
    const routed = createRoutedStream(setup.value);

    const lostPromise = collect(routed(model, context, { sessionId: "lost" }));
    const peerPromise = collect(routed(model, context, { sessionId: "peer" }));
    try {
      const lost = await lostPromise;

      const lostLast = lost.at(-1);
      expect(lostLast?.type).toBe("error");
      if (lostLast?.type !== "error") throw new Error("expected renewal loss error event");
      expect(lost.filter((event) => event.type === "error")).toHaveLength(1);
      expect(lostLast.error.errorMessage).toBe(
        "The Codex account reservation could not be renewed",
      );
      expect(setup.released).toEqual(["lost-token"]);
      expect(setup.recorded).toEqual([]);
      expect(setup.succeeded).toEqual([]);

      finishPeer?.();
      const peer = await peerPromise;
      expect(peer.at(-1)?.type).toBe("done");
      expect(setup.released.sort()).toEqual(["lost-token", "peer-token"]);
      expect(setup.succeeded).toEqual([["a", "peer"]]);
    } finally {
      finishPeer?.();
      await Promise.allSettled([lostPromise, peerPromise]);
    }
  });

  test("enforces the maximum rotation attempt count", async () => {
    const setup = dependencies(["a", "b", "c", "d", "e", "f"], () =>
      eventStream([start(), quotaError()]),
    );
    const events = await collect(createRoutedStream(setup.value)(model, context));

    expect(setup.selected).toHaveLength(5);
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
  });
});
