import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import {
  closeOpenAICodexWebSocketSessions,
  stream as streamOpenAICodexResponses,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { createAccountAffinityCoordinator } from "../../src/stream/account-affinity.ts";

interface SyntheticConnection {
  accountId: string;
  bodies: Array<{ prompt_cache_key?: string; previous_response_id?: string }>;
  closes: Array<{ code?: number; reason?: string }>;
}

type SyntheticListener = (event: unknown) => void;

const connections: SyntheticConnection[] = [];
const originalWebSocket = globalThis.WebSocket;

class SyntheticWebSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 0;
  private readonly listeners = new Map<string, Set<SyntheticListener>>();
  private readonly connection: SyntheticConnection;

  constructor(
    _url: string | URL,
    options?: string | string[] | { headers?: Record<string, string> },
  ) {
    const headers = typeof options === "object" && !Array.isArray(options) ? options.headers : {};
    const accountId = Object.entries(headers ?? {}).find(
      ([name]) => name.toLowerCase() === "chatgpt-account-id",
    )?.[1];
    if (!accountId) throw new Error("synthetic WebSocket requires an account header");
    this.connection = { accountId, bodies: [], closes: [] };
    connections.push(this.connection);
    queueMicrotask(() => {
      this.readyState = SyntheticWebSocket.OPEN;
      this.emit("open", { type: "open" });
    });
  }

  addEventListener(type: string, listener: SyntheticListener): void {
    const listeners = this.listeners.get(type) ?? new Set<SyntheticListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: SyntheticListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    const body = JSON.parse(data) as {
      prompt_cache_key?: string;
      previous_response_id?: string;
    };
    this.connection.bodies.push({
      ...(body.prompt_cache_key ? { prompt_cache_key: body.prompt_cache_key } : {}),
      ...(body.previous_response_id ? { previous_response_id: body.previous_response_id } : {}),
    });
    const sequence = this.connection.bodies.length;
    queueMicrotask(() => {
      this.emit("message", {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: `response-${this.connection.accountId}-${sequence}`,
            status: "completed",
            output: [],
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        }),
      });
    });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.connection.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason ? { reason } : {}),
    });
    this.readyState = 3;
    this.emit("close", { type: "close", code, reason, wasClean: true });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const syntheticModel: Model<"openai-codex-responses"> = {
  id: "synthetic-codex",
  name: "Synthetic Codex",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://synthetic.invalid/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

function syntheticToken(accountId: string, signature: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `synthetic.${payload}.${signature}`;
}

async function runSyntheticCodex(
  accountId: string,
  signature: string,
  sessionId: string,
  messages: AssistantMessage[],
): Promise<AssistantMessage> {
  const stream = streamOpenAICodexResponses(syntheticModel, { messages } as Context, {
    apiKey: syntheticToken(accountId, signature),
    sessionId,
    transport: "websocket-cached",
  });
  for await (const event of stream) {
    if (event.type === "done") return event.message;
    if (event.type === "error") throw new Error(event.error.errorMessage);
  }
  throw new Error("synthetic Codex stream ended without a terminal event");
}

beforeEach(() => {
  closeOpenAICodexWebSocketSessions();
  connections.length = 0;
  globalThis.WebSocket = SyntheticWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  globalThis.WebSocket = originalWebSocket;
});

test("keeps same-account continuation and retires it only on a routed account switch", async () => {
  const originalSessionId = "synthetic-original-session";
  const coordinator = createAccountAffinityCoordinator(closeOpenAICodexWebSocketSessions);

  const firstLease = await coordinator.acquire(originalSessionId);
  firstLease.beforeAttempt("codex-managed-a");
  const first = await runSyntheticCodex("account-a", "old-signature", originalSessionId, []);
  firstLease.release();

  const refreshLease = await coordinator.acquire(originalSessionId);
  refreshLease.beforeAttempt("codex-managed-a");
  await runSyntheticCodex("account-a", "new-signature", originalSessionId, [first]);
  refreshLease.release();

  expect(connections).toHaveLength(1);
  expect(connections[0]?.bodies[1]?.previous_response_id).toBe("response-account-a-1");

  const switchLease = await coordinator.acquire(originalSessionId);
  switchLease.beforeAttempt("codex-managed-b");
  await runSyntheticCodex("account-b", "signature-b", originalSessionId, []);
  switchLease.release();

  expect(connections).toHaveLength(2);
  expect(connections[0]?.closes).toContainEqual({ code: 1000, reason: "debug_close" });
  expect(connections[1]?.bodies[0]?.previous_response_id).toBeUndefined();
  expect(connections[1]?.bodies[0]?.prompt_cache_key).toBe(originalSessionId);
  expect(JSON.stringify(connections)).not.toContain("old-signature");
  expect(JSON.stringify(connections)).not.toContain("new-signature");
  coordinator.shutdown();
});

test("serializes one session abortably while distinct sessions remain concurrent", async () => {
  const coordinator = createAccountAffinityCoordinator(closeOpenAICodexWebSocketSessions);
  const owner = await coordinator.acquire("busy-session");
  owner.beforeAttempt("codex-managed-a");
  await runSyntheticCodex("account-a", "busy-signature", "busy-session", []);

  let switched = false;
  const queuedSwitch = coordinator.acquire("busy-session").then(async (lease) => {
    switched = true;
    lease.beforeAttempt("codex-managed-b");
    await runSyntheticCodex("account-b", "queued-signature", "busy-session", []);
    lease.release();
  });
  const abort = new AbortController();
  const cancelled = coordinator.acquire("busy-session", abort.signal);
  abort.abort(new Error("synthetic queued cancellation"));
  await expect(cancelled).rejects.toThrow("synthetic queued cancellation");

  const distinct = await coordinator.acquire("distinct-session");
  distinct.beforeAttempt("codex-managed-c");
  await runSyntheticCodex("account-c", "distinct-signature", "distinct-session", []);
  distinct.release();

  expect(switched).toBeFalse();
  expect(connections.find((connection) => connection.accountId === "account-a")?.closes).toEqual(
    [],
  );
  expect(connections.map((connection) => connection.accountId)).toEqual(["account-a", "account-c"]);

  owner.release();
  await queuedSwitch;
  expect(connections.map((connection) => connection.accountId)).toEqual([
    "account-a",
    "account-c",
    "account-b",
  ]);
  coordinator.shutdown();
});
