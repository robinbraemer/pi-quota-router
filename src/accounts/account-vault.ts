import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import lockfile from "proper-lockfile";
import type { AtomicJsonStore } from "../storage/atomic-json-store.ts";
import type { AccountVaultFile } from "../storage/schemas.ts";
import {
  deriveManagedAccountId,
  extractCodexAccountId,
  normalizeAccountLabel,
} from "./account-identity.ts";

const REFRESH_EARLY_MS = 300_000;
const REFRESH_LOCK_TIMEOUT_MS = 5_000;

export interface CodexOAuthClient {
  refresh(refreshToken: string): Promise<OAuthCredentials>;
}

export interface ManagedCodexAccountSummary {
  id: string;
  label: string;
  expiresAt: number;
  needsReauth: boolean;
}

export interface FreshCredential {
  accountId: string;
  accessToken: string;
  expiresAt: number;
}

export type AuthInvalidationReason = "invalid_grant" | "revoked" | "identity_mismatch";

export interface AccountVault {
  list(): Promise<ReadonlyArray<ManagedCodexAccountSummary>>;
  addFromOAuth(label: string, credentials: OAuthCredentials): Promise<string>;
  getFreshCredential(id: string, signal?: AbortSignal): Promise<FreshCredential>;
  forceRefreshCredential(
    id: string,
    rejectedAccessToken: string,
    signal?: AbortSignal,
  ): Promise<FreshCredential>;
  remove(id: string): Promise<void>;
  rename(id: string, label: string): Promise<void>;
  markNeedsReauth(
    id: string,
    rejectedAccessToken: string,
    reason: AuthInvalidationReason,
  ): Promise<boolean>;
}

export class AccountNeedsReauthError extends Error {
  override readonly name = "AccountNeedsReauthError";

  constructor() {
    super("This Codex account must be authenticated again");
  }
}

export class TokenRefreshTransientError extends Error {
  override readonly name = "TokenRefreshTransientError";

  constructor() {
    super("Codex token refresh failed temporarily");
  }
}

export class AccountNotFoundError extends Error {
  override readonly name = "AccountNotFoundError";

  constructor(id: string) {
    super(`No managed Codex account exists for ${id}`);
  }
}

export interface AccountVaultOptions {
  store: AtomicJsonStore<AccountVaultFile>;
  oauth: CodexOAuthClient;
  clock: () => number;
  refreshLockDirectory: string;
}

export function createAccountVault(options: AccountVaultOptions): AccountVault {
  const refreshes = new Map<string, Promise<FreshCredential>>();

  const findAccount = async (id: string) => {
    const file = await options.store.read();
    const account = file.accounts.find((candidate) => candidate.id === id);
    if (!account) {
      throw new AccountNotFoundError(id);
    }
    return account;
  };

  const toFreshCredential = (
    account: Awaited<ReturnType<typeof findAccount>>,
  ): FreshCredential => ({
    accountId: account.accountId,
    accessToken: account.accessToken,
    expiresAt: account.expiresAt,
  });

  const refreshAccount = async (
    id: string,
    rejectedAccessToken?: string,
  ): Promise<FreshCredential> =>
    withAccountRefreshLock(options, id, async () => {
      const account = await findAccount(id);
      if (account.needsReauth) {
        throw new AccountNeedsReauthError();
      }
      if (
        (rejectedAccessToken !== undefined && account.accessToken !== rejectedAccessToken) ||
        (rejectedAccessToken === undefined && !needsRefresh(account.expiresAt, options.clock()))
      ) {
        return toFreshCredential(account);
      }

      let credentials: OAuthCredentials;
      try {
        credentials = await options.oauth.refresh(account.refreshToken);
      } catch (error) {
        if (isDefinitiveAuthFailure(error)) {
          return invalidateRefreshSource(options.store, account);
        }
        throw new TokenRefreshTransientError();
      }

      let refreshedAccountId: string;
      try {
        refreshedAccountId = extractCodexAccountId(credentials.access);
      } catch {
        return invalidateRefreshSource(options.store, account);
      }
      if (refreshedAccountId !== account.accountId) {
        return invalidateRefreshSource(options.store, account);
      }
      if (
        typeof credentials.refresh !== "string" ||
        credentials.refresh.length === 0 ||
        !Number.isFinite(credentials.expires)
      ) {
        throw new TokenRefreshTransientError();
      }

      const updated = await options.store.update((file) => ({
        ...file,
        accounts: file.accounts.map((candidate) =>
          candidate.id === id && isSameCredentialSource(candidate, account)
            ? {
                ...candidate,
                accessToken: credentials.access,
                refreshToken: credentials.refresh,
                expiresAt: credentials.expires,
                updatedAt: options.clock(),
                needsReauth: false,
              }
            : candidate,
        ),
      }));
      const saved = updated.accounts.find((candidate) => candidate.id === id);
      if (!saved) {
        throw new AccountNotFoundError(id);
      }
      return toFreshCredential(saved);
    });

  const startRefresh = (id: string, rejectedAccessToken?: string): Promise<FreshCredential> => {
    const refresh = refreshAccount(id, rejectedAccessToken).finally(() => {
      if (refreshes.get(id) === refresh) {
        refreshes.delete(id);
      }
    });
    refreshes.set(id, refresh);
    return refresh;
  };

  return {
    async list() {
      const file = await options.store.read();
      return file.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        expiresAt: account.expiresAt,
        needsReauth: account.needsReauth ?? false,
      }));
    },

    async addFromOAuth(label, credentials) {
      const accountId = extractCodexAccountId(credentials.access);
      const id = deriveManagedAccountId(accountId);
      const now = options.clock();
      const normalizedLabel = normalizeAccountLabel(label, `Account ${id.slice(-6)}`);

      await options.store.update((file) => {
        const existing = file.accounts.find((account) => account.accountId === accountId);
        const next = {
          id,
          label: normalizedLabel,
          accountId,
          accessToken: credentials.access,
          refreshToken: credentials.refresh,
          expiresAt: credentials.expires,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          needsReauth: false,
        };
        return {
          ...file,
          accounts: existing
            ? file.accounts.map((account) => (account.accountId === accountId ? next : account))
            : [...file.accounts, next],
        };
      });
      return id;
    },

    async getFreshCredential(id, signal) {
      const account = await findAccount(id);
      if (account.needsReauth) {
        throw new AccountNeedsReauthError();
      }
      if (!needsRefresh(account.expiresAt, options.clock())) {
        return toFreshCredential(account);
      }

      const pending = refreshes.get(id);
      if (pending) {
        return awaitWithSignal(pending, signal);
      }
      return awaitWithSignal(startRefresh(id), signal);
    },

    async forceRefreshCredential(id, rejectedAccessToken, signal) {
      const pending = refreshes.get(id);
      if (pending) {
        const credential = await awaitWithSignal(pending, signal);
        if (credential.accessToken !== rejectedAccessToken) {
          return credential;
        }
      }
      return awaitWithSignal(startRefresh(id, rejectedAccessToken), signal);
    },

    async remove(id) {
      await options.store.update((file) => ({
        ...file,
        accounts: file.accounts.filter((account) => account.id !== id),
      }));
    },

    async rename(id, label) {
      const normalized = normalizeAccountLabel(label, `Account ${id.slice(-6)}`);
      await options.store.update((file) => {
        if (!file.accounts.some((account) => account.id === id)) {
          throw new AccountNotFoundError(id);
        }
        return {
          ...file,
          accounts: file.accounts.map((account) =>
            account.id === id
              ? { ...account, label: normalized, updatedAt: options.clock() }
              : account,
          ),
        };
      });
    },

    async markNeedsReauth(id, rejectedAccessToken) {
      return markNeedsReauth(options.store, id, rejectedAccessToken);
    },
  };
}

function needsRefresh(expiresAt: number, now: number): boolean {
  return expiresAt <= now + REFRESH_EARLY_MS;
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function markNeedsReauth(
  store: AtomicJsonStore<AccountVaultFile>,
  id: string,
  rejectedAccessToken: string,
): Promise<boolean> {
  const updated = await store.update((file) => ({
    ...file,
    accounts: file.accounts.map((account) =>
      account.id === id && account.accessToken === rejectedAccessToken
        ? { ...account, needsReauth: true }
        : account,
    ),
  }));
  return updated.accounts.some(
    (account) =>
      account.id === id && account.accessToken === rejectedAccessToken && account.needsReauth,
  );
}

async function invalidateRefreshSource(
  store: AtomicJsonStore<AccountVaultFile>,
  source: AccountVaultFile["accounts"][number],
): Promise<FreshCredential> {
  const updated = await store.update((file) => ({
    ...file,
    accounts: file.accounts.map((account) =>
      account.id === source.id && isSameCredentialSource(account, source)
        ? { ...account, needsReauth: true }
        : account,
    ),
  }));
  const current = updated.accounts.find((account) => account.id === source.id);
  if (!current) {
    throw new AccountNotFoundError(source.id);
  }
  if (!isSameCredentialSource(current, source)) {
    return {
      accountId: current.accountId,
      accessToken: current.accessToken,
      expiresAt: current.expiresAt,
    };
  }
  throw new AccountNeedsReauthError();
}

function isSameCredentialSource(
  current: AccountVaultFile["accounts"][number],
  source: AccountVaultFile["accounts"][number],
): boolean {
  return (
    current.accountId === source.accountId &&
    current.accessToken === source.accessToken &&
    current.refreshToken === source.refreshToken
  );
}

async function withAccountRefreshLock<T>(
  options: AccountVaultOptions,
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(options.refreshLockDirectory, { recursive: true, mode: 0o700 });
  await chmod(options.refreshLockDirectory, 0o700);
  const target = join(options.refreshLockDirectory, `.${id}.refresh-lock-target`);
  const handle = await open(target, "a", 0o600);
  await handle.close();
  await chmod(target, 0o600);

  const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      const release = await lockfile.lock(target, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
      });
      try {
        return await operation();
      } finally {
        await release();
      }
    } catch (error) {
      if (!isLockContention(error)) {
        throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(10, remaining));
    }
  }
  throw new TokenRefreshTransientError();
}

function isDefinitiveAuthFailure(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code).toLowerCase()
      : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    code === "invalid_grant" ||
    code === "token_revoked" ||
    message.includes("invalid_grant") ||
    message.includes("refresh token was revoked")
  );
}

function isLockContention(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOCKED";
}
