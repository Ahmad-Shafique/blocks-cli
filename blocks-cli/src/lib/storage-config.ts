import { blocksRequest } from "./api.js";
import { isRecord } from "./data-response.js";
import { carryCurrent } from "./merge-current.js";
import { diffSubset, type PlanItem } from "./project-plan.js";
import { requestContext } from "./request-context.js";

/**
 * The `storage.configs` list of the project file (decision 0007 §3, §7, build step 4):
 * storage configurations keyed by name. Provider and credentials are fixed once a
 * configuration exists (Storage/Save drops them and still answers success), and a
 * credential never goes in the file, so apply manages only the four upload settings of a
 * configuration that already exists. A configuration the file names but the project lacks
 * is `blocked` with a note: create it once with `blocks storage config save`. Apply never
 * creates or deletes one. `storageStrategy`, when stated, is compared and a difference is
 * blocked (it cannot be changed in place).
 */

type Flags = Record<string, string | boolean>;
type Row = Record<string, unknown>;

/** File key -> server field, for the settings apply may write. */
export const STORAGE_UPLOAD_FIELDS: Record<string, { field: string }> = {
  downloadUrlExpirySeconds: { field: "downloadUrlExpirySeconds" },
  maxFileSizeInBytes: { field: "maxFileSizeInBytes" },
  uploadCompletionRequiredFor: { field: "uploadCompletionRequiredFor" },
  uploadUrlExpirySeconds: { field: "uploadUrlExpirySeconds" }
};

export type StorageConfigEntry = {
  name: string;
  storageStrategy?: string;
  downloadUrlExpirySeconds?: number;
  maxFileSizeInBytes?: number;
  uploadCompletionRequiredFor?: string[];
  uploadUrlExpirySeconds?: number;
};

export type StoragePlan = { desired: StorageConfigEntry[]; items: PlanItem[]; live: Row[] };

function normalise(value: unknown): unknown {
  return Array.isArray(value) ? [...value].sort() : value;
}

export function validateStorageDesired(desired: StorageConfigEntry[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of desired) {
    if (seen.has(entry.name)) errors.push(`storage.configs: '${entry.name}' appears more than once`);
    seen.add(entry.name);
  }
  return errors;
}

export function desiredStorageFields(entry: StorageConfigEntry): Row {
  const fields: Row = {};
  for (const [key, mapping] of Object.entries(STORAGE_UPLOAD_FIELDS)) {
    const value = (entry as Record<string, unknown>)[key];
    if (value !== undefined) fields[mapping.field] = value;
  }
  return fields;
}

export function diffStorageConfigs(desired: StorageConfigEntry[], live: Row[]): PlanItem[] {
  const liveByName = new Map<string, Row>();
  for (const row of live) {
    if (typeof row.name === "string" && !liveByName.has(row.name)) liveByName.set(row.name, row);
  }
  return desired.map((entry): PlanItem => {
    const base = { area: "storage" as const, kind: "storageConfig" as const, name: entry.name };
    const row = liveByName.get(entry.name);
    if (!row) {
      return { ...base, action: "blocked", note: "not in the project; create it once with 'blocks storage config save' (credentials are never kept in the file)" };
    }
    if (entry.storageStrategy !== undefined && row.storageStrategy !== undefined && entry.storageStrategy !== row.storageStrategy) {
      return { ...base, action: "blocked", note: "storageStrategy cannot be changed in place; delete the configuration and create it again" };
    }
    const changes: string[] = [];
    for (const [key, mapping] of Object.entries(STORAGE_UPLOAD_FIELDS)) {
      const value = (entry as Record<string, unknown>)[key];
      if (value === undefined) continue;
      diffSubset(normalise(value), normalise(row[mapping.field]), key, changes);
    }
    return changes.length ? { ...base, action: "update", changes } : { ...base, action: "unchanged" };
  });
}

function rowsOf(response: unknown): Row[] {
  const items = Array.isArray(response) ? response : isRecord(response) ? Object.values(response).find(Array.isArray) : undefined;
  return (items ?? []).filter(isRecord);
}

export async function listStorageConfigs(flags: Flags, projectKey: string): Promise<Row[]> {
  const response = await blocksRequest<unknown>("/os/v4/Storage/Gets", {
    impersonatedProjectAuth: true,
    ...requestContext(flags),
    projectTenantId: projectKey
  });
  return rowsOf(response);
}

export async function computeStoragePlan(flags: Flags, projectKey: string, desired: StorageConfigEntry[]): Promise<StoragePlan> {
  const errors = validateStorageDesired(desired);
  if (errors.length) throw new Error(errors.join("; "));
  const live = await listStorageConfigs(flags, projectKey);
  return { desired, items: diffStorageConfigs(desired, live), live };
}

/** Updates one existing configuration's upload settings, as `storage config save --update` does (all four are sent; unstated ones carry the stored value). */
export async function writeStorageConfig(entry: StorageConfigEntry, existing: Row, flags: Flags, projectKey: string): Promise<void> {
  const carried = carryCurrent(existing, Object.values(STORAGE_UPLOAD_FIELDS).map((mapping) => mapping.field));
  const body = { ...carried, ...desiredStorageFields(entry), itemId: existing.itemId, name: existing.name, updateRequest: true };
  await blocksRequest<unknown>("/os/v4/Storage/Save", { body, impersonatedProjectAuth: true, ...requestContext(flags), projectTenantId: projectKey });
}
