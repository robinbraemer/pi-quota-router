import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codexModels } from "./codex-runtime.ts";

export interface ProviderController {
  bootstrapApiKey: string;
  routedStream: StreamFunction<"openai-codex-responses", SimpleStreamOptions>;
  assertReady?: () => Promise<void>;
}

export function registerQuotaRouterProvider(
  pi: ExtensionAPI,
  controller: ProviderController,
): void {
  const models = codexModels.map((source) => ({
    id: source.id,
    name: source.name,
    baseUrl: source.baseUrl,
    reasoning: source.reasoning,
    thinkingLevelMap: source.thinkingLevelMap,
    input: [...source.input],
    cost: source.cost,
    contextWindow: source.contextWindow,
    maxTokens: source.maxTokens,
  }));
  const stream = readyStream(controller);

  pi.registerProvider("openai-codex", {
    name: "OpenAI Codex (Quota Router)",
    api: "openai-codex-responses",
    apiKey: controller.bootstrapApiKey,
    baseUrl: "https://chatgpt.com/backend-api",
    models,
    streamSimple: (model, context, options) =>
      stream(model as Model<"openai-codex-responses">, context, options),
  });
}

function readyStream(
  controller: ProviderController,
): StreamFunction<"openai-codex-responses", SimpleStreamOptions> {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      await controller.assertReady?.();
      const source = controller.routedStream(model, context, options);
      for await (const event of source) {
        output.push(event);
      }
    })().catch((error) => {
      output.push(providerError(model, error));
    });
    return output;
  };
}

function providerError(
  model: Model<"openai-codex-responses">,
  error: unknown,
): Extract<AssistantMessageEvent, { type: "error" }> {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : "Codex routing is unavailable",
    timestamp: Date.now(),
  };
  return { type: "error", reason: "error", error: message };
}
