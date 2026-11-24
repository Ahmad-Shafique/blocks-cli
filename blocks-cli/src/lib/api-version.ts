import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config.js";

// The dated API version (decisions/0003-api-versioning.md, I11-WP5). The CLI sends one `Blocks-Version` value on every
// call; a service echoes the version it resolved. The last echo is cached next to the CLI config, so `blocks doctor`
// can compare the two without a network request (doctor's contract).
export const BLOCKS_API_VERSION = "2026-11-25";
const CACHE_FILE = "api-version.json";

export type ApiVersionCache = { seenAt: string; version: string };

/** Records the version a service echoed, when it differs from what is cached. Never throws: a cache failure must not fail a command. */
export async function recordEchoedApiVersion(version: string | null | undefined): Promise<void> {
  if (!version || !/^\d{4}-\d{2}-\d{2}$/.test(version)) return;
  try {
    const cached = await readEchoedApiVersion();
    if (cached?.version === version) return;
    await mkdir(configDir(), { recursive: true });
    await writeFile(join(configDir(), CACHE_FILE), JSON.stringify({ seenAt: new Date().toISOString(), version } satisfies ApiVersionCache), "utf8");
  } catch {
    // best effort
  }
}

export async function readEchoedApiVersion(): Promise<ApiVersionCache | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(configDir(), CACHE_FILE), "utf8")) as ApiVersionCache;
    return typeof raw?.version === "string" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Doctor's line: ok when no echo has been seen yet (nothing to compare), or when the echo equals what the CLI sends. */
export function compareApiVersion(sent: string, echoed: string | undefined): { ok: boolean; detail: string } {
  if (!echoed) return { ok: true, detail: `${sent} (no service answer seen yet)` };
  return echoed === sent
    ? { ok: true, detail: `${sent} (matches the last service answer)` }
    : { ok: false, detail: `${sent} (the last service answered ${echoed}; update the CLI or pin the project)` };
}
