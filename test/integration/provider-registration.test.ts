import { describe, expect, test } from "bun:test";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { type ProviderController, registerQuotaRouterProvider } from "../../src/provider.ts";
import { captureProviderRegistration } from "../fixtures/pi-api.ts";

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("normal Pi provider registration", () => {
  test("overrides only openai-codex and preserves all built-in model metadata", () => {
    const { pi, registrations } = captureProviderRegistration();
    const controller = {
      bootstrapApiKey: "pending-login",
      routedStream: () => {
        throw new Error("unused");
      },
    } as ProviderController;
    registerQuotaRouterProvider(pi, controller);

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.name).toBe("openai-codex");
    expect(registrations[0]?.config.apiKey).toBe("pending-login");
    const registered = registrations[0]?.config.models as Array<Record<string, unknown>>;
    expect(registered.map((model) => model.id)).toEqual(Object.keys(OPENAI_CODEX_MODELS));
    for (const model of registered) {
      const source = OPENAI_CODEX_MODELS[model.id as keyof typeof OPENAI_CODEX_MODELS];
      expect(model).toEqual(
        expect.objectContaining({
          id: source.id,
          name: source.name,
          reasoning: source.reasoning,
          input: source.input,
          cost: source.cost,
          contextWindow: source.contextWindow,
          maxTokens: source.maxTokens,
          thinkingLevelMap: source.thinkingLevelMap,
        }),
      );
    }
  });

  test("never sends the pending-login sentinel to the Codex backend", async () => {
    const { pi, registrations } = captureProviderRegistration();
    let baseCalls = 0;
    const controller: ProviderController = {
      bootstrapApiKey: "pending-login",
      routedStream: (_model) => {
        baseCalls += 1;
        throw new Error("backend must not be called");
      },
      assertReady: async () => {
        throw new Error("Run /quota-router login before using Codex");
      },
    };
    registerQuotaRouterProvider(pi, controller);
    const stream = registrations[0]?.config.streamSimple as ProviderController["routedStream"];
    const model = Object.values(OPENAI_CODEX_MODELS)[0] as Model<"openai-codex-responses">;
    const events = await collect(stream(model, { messages: [] } as Context));

    expect(baseCalls).toBe(0);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          errorMessage: expect.stringContaining("/quota-router login"),
        }),
      }),
    );
  });
});
