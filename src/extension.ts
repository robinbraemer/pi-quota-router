import { streamSimple as codexStreamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codexOAuthClient } from "./accounts/oauth-client.ts";
import { registerQuotaRouterProvider } from "./provider.ts";
import { createRouterController, type RouterController } from "./router-controller.ts";
import { resolveRouterPaths } from "./storage/paths.ts";

type ControllerFactory = () => Promise<RouterController>;

export function createExtension(
  controllerFactory: ControllerFactory = () =>
    createRouterController({
      paths: resolveRouterPaths(),
      oauth: codexOAuthClient,
      baseStream: codexStreamSimple,
    }),
) {
  return async (pi: ExtensionAPI): Promise<void> => {
    const controller = await controllerFactory();
    registerQuotaRouterProvider(pi, controller);
    pi.on("agent_start", () => {
      controller.setForegroundActive(true);
    });
    pi.on("agent_settled", () => {
      controller.setForegroundActive(false);
      controller.schedulePriming();
    });
    pi.on("session_shutdown", async () => {
      await controller.shutdown();
    });
  };
}

export default createExtension();
