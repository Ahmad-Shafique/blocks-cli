import {
  SECURITY_ACCESS_LEVELS,
  SECURITY_OPERATIONS,
  SECURITY_POLICY_TYPES,
  toPortablePolicy,
  toPortableSchema,
  type SchemaDocument
} from "./data-files.js";
import { isRecord } from "./data-response.js";

/**
 * The diff engine of `blocks plan` (decision 0007 §4, steps 3 and 4), kept free of I/O so
 * it is unit-tested directly. Both sides are normalised with the same functions the
 * `data` commands use (`toPortableSchema`, `toPortablePolicy`), and only the keys the file
 * states are compared (§8): a server default the file does not mention is never a change.
 */

export type PlanAction = "create" | "update" | "unchanged" | "not-in-file" | "blocked";

export type PlanItem = {
  action: PlanAction;
  area: "data" | "iam" | "auth" | "localization";
  /** Changed field paths for an update (names only, never values). */
  changes?: string[];
  kind: "schema" | "policy" | "security" | "permission" | "role" | "dictionary" | "config";
  name: string;
  /** Why an item is blocked, or a note on a create or update. */
  note?: string;
};

export type PlanSummary = Record<PlanAction, number>;

export const ACTION_SYMBOL: Record<PlanAction, string> = {
  create: "+",
  update: "~",
  unchanged: "=",
  "not-in-file": "-",
  blocked: "!"
};

const ACTION_LABEL: Record<PlanAction, string> = {
  create: "create",
  update: "update",
  unchanged: "unchanged",
  "not-in-file": "not in file",
  blocked: "blocked"
};

/** Creates, updates and blocked items mean the project differs from the file. `- not in file` is reported only (no pruning in v1, owner's answer 3). */
export function hasChanges(items: PlanItem[]): boolean {
  return items.some((item) => item.action === "create" || item.action === "update" || item.action === "blocked");
}

export function summarize(items: PlanItem[]): PlanSummary {
  const summary: PlanSummary = { create: 0, update: 0, unchanged: 0, "not-in-file": 0, blocked: 0 };
  for (const item of items) summary[item.action] += 1;
  return summary;
}

// ---------------------------------------------------------------- comparison

function isNamedList(value: unknown[]): value is Array<Record<string, unknown> & { name: string }> {
  return value.length > 0 && value.every((item) => isRecord(item) && typeof item.name === "string" && item.name.length > 0);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null && b === undefined) || (a === undefined && b === null)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Collects the paths where `desired` differs from `actual`, looking only at keys present
 * in `desired`. Lists of records that carry a `name` (schema fields) are matched by name,
 * so order does not matter; a named item the server has and the file does not is a
 * change too, because a push replaces the whole list.
 */
export function diffSubset(desired: unknown, actual: unknown, path: string, changes: string[]): void {
  if (isRecord(desired)) {
    if (!isRecord(actual)) { changes.push(path); return; }
    for (const [key, value] of Object.entries(desired)) {
      diffSubset(value, actual[key], path ? `${path}.${key}` : key, changes);
    }
    return;
  }

  if (Array.isArray(desired) && isNamedList(desired)) {
    if (!Array.isArray(actual)) { changes.push(path); return; }
    const actualByName = new Map<string, unknown>();
    for (const item of actual) {
      if (isRecord(item) && typeof item.name === "string") actualByName.set(item.name, item);
    }
    const desiredNames = new Set<string>();
    for (const item of desired) {
      desiredNames.add(item.name);
      const live = actualByName.get(item.name);
      if (live === undefined) changes.push(`${path}.${item.name} (new)`);
      else diffSubset(item, live, `${path}.${item.name}`, changes);
    }
    for (const name of actualByName.keys()) {
      if (!desiredNames.has(name)) changes.push(`${path}.${name} (removed)`);
    }
    return;
  }

  if (!sameValue(desired, actual)) changes.push(path);
}

// ---------------------------------------------------------------- schemas

function portableLocal(schema: SchemaDocument): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...schema };
  delete copy.itemId;
  delete copy.id;
  return copy;
}

export function diffSchemas(
  local: SchemaDocument[],
  live: Record<string, unknown>[],
  newSchemaAccess: "user" | "public"
): PlanItem[] {
  const liveByName = new Map<string, Record<string, unknown>>();
  for (const raw of live) {
    if (typeof raw.schemaName === "string" && raw.schemaName) liveByName.set(raw.schemaName, raw);
  }

  const items: PlanItem[] = [];
  const localNames = new Set<string>();
  for (const schema of local) {
    const name = String(schema.schemaName);
    localNames.add(name);
    const raw = liveByName.get(name);
    if (!raw) {
      items.push({ action: "create", area: "data", kind: "schema", name, note: `new schema gets ${newSchemaAccess === "public" ? "Public" : "User"} access` });
      continue;
    }
    const changes: string[] = [];
    diffSubset(portableLocal(schema), toPortableSchema(raw), "", changes);
    items.push(changes.length
      ? { action: "update", area: "data", changes, kind: "schema", name }
      : { action: "unchanged", area: "data", kind: "schema", name });
  }

  for (const name of [...liveByName.keys()].sort()) {
    if (!localNames.has(name)) items.push({ action: "not-in-file", area: "data", kind: "schema", name });
  }
  return items;
}

// ---------------------------------------------------------------- policies

export function diffPolicies(
  local: Array<Record<string, unknown>>,
  livePoliciesBySchema: Map<string, Record<string, unknown>[]>,
  liveSchemaNames: Set<string>,
  localSchemaNames: Set<string>
): PlanItem[] {
  const items: PlanItem[] = [];
  const liveByKey = new Map<string, Record<string, unknown>>();
  for (const [schemaName, policies] of livePoliciesBySchema) {
    for (const raw of policies) {
      const portable = toPortablePolicy(raw, schemaName);
      liveByKey.set(`${portable.schemaName}/${portable.policyName}`, portable);
    }
  }

  const localKeys = new Set<string>();
  for (const policy of local) {
    const schemaName = String(policy.schemaName ?? "");
    const policyName = String(policy.policyName ?? "");
    const name = `${schemaName}/${policyName}`;
    localKeys.add(name);

    if (!liveSchemaNames.has(schemaName)) {
      items.push(localSchemaNames.has(schemaName)
        ? { action: "create", area: "data", kind: "policy", name, note: "after its schema is created" }
        : { action: "blocked", area: "data", kind: "policy", name, note: `schema '${schemaName}' is neither in the project nor in the file` });
      continue;
    }

    const live = liveByKey.get(name);
    if (!live) {
      items.push({ action: "create", area: "data", kind: "policy", name });
      continue;
    }
    const changes: string[] = [];
    diffSubset(policy, live, "", changes);
    items.push(changes.length
      ? { action: "update", area: "data", changes, kind: "policy", name }
      : { action: "unchanged", area: "data", kind: "policy", name });
  }

  for (const key of [...liveByKey.keys()].sort()) {
    if (!localKeys.has(key)) items.push({ action: "not-in-file", area: "data", kind: "policy", name: key });
  }
  return items;
}

// ---------------------------------------------------------------- security entries

function accessLevelName(value: unknown): string | undefined {
  if (typeof value === "number") return SECURITY_ACCESS_LEVELS[value];
  if (typeof value === "string" && value) return value;
  return undefined;
}

/** The plan name of a security entry (also how `apply` finds the entry behind a plan item). */
export function securityEntryName(entry: Record<string, unknown>): string {
  const operation = SECURITY_OPERATIONS[entry.operation as number] ?? String(entry.operation);
  const policyType = SECURITY_POLICY_TYPES[entry.policyType as number] ?? String(entry.policyType);
  const desired = SECURITY_ACCESS_LEVELS[entry.accessLevel as number] ?? String(entry.accessLevel);
  const schemaName = typeof entry.schemaName === "string" && entry.schemaName ? entry.schemaName : undefined;
  const schemaId = typeof entry.schemaId === "string" && entry.schemaId ? entry.schemaId : undefined;
  const fieldNames = Array.isArray(entry.fieldNames) ? entry.fieldNames.filter((item): item is string => typeof item === "string") : [];
  const target = schemaName ?? `id:${schemaId}`;
  return `${target} ${operation} ${policyType}${policyType === "CLS" && fieldNames.length ? ` [${fieldNames.join(", ")}]` : ""} = ${desired}`;
}

/**
 * Security entries set a schema's (RLS) or its fields' (CLS) access level per operation
 * (blocks-data DataAccessService.ConfigureSchemaAccess / ConfigureFieldAccess). The live
 * level is read from the schema list the plan already fetched: `<operation>AccessLevel`,
 * as an ordinal or a name.
 */
export function diffSecurity(
  entries: Array<Record<string, unknown>>,
  live: Record<string, unknown>[],
  localSchemaNames: Set<string>
): PlanItem[] {
  const items: PlanItem[] = [];
  for (const entry of entries) {
    const operation = SECURITY_OPERATIONS[entry.operation as number] ?? String(entry.operation);
    const policyType = SECURITY_POLICY_TYPES[entry.policyType as number] ?? String(entry.policyType);
    const desired = SECURITY_ACCESS_LEVELS[entry.accessLevel as number] ?? String(entry.accessLevel);
    const schemaName = typeof entry.schemaName === "string" && entry.schemaName ? entry.schemaName : undefined;
    const schemaId = typeof entry.schemaId === "string" && entry.schemaId ? entry.schemaId : undefined;
    const fieldNames = Array.isArray(entry.fieldNames) ? entry.fieldNames.filter((item): item is string => typeof item === "string") : [];
    const name = securityEntryName(entry);

    const schema = live.find((item) => (schemaName ? item.schemaName === schemaName : item.id === schemaId));
    if (!schema) {
      items.push(schemaName && localSchemaNames.has(schemaName)
        ? { action: "create", area: "data", kind: "security", name, note: "after its schema is created" }
        : { action: "blocked", area: "data", kind: "security", name, note: `schema ${schemaName ? `'${schemaName}'` : `id '${schemaId}'`} is not in the project${schemaName ? " or the file" : ""}` });
      continue;
    }

    const key = `${operation.toLowerCase()}AccessLevel`;
    if (policyType === "CLS") {
      const fields = Array.isArray(schema.fields) ? schema.fields.filter(isRecord) : [];
      const changes: string[] = [];
      for (const fieldName of fieldNames) {
        const field = fields.find((item) => item.name === fieldName);
        if (!field || accessLevelName(field[key]) !== desired) changes.push(`fields.${fieldName}.${key}`);
      }
      items.push(changes.length
        ? { action: "update", area: "data", changes, kind: "security", name }
        : { action: "unchanged", area: "data", kind: "security", name });
      continue;
    }

    const current = accessLevelName(schema[key]);
    if (current === desired) items.push({ action: "unchanged", area: "data", kind: "security", name });
    else items.push({ action: "update", area: "data", changes: [key], kind: "security", name, ...(current ? {} : { note: "the live level is not reported" }) });
  }
  return items;
}

// ---------------------------------------------------------------- output

export function renderPlanLines(items: PlanItem[]): string[] {
  return items.map((item) => {
    const detail = item.changes?.length ? `: ${item.changes.join(", ")}` : "";
    const note = item.note ? ` (${item.note})` : "";
    return `  ${ACTION_SYMBOL[item.action]} ${ACTION_LABEL[item.action].padEnd(11)} ${item.kind} ${item.name}${detail}${note}`;
  });
}

export function renderSummary(summary: PlanSummary): string {
  return `Summary: ${summary.create} to create, ${summary.update} to update, ${summary.unchanged} unchanged, ${summary["not-in-file"]} not in file, ${summary.blocked} blocked.`;
}
