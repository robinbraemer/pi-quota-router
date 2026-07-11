import { describe, expect, test } from "bun:test";
import type {
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
  const succeeded: string[] = [];
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
    recordSuccess: (accountId) => {
      succeeded.push(accountId);
    },
    release: async (leaseToken) => {
      released.push(leaseToken);
    },
    renew: async (leaseToken) => {
      renewed.push(leaseToken);
      return true;
    },
    recoveryDeadline: () => 2_000_021_600_000,
    waitForRecovery: async () => undefined,
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
      routed(model, context, { reasoning: "high", sessionId: "session-1" }),
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
    expect(setup.succeeded).toEqual(["b"]);
    expect(optionsSeen[1]).toEqual(
      expect.objectContaining({
        apiKey: "token-b",
        reasoning: "high",
        sessionId: "session-1",
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

  test("records a recoverable failure on the final attempt", async () => {
    const setup = dependencies(["a"], () => eventStream([start(), quotaError()]));
    setup.value.maxAttempts = () => 1;

    await collect(createRoutedStream(setup.value)(model, context));

    expect(setup.recorded).toEqual(["a"]);
  });

  test("surfaces a non-recoverable selection decision without retrying", async () => {
    const setup = dependencies([], () => eventStream(successfulText()));
    let waits = 0;
    setup.value.waitForRecovery = async () => {
      waits += 1;
    };

    const events = await collect(createRoutedStream(setup.value)(model, context));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect(waits).toBe(0);
  });

  test("reuses one recovery deadline across every wait in a routed request", async () => {
    const setup = dependencies(["a"], () => eventStream(successfulText()));
    let selections = 0;
    let deadlines = 0;
    const waitDeadlines: number[] = [];
    setup.value.selectAndReserve = async () => {
      selections += 1;
      if (selections <= 2) {
        return {
          kind: "unavailable",
          reason: "blocked",
          recoverableAccountIds: ["a"],
          knownAccountIds: ["a"],
        };
      }
      return {
        kind: "selected",
        lease: { accountId: "a", leaseToken: "lease-a", reservationTtlMs: 120_000 },
      };
    };
    setup.value.recoveryDeadline = () => {
      deadlines += 1;
      return 2_000_021_600_000;
    };
    setup.value.waitForRecovery = async (_accountIds, _knownAccountIds, deadline) => {
      waitDeadlines.push(deadline);
    };

    const events = await collect(createRoutedStream(setup.value)(model, context));

    expect(events.at(-1)?.type).toBe("done");
    expect(deadlines).toBe(1);
    expect(waitDeadlines).toEqual([2_000_021_600_000, 2_000_021_600_000]);
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

  test("enforces the maximum rotation attempt count", async () => {
    const setup = dependencies(["a", "b", "c", "d", "e", "f"], () =>
      eventStream([start(), quotaError()]),
    );
    const events = await collect(createRoutedStream(setup.value)(model, context));

    expect(setup.selected).toHaveLength(5);
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
  });
});
