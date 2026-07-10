import { createHash } from "node:crypto";

const CLAIM_PATH = "https://api.openai.com/auth";
const MAX_LABEL_CODE_POINTS = 80;

export class InvalidCodexTokenError extends Error {
  override readonly name = "InvalidCodexTokenError";

  constructor() {
    super("The Codex access token does not contain a usable account identity");
  }
}

export function extractCodexAccountId(accessToken: string): string {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || parts[1] === undefined) {
      throw new Error("invalid token shape");
    }
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (typeof payload !== "object" || payload === null || !(CLAIM_PATH in payload)) {
      throw new Error("missing auth claim");
    }
    const auth = payload[CLAIM_PATH as keyof typeof payload];
    if (
      typeof auth !== "object" ||
      auth === null ||
      !("chatgpt_account_id" in auth) ||
      typeof auth.chatgpt_account_id !== "string" ||
      auth.chatgpt_account_id.length === 0
    ) {
      throw new Error("missing account id");
    }
    return auth.chatgpt_account_id;
  } catch {
    throw new InvalidCodexTokenError();
  }
}

export function deriveManagedAccountId(accountId: string): string {
  const digest = createHash("sha256").update(accountId).digest("hex").slice(0, 12);
  return `codex-${digest}`;
}

export function normalizeAccountLabel(label: string, fallback: string): string {
  const printable = Array.from(label, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && codePoint !== 0x7f && codePoint <= 0x10ffff ? character : " ";
  })
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();
  const normalized = printable.length > 0 ? printable : fallback;
  return Array.from(normalized).slice(0, MAX_LABEL_CODE_POINTS).join("");
}
