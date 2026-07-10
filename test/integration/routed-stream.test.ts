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
  const value: RoutedStreamDependencies = {
    selectAndReserve: async ({ excludedAccountIds }) => {
      const accountId = accounts.find((account) => !excludedAccountIds.has(account));
      if (!accountId) {
        return undefined;
      }
      selected.push(accountId);
      return { accountId, leaseToken: `lease-${accountId}` };
    },
    getFreshCredential: async (accountId) => ({
      accountId: `raw-${accountId}`,
      accessToken: `token-${accountId}`,
      expiresAt: 3_000_000_000_000,
    }),
    baseStream,
    classifyFailure: (error) => classifyFailure(error, 2_000_000_000_000),
    recordFailure: async (accountId) => {
      recorded.push(accountId);
    },
    release: async (leaseToken) => {
      released.push(leaseToken);
    },
    waitForRecovery: async () => undefined,
    maxAttempts: 5,
  };
  return { value, selected, released, recorded };
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
    expect(setup.recorded).toEqual([]);
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
