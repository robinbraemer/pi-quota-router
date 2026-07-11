import { describe, expect, test } from "bun:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { ReplayBoundary } from "../../src/stream/replay-boundary.ts";

function event(type: AssistantMessageEvent["type"]): AssistantMessageEvent {
  return { type } as AssistantMessageEvent;
}

describe("ReplayBoundary", () => {
  test("keeps transport start replay-safe", () => {
    const boundary = new ReplayBoundary();
    boundary.observe(event("start"));
    expect(boundary.isReplaySafe()).toBe(true);
  });

  for (const type of [
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
  ] as const) {
    test(`makes ${type} replay-unsafe`, () => {
      const boundary = new ReplayBoundary();
      boundary.observe(event(type));
      expect(boundary.isReplaySafe()).toBe(false);
    });
  }
});
