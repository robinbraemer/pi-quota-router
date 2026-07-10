import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";

const CLAIM_PATH = "https://api.openai.com/auth";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function makeAccessToken(accountId: string, suffix = "token"): string {
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({ [CLAIM_PATH]: { chatgpt_account_id: accountId }, suffix }),
    "signature",
  ].join(".");
}

export function makeCredentials(
  accountId: string,
  expires: number,
  suffix = "initial",
): OAuthCredentials {
  return {
    access: makeAccessToken(accountId, suffix),
    refresh: `refresh-${accountId}-${suffix}`,
    expires,
  };
}
