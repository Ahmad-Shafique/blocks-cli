import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./data-response.js";

/**
 * The journal of one `blocks apply --write` run (decision 0007 §5): resource, action and
 * result, no secret values and no response bodies. It is rewritten after every step, so a
 * crash leaves a record, and the next run reads `reloadPending` to finish what was staged.
 */
export type JournalEntry = {
  action: string;
  area: string;
  /** The words before the first colon of the failure only; never a response body. */
  error?: string;
  kind: string;
  name: string;
  status: "ok" | "failed";
};

export type Journal = {
  entries: JournalEntry[];
  file?: string;
  finishedAt?: string;
  /** Data written but the gateway not yet reloaded: the next apply reloads even with nothing else to write. */
  reloadPending: boolean;
  startedAt: string;
  tenant: string;
  /** Localization modules whose keys were saved but whose UILM file was not regenerated yet (publish once). */
  uilmPending?: string[];
  version: 1;
};

const JOURNAL_PATTERN = /^blocks-apply-.*\.json$/;

export function newJournal(tenant: string): Journal {
  return { entries: [], reloadPending: false, startedAt: new Date().toISOString(), tenant, version: 1 };
}

export function briefError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Only the words before the first colon: the rest of an API error is the response body.
  return message.split(/[\r\n]/)[0].split(":")[0].trim().slice(0, 160);
}

export async function saveJournal(logsDir: string, journal: Journal): Promise<string> {
  await mkdir(logsDir, { recursive: true });
  if (!journal.file) journal.file = join(logsDir, `blocks-apply-${journal.startedAt.replace(/[:.]/g, "-")}.json`);
  const { file, ...body } = journal;
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

/** The newest journal for this tenant, if there is one. */
export async function latestJournal(logsDir: string, tenant: string): Promise<Journal | undefined> {
  let names: string[];
  try {
    names = (await readdir(logsDir)).filter((name) => JOURNAL_PATTERN.test(name)).sort().reverse();
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(logsDir, name), "utf8"));
      if (isRecord(parsed) && parsed.tenant === tenant && Array.isArray(parsed.entries)) {
        return { ...(parsed as unknown as Journal), file: join(logsDir, name) };
      }
    } catch { /* an unreadable journal is skipped */ }
  }
  return undefined;
}
