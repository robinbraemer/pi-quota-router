import { appendFile, chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { RoutingEvent } from "../types.ts";
import { redact } from "./redact.ts";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export interface EventLog {
  append(event: RoutingEvent): Promise<boolean>;
}

export function createEventLog(options: { path: string; maxBytes?: number }): EventLog {
  return {
    async append(event) {
      try {
        const parent = dirname(options.path);
        await mkdir(parent, { mode: 0o700, recursive: true });
        await chmod(parent, 0o700);
        const target = `${options.path}.lock-target`;
        const targetHandle = await open(target, "a", 0o600);
        await targetHandle.close();
        await chmod(target, 0o600);
        const release = await lockfile.lock(target, {
          realpath: false,
          stale: 30_000,
          retries: { retries: 20, minTimeout: 5, maxTimeout: 50 },
        });
        try {
          const line = `${redact(JSON.stringify(event))}\n`;
          const currentSize = await stat(options.path)
            .then((metadata) => metadata.size)
            .catch(() => 0);
          if (
            currentSize > 0 &&
            currentSize + Buffer.byteLength(line) > (options.maxBytes ?? DEFAULT_MAX_BYTES)
          ) {
            await rm(`${options.path}.1`, { force: true });
            await rename(options.path, `${options.path}.1`);
            await chmod(`${options.path}.1`, 0o600);
          }
          await appendFile(options.path, line, { encoding: "utf8", mode: 0o600 });
          await chmod(options.path, 0o600);
          return true;
        } finally {
          await release();
        }
      } catch {
        return false;
      }
    },
  };
}
