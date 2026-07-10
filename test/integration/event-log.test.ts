import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { createEventLog } from "../../src/logging/event-log.ts";
import { createStorageFixture } from "../fixtures/storage.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("bounded event log", () => {
  test("redacts serialized events and writes private files", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const log = createEventLog({ path: fixture.file });
    expect(
      await log.append({
        type: "request_completed",
        at: 1,
        detail: { secret: "Bearer secret-token-value" },
      }),
    ).toBe(true);
    const content = await readFile(fixture.file, "utf8");
    expect(content).not.toContain("secret-token-value");
    expect(content).toContain("[REDACTED]");
    expect((await stat(fixture.file)).mode & 0o777).toBe(0o600);
  });

  test("keeps only one rotated predecessor", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const log = createEventLog({ path: fixture.file, maxBytes: 100 });
    for (let index = 0; index < 5; index += 1) {
      await log.append({
        type: "request_completed",
        at: index,
        detail: { text: "x".repeat(60) },
      });
    }
    expect(await readFile(`${fixture.file}.1`, "utf8")).not.toBe("");
    expect((await stat(fixture.file)).size).toBeLessThanOrEqual(200);
  });
});
