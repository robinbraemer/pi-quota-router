import { type OAuthCredentials, refreshOpenAICodexToken } from "@earendil-works/pi-ai/oauth";
import type { CodexOAuthClient } from "./account-vault.ts";

export const codexOAuthClient: CodexOAuthClient = {
  refresh(refreshToken: string): Promise<OAuthCredentials> {
    return refreshOpenAICodexToken(refreshToken);
  },
};
