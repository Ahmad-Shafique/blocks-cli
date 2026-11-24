import { blocksRequest } from "./api.js";
import { isRecord } from "./data-response.js";
import type { IamPermissionEntry, IamRoleEntry } from "./project-file.js";
import { carryCurrent } from "./merge-current.js";
import { diffSubset, type PlanItem } from "./project-plan.js";
import { requestContext } from "./request-context.js";
import { collectPages } from "./snapshots.js";

/**
 * The IAM area of the project file (decision 0007 §3, §7, build step 3): permissions keyed
 * by name and roles keyed by slug. The diff is pure and unit-tested; the readers are the
 * same list endpoints `blocks pull` uses (read-style POSTs on the plan allow-list); the
 * writers make the same requests as `iam permissions create/update` and
 * `iam roles create/update/assign-permissions`. IAM is security-sensitive (rule 11):
 * apply only creates and updates, and only ADDS permissions to a role, never removes one.
 */

type Flags = Record<string, string | boolean>;
type Row = Record<string, unknown>;

export type IamDesired = { permissions: IamPermissionEntry[]; roles: IamRoleEntry[] };

export type IamLive = {
  permissions: Row[];
  /** Permission rows a role already holds, by role slug (only roles the file names and the project has). */
  rolePermissions: Map<string, Row[]>;
  roles: Row[];
};

export type IamPlan = {
  desired: IamDesired;
  items: PlanItem[];
  /** Permission references a role still lacks, by role slug (plan: what apply will add). */
  missingPermissions: Map<string, string[]>;
};

const PAGE_SIZE = 100;

function str(row: Row, key: string): string | undefined {
  const value = row[key] ?? row[key[0].toUpperCase() + key.slice(1)];
  return typeof value === "string" ? value : undefined;
}

function projectAuth(flags: Flags, projectKey: string) {
  return { impersonatedProjectAuth: true as const, ...requestContext(flags), projectTenantId: projectKey };
}

// ---------------------------------------------------------------- readers

async function listAll(
  flags: Flags,
  projectKey: string,
  path: string,
  extraBody: Record<string, unknown>,
  filter: Record<string, unknown>
): Promise<Row[]> {
  const result = await collectPages(0, PAGE_SIZE, (page, pageSize) => blocksRequest<unknown>(path, {
    ...projectAuth(flags, projectKey),
    body: { ...extraBody, filter, page, pageSize }
  }));
  if (!Array.isArray(result)) throw new Error(`Unexpected list response from ${path}: not a list of rows.`);
  return result.filter(isRecord);
}

/** Search and IsBuiltIn are non-nullable server-side; "" means unfiltered (see `iam permissions list`). */
export function fetchAllPermissions(flags: Flags, projectKey: string, roles?: string[]): Promise<Row[]> {
  return listAll(flags, projectKey, "/iam/v4/iam/permissions", roles ? { roles } : {}, { isArchived: false, isBuiltIn: "", search: "" });
}

export function fetchAllRoles(flags: Flags, projectKey: string): Promise<Row[]> {
  return listAll(flags, projectKey, "/iam/v4/iam/roles", {}, { search: "" });
}

export async function fetchIamLive(flags: Flags, projectKey: string, desiredRoles: IamRoleEntry[]): Promise<IamLive> {
  const [permissions, roles] = [await fetchAllPermissions(flags, projectKey), await fetchAllRoles(flags, projectKey)];
  const liveSlugs = new Set(roles.map((role) => str(role, "slug")).filter((slug): slug is string => Boolean(slug)));
  const rolePermissions = new Map<string, Row[]>();
  for (const role of desiredRoles) {
    if (liveSlugs.has(role.slug) && role.permissions?.length) {
      rolePermissions.set(role.slug, await fetchAllPermissions(flags, projectKey, [role.slug]));
    }
  }
  return { permissions, rolePermissions, roles };
}

// ---------------------------------------------------------------- diff

function sortedStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").sort() : undefined;
}

function livePermissionView(row: Row): Row {
  return {
    dependentPermissions: sortedStrings(row.dependentPermissions),
    description: row.description,
    name: row.name,
    permissionSeverity: row.permissionSeverity,
    resource: row.resource,
    resourceGroup: row.resourceGroup,
    tags: sortedStrings(row.tags),
    type: row.type
  };
}

function desiredPermissionView(entry: IamPermissionEntry): Row {
  const view: Row = {};
  if (entry.description !== undefined) view.description = entry.description;
  if (entry.resource !== undefined) view.resource = entry.resource;
  if (entry.resourceGroup !== undefined) view.resourceGroup = entry.resourceGroup;
  if (entry.type !== undefined) view.type = entry.type;
  if (entry.severity !== undefined) view.permissionSeverity = entry.severity;
  if (entry.tags !== undefined) view.tags = [...entry.tags].sort();
  if (entry.dependentPermissions !== undefined) view.dependentPermissions = [...entry.dependentPermissions].sort();
  return view;
}

function liveRoleView(row: Row): Row {
  return {
    canCreateOwn: row.canCreateOwn,
    description: row.description,
    name: row.name,
    parentRoleSlug: row.parentRoleSlug
  };
}

function desiredRoleView(entry: IamRoleEntry): Row {
  const view: Row = {};
  if (entry.name !== undefined) view.name = entry.name;
  if (entry.description !== undefined) view.description = entry.description;
  if (entry.parentRoleSlug !== undefined) view.parentRoleSlug = entry.parentRoleSlug;
  if (entry.canCreateOwn !== undefined) view.canCreateOwn = entry.canCreateOwn;
  return view;
}

/** An empty or missing description reads the same on both sides. */
function normalizeDescriptions(view: Row): Row {
  const copy = { ...view };
  if (copy.description === "") copy.description = undefined;
  return copy;
}

/** Duplicate keys in the file fail the plan: a natural key must identify one entry. */
export function validateIamDesired(desired: IamDesired): string[] {
  const errors: string[] = [];
  const seen = (label: string, keys: string[]) => {
    const found = new Set<string>();
    for (const key of keys) {
      if (found.has(key)) errors.push(`iam.${label}: '${key}' appears more than once`);
      found.add(key);
    }
  };
  seen("permissions", desired.permissions.map((permission) => permission.name));
  seen("roles", desired.roles.map((role) => role.slug));
  for (const role of desired.roles) {
    if (role.parentRoleSlug === role.slug) errors.push(`iam.roles: '${role.slug}' cannot be its own parent`);
  }
  const bySlug = new Map(desired.roles.map((role) => [role.slug, role]));
  for (const role of desired.roles) {
    const trail = new Set<string>([role.slug]);
    let parent = role.parentRoleSlug ? bySlug.get(role.parentRoleSlug) : undefined;
    while (parent) {
      if (trail.has(parent.slug)) { errors.push(`iam.roles: '${role.slug}' has a parent cycle through '${parent.slug}'`); break; }
      trail.add(parent.slug);
      parent = parent.parentRoleSlug ? bySlug.get(parent.parentRoleSlug) : undefined;
    }
  }
  return errors;
}

/** Roles in an order where every parent (that the file names) comes before its children. */
export function rolesParentsFirst(roles: IamRoleEntry[]): IamRoleEntry[] {
  const bySlug = new Map(roles.map((role) => [role.slug, role]));
  const done = new Set<string>();
  const ordered: IamRoleEntry[] = [];
  const visit = (role: IamRoleEntry, trail: Set<string>) => {
    if (done.has(role.slug) || trail.has(role.slug)) return;
    trail.add(role.slug);
    const parent = role.parentRoleSlug ? bySlug.get(role.parentRoleSlug) : undefined;
    if (parent) visit(parent, trail);
    done.add(role.slug);
    ordered.push(role);
  };
  for (const role of roles) visit(role, new Set());
  return ordered;
}

/**
 * The IAM plan. A role's `permissions` entries are matched to a live permission by name or
 * by `module::resource`; one that matches nothing (live, or created by this file) blocks
 * the role. Only keys the file states are compared (§8).
 */
export function diffIam(desired: IamDesired, live: IamLive): IamPlan {
  const items: PlanItem[] = [];
  const missingPermissions = new Map<string, string[]>();

  const liveByName = new Map<string, Row>();
  for (const row of live.permissions) {
    const name = str(row, "name");
    if (name) liveByName.set(name, row);
  }
  const desiredNames = new Set(desired.permissions.map((permission) => permission.name));
  const desiredResources = new Set(desired.permissions.map((permission) => permission.resource).filter((resource): resource is string => Boolean(resource)));

  for (const entry of desired.permissions) {
    const row = liveByName.get(entry.name);
    if (!row) {
      items.push({ action: "create", area: "iam", kind: "permission", name: entry.name, ...(entry.resource ? {} : { note: "no resource given; the server decides" }) });
      continue;
    }
    const changes: string[] = [];
    diffSubset(normalizeDescriptions(desiredPermissionView(entry)), normalizeDescriptions(livePermissionView(row)), "", changes);
    items.push(changes.length
      ? { action: "update", area: "iam", changes, kind: "permission", name: entry.name }
      : { action: "unchanged", area: "iam", kind: "permission", name: entry.name });
  }
  for (const row of live.permissions) {
    const name = str(row, "name");
    if (!name || desiredNames.has(name) || row.isBuiltIn === true) continue;
    items.push({ action: "not-in-file", area: "iam", kind: "permission", name });
  }

  const liveRoles = new Map<string, Row>();
  for (const row of live.roles) {
    const slug = str(row, "slug");
    if (slug) liveRoles.set(slug, row);
  }
  const desiredSlugs = new Set(desired.roles.map((role) => role.slug));
  const knownByRef = (reference: string) => liveByName.has(reference)
    || live.permissions.some((row) => str(row, "resource") === reference)
    || desiredNames.has(reference)
    || desiredResources.has(reference);

  for (const role of rolesParentsFirst(desired.roles)) {
    const row = liveRoles.get(role.slug);
    const problems: string[] = [];
    if (role.parentRoleSlug && !liveRoles.has(role.parentRoleSlug) && !desiredSlugs.has(role.parentRoleSlug)) {
      problems.push(`parent role '${role.parentRoleSlug}' is not in the project or the file`);
    }
    const unknown = (role.permissions ?? []).filter((reference) => !knownByRef(reference));
    if (unknown.length) problems.push(`unknown permission(s): ${unknown.join(", ")}`);
    if (!row && !role.name) problems.push("a new role needs a name");
    if (problems.length) {
      items.push({ action: "blocked", area: "iam", kind: "role", name: role.slug, note: problems.join("; ") });
      continue;
    }

    const held = live.rolePermissions.get(role.slug) ?? [];
    const lacks = (role.permissions ?? []).filter((reference) => !held.some((permission) => str(permission, "name") === reference || str(permission, "resource") === reference));
    if (lacks.length) missingPermissions.set(role.slug, lacks);

    if (!row) {
      items.push({ action: "create", area: "iam", kind: "role", name: role.slug, ...(role.permissions?.length ? { note: `${role.permissions.length} permission(s) to assign` } : {}) });
      if (role.permissions?.length) missingPermissions.set(role.slug, [...role.permissions]);
      continue;
    }
    const changes: string[] = [];
    diffSubset(normalizeDescriptions(desiredRoleView(role)), normalizeDescriptions(liveRoleView(row)), "", changes);
    if (lacks.length) changes.push(`permissions (+${lacks.join(", +")})`);
    items.push(changes.length
      ? { action: "update", area: "iam", changes, kind: "role", name: role.slug }
      : { action: "unchanged", area: "iam", kind: "role", name: role.slug });
  }
  for (const slug of [...liveRoles.keys()].sort()) {
    if (!desiredSlugs.has(slug)) items.push({ action: "not-in-file", area: "iam", kind: "role", name: slug });
  }
  return { desired, items, missingPermissions };
}

export async function computeIamPlan(flags: Flags, projectKey: string, desired: IamDesired): Promise<IamPlan> {
  const errors = validateIamDesired(desired);
  if (errors.length) throw new Error(`IAM section is not valid:\n${errors.map((error) => `  ${error}`).join("\n")}`);
  return diffIam(desired, await fetchIamLive(flags, projectKey, desired.roles));
}

// ---------------------------------------------------------------- writers

const PERMISSION_CARRIED = ["dependentPermissions", "description", "name", "permissionSeverity", "resource", "resourceGroup", "tags", "type"] as const;

export async function writePermission(entry: IamPermissionEntry, existingItemId: string | undefined, flags: Flags, projectKey: string): Promise<void> {
  const fields: Row = {
    dependentPermissions: entry.dependentPermissions,
    description: entry.description,
    name: entry.name,
    permissionSeverity: entry.severity,
    resource: entry.resource,
    resourceGroup: entry.resourceGroup,
    tags: entry.tags,
    type: entry.type
  };
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];

  if (!existingItemId) {
    await blocksRequest<unknown>("/iam/v4/iam/permissions/create", { body: fields, ...projectAuth(flags, projectKey) });
    return;
  }
  // The endpoint replaces the whole document: read the current one and merge over it
  // (the same shape as `iam permissions update`).
  const current = carryCurrent(
    await blocksRequest<unknown>(`/iam/v4/iam/permissions/${encodeURIComponent(existingItemId)}`, projectAuth(flags, projectKey)),
    PERMISSION_CARRIED
  );
  await blocksRequest<unknown>(`/iam/v4/iam/permissions/${encodeURIComponent(existingItemId)}`, {
    body: { ...current, ...fields, itemId: existingItemId },
    ...projectAuth(flags, projectKey)
  });
}

export async function writeRole(entry: IamRoleEntry, existingItemId: string | undefined, flags: Flags, projectKey: string): Promise<void> {
  const fields: Row = {
    canCreateOwn: entry.canCreateOwn,
    description: entry.description,
    name: entry.name,
    parentRoleSlug: entry.parentRoleSlug
  };
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];

  if (!existingItemId) {
    // A new role has no parent to clear: null means "none", which is the default.
    if (fields.parentRoleSlug === null) delete fields.parentRoleSlug;
    await blocksRequest<unknown>("/iam/v4/iam/roles/create", { body: { ...fields, slug: entry.slug }, ...projectAuth(flags, projectKey) });
    return;
  }
  // POST /roles/update assigns omitted fields as defaults, so merge over the current role.
  const current = carryCurrent(
    await blocksRequest<unknown>(`/iam/v4/iam/roles/${encodeURIComponent(existingItemId)}`, projectAuth(flags, projectKey)),
    ["name", "description", "parentRoleSlug", "canCreateOwn"]
  );
  await blocksRequest<unknown>("/iam/v4/iam/roles/update", {
    body: { ...current, ...fields, itemId: existingItemId },
    ...projectAuth(flags, projectKey)
  });
}

/** Adds permissions (never removes). `references` are names or `module::resource`; ids come from a fresh read. */
export async function addRolePermissions(slug: string, references: string[], flags: Flags, projectKey: string): Promise<void> {
  const rows = await fetchAllPermissions(flags, projectKey);
  const ids: string[] = [];
  for (const reference of references) {
    const row = rows.find((candidate) => str(candidate, "name") === reference) ?? rows.find((candidate) => str(candidate, "resource") === reference);
    const itemId = row ? str(row, "itemId") ?? str(row, "id") : undefined;
    if (!itemId) throw new Error(`Permission '${reference}' was not found for role '${slug}'.`);
    ids.push(itemId);
  }
  await blocksRequest<unknown>("/iam/v4/iam/roles/assign-permissions", {
    body: { addPermissions: ids, slug },
    ...projectAuth(flags, projectKey)
  });
}

export function itemIdOf(row: Row | undefined): string | undefined {
  return row ? str(row, "itemId") ?? str(row, "id") : undefined;
}

export async function iamIdsBySlugAndName(flags: Flags, projectKey: string): Promise<{ permissions: Map<string, string>; roles: Map<string, string> }> {
  const permissions = new Map<string, string>();
  const roles = new Map<string, string>();
  for (const row of await fetchAllPermissions(flags, projectKey)) {
    const name = str(row, "name");
    const id = itemIdOf(row);
    if (name && id) permissions.set(name, id);
  }
  for (const row of await fetchAllRoles(flags, projectKey)) {
    const slug = str(row, "slug");
    const id = itemIdOf(row);
    if (slug && id) roles.set(slug, id);
  }
  return { permissions, roles };
}
