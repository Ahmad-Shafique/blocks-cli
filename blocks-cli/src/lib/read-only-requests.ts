import { AsyncLocalStorage } from "node:async_hooks";
import { CliActionableError } from "./errors.js";

/**
 * A request context in which `blocksRequest` refuses anything but a read (decision 0007
 * §4). `blocks plan` runs inside it, so a bug that reached a write path fails before the
 * request leaves the machine instead of changing the project.
 */
const readOnly = new AsyncLocalStorage<{ reason: string }>();

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Endpoints that read but take a POST body (a search filter or a list of key names).
 * Exact paths only: `/iam/v4/iam/roles/create` and every other write stays refused.
 * Each entry is a list or lookup that changes nothing (I14-WP7).
 */
export const READ_ONLY_POST_PATHS: ReadonlySet<string> = new Set([
  "/iam/v4/iam/roles",
  "/iam/v4/iam/permissions",
  "/localization/v4/Key/GetsByKeyNames"
]);

export function runReadOnly<T>(reason: string, task: () => Promise<T>): Promise<T> {
  return readOnly.run({ reason }, task);
}

export function isReadOnlyContext(): boolean {
  return readOnly.getStore() !== undefined;
}

/** Throws when a non-read request is attempted inside `runReadOnly`. */
export function assertRequestAllowed(method: string, path: string): void {
  const store = readOnly.getStore();
  if (!store || READ_METHODS.has(method.toUpperCase())) return;
  if (method.toUpperCase() === "POST" && READ_ONLY_POST_PATHS.has(path.replace(/\/+$/, ""))) return;
  throw new CliActionableError(
    `Refused ${method.toUpperCase()} ${path}: ${store.reason} is read-only and sends only GET requests.`,
    "read_only_violation",
    "This is a bug in the CLI; nothing was sent. Report it with the command you ran."
  );
}
