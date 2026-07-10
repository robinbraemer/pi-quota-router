import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

export function message(
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 1,
  };
}

export function eventStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) {
      stream.push(event);
    }
  });
  return stream;
}

export function start(): AssistantMessageEvent {
  return { type: "start", partial: message() };
}

export function quotaError(): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: message("error", "usage limit reached"),
  };
}

export function successfulText(): AssistantMessageEvent[] {
  const partial = message();
  return [
    start(),
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: "ok", partial },
    { type: "text_end", contentIndex: 0, content: "ok", partial },
    { type: "done", reason: "stop", message: partial },
  ];
}
