import { afterEach, describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import {
  AccountNeedsReauthError,
  type CodexOAuthClient,
  createAccountVault,
  TokenRefreshTransientError,
} from "../../src/accounts/account-vault.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import { type AccountVaultFile, AccountVaultFileSchema } from "../../src/storage/schemas.ts";
import { makeCredentials } from "../fixtures/oauth.ts";
import { createStorageFixture } from "../fixtures/storage.ts";

const NOW = 2_000_000_000_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup(oauth: CodexOAuthClient) {
  const fixture = await createStorageFixture();
  cleanups.push(fixture.cleanup);
  const createStore = () =>
    createAtomicJsonStore<AccountVaultFile>({
      path: fixture.file,
      schema: AccountVaultFileSchema,
      createDefault: () => ({ version: 1, accounts: [] }),
    });
  const createVault = () =>
    createAccountVault({
      store: createStore(),
      oauth,
      clock: () => NOW,
      refreshLockDirectory: dirname(fixture.file),
    });
  return { createVault };
}

describe("AccountVault", () => {
  test("deduplicates logins by Codex account id", async () => {
    const { createVault } = await setup({
      refresh: async () => makeCredentials("account-1", NOW + 3_600_000, "refreshed"),
    });
    const vault = createVault();

    const firstId = await vault.addFromOAuth(
      "first",
      makeCredentials("account-1", NOW + 3_600_000, "first"),
    );
    const secondId = await vault.addFromOAuth(
      "updated",
      makeCredentials("account-1", NOW + 3_600_000, "second"),
    );

    expect(secondId).toBe(firstId);
    expect(await vault.list()).toEqual([
      expect.objectContaining({ id: firstId, label: "updated" }),
    ]);
    expect((await vault.getFreshCredential(firstId)).accessToken).toBe(
      makeCredentials("account-1", NOW + 3_600_000, "second").access,
    );
  });

  test("coalesces concurrent refreshes in one vault", async () => {
    let refreshes = 0;
    const { createVault } = await setup({
      refresh: async () => {
        refreshes += 1;
        await Bun.sleep(15);
        return makeCredentials("account-1", NOW + 3_600_000, "refreshed");
      },
    });
    const vault = createVault();
    const id = await vault.addFromOAuth(
      "work",
      makeCredentials("account-1", NOW + 60_000, "expiring"),
    );

    const [first, second] = await Promise.all([
      vault.getFreshCredential(id),
      vault.getFreshCredential(id),
    ]);

    expect(refreshes).toBe(1);
    expect(first.accessToken).toBe(second.accessToken);
  });

  test("keeps a shared refresh alive when its first caller aborts", async () => {
    const firstCaller = new AbortController();
    let resolveRefresh: ((credentials: ReturnType<typeof makeCredentials>) => void) | undefined;
    let markRefreshStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const { createVault } = await setup({
      refresh: async () => {
        markRefreshStarted?.();
        return await new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      },
    });
    const vault = createVault();
    const id = await vault.addFromOAuth(
      "work",
      makeCredentials("account-1", NOW + 60_000, "expiring"),
    );

    const first = vault.getFreshCredential(id, firstCaller.signal);
    const second = vault.getFreshCredential(id);
    await refreshStarted;
    const cancellation = new Error("first caller cancelled");
    firstCaller.abort(cancellation);

    await expect(
      Promise.race([
        first,
        Bun.sleep(100).then(() => {
          throw new Error("first caller did not cancel independently");
        }),
      ]),
    ).rejects.toBe(cancellation);
    resolveRefresh?.(makeCredentials("account-1", NOW + 3_600_000, "refreshed"));
    expect((await second).accessToken).toBe(
      makeCredentials("account-1", NOW + 3_600_000, "refreshed").access,
    );
  });

  test("reuses a peer vault's refresh after acquiring the cross-process lock", async () => {
    let refreshes = 0;
    const { createVault } = await setup({
      refresh: async () => {
        refreshes += 1;
        await Bun.sleep(20);
        return makeCredentials("account-1", NOW + 3_600_000, "rotated");
      },
    });
    const first = createVault();
    const second = createVault();
    const id = await first.addFromOAuth(
      "work",
      makeCredentials("account-1", NOW + 60_000, "expiring"),
    );

    const credentials = await Promise.all([
      first.getFreshCredential(id),
      second.getFreshCredential(id),
    ]);

    expect(refreshes).toBe(1);
    expect(credentials[0].accessToken).toBe(credentials[1].accessToken);
  });

  test("force refreshes a rejected but nominally unexpired access token", async () => {
    let refreshes = 0;
    const { createVault } = await setup({
      refresh: async () => {
        refreshes += 1;
        return makeCredentials("account-1", NOW + 3_600_000, "forced");
      },
    });
    const vault = createVault();
    const original = makeCredentials("account-1", NOW + 3_600_000, "rejected");
    const id = await vault.addFromOAuth("work", original);

    const credential = await vault.forceRefreshCredential(id, original.access);

    expect(refreshes).toBe(1);
    expect(credential.accessToken).toBe(
      makeCredentials("account-1", NOW + 3_600_000, "forced").access,
    );
  });

  test("marks definitive invalid_grant failures for reauthentication", async () => {
    const { createVault } = await setup({
      refresh: async () => {
        throw Object.assign(new Error("invalid_grant"), { code: "invalid_grant" });
      },
    });
    const vault = createVault();
    const id = await vault.addFromOAuth(
      "work",
      makeCredentials("account-1", NOW + 60_000, "expiring"),
    );

    await expect(vault.getFreshCredential(id)).rejects.toBeInstanceOf(AccountNeedsReauthError);
    expect(await vault.list()).toEqual([expect.objectContaining({ id, needsReauth: true })]);
  });

  test("sanitizes transient refresh errors without invalidating the account", async () => {
    const credentials = makeCredentials("account-1", NOW + 60_000, "expiring");
    const { createVault } = await setup({
      refresh: async () => {
        throw new Error(`network failed for ${credentials.refresh}`);
      },
    });
    const vault = createVault();
    const id = await vault.addFromOAuth("work", credentials);

    try {
      await vault.getFreshCredential(id);
      throw new Error("expected refresh to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenRefreshTransientError);
      expect((error as Error).message).not.toContain(credentials.refresh);
      expect((error as Error).message).not.toContain(credentials.access);
    }
    expect(await vault.list()).toEqual([expect.objectContaining({ id, needsReauth: false })]);
  });
});
