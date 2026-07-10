import type { FetchImplementation } from "../../src/usage/codex-usage.ts";

export function fakeCodexUsage(handler: (accountId: string) => unknown): FetchImplementation {
  return async (_input, init) => {
    const headers = new Headers(init?.headers);
    const accountId = headers.get("ChatGPT-Account-Id");
    if (!accountId) {
      return new Response("missing account", { status: 401 });
    }
    return Response.json(handler(accountId));
  };
}
