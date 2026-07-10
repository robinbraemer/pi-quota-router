import type { Model } from "@earendil-works/pi-ai";
import { getModels, streamSimpleOpenAICodexResponses } from "@earendil-works/pi-ai/compat";

export const codexModels = getModels("openai-codex") as Model<"openai-codex-responses">[];

export const codexModelsById = new Map(codexModels.map((model) => [model.id, model]));

export const codexStreamSimple = streamSimpleOpenAICodexResponses;
