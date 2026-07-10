import { streamSimple as codexStreamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codexOAuthClient } from "./accounts/oauth-client.ts";
import { registerQuotaRouterCommands } from "./commands/commands.ts";
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
    registerQuotaRouterCommands(pi, controller.operations);
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.setStatus("quota-router", await controller.operations.status());
    });
    pi.on("agent_start", () => {
      controller.setForegroundActive(true);
    });
    pi.on("agent_settled", async (_event, ctx) => {
      controller.setForegroundActive(false);
      controller.schedulePriming();
      ctx.ui.setStatus("quota-router", await controller.operations.status());
    });
    pi.on("session_shutdown", async () => {
      await controller.shutdown();
    });
  };
}

export default createExtension();
