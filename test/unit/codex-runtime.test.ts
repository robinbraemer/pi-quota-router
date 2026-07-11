import { expect, test } from "bun:test";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { closeCodexWebSocketSessions } from "../../src/codex-runtime.ts";

test("exports Pi's public Codex WebSocket closer without wrapping credentials or session ids", () => {
  expect(closeCodexWebSocketSessions).toBe(closeOpenAICodexWebSocketSessions);
});
