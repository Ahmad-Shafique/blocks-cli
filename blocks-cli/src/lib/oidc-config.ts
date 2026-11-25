import { stringFlag } from "./args.js";
import { blocksRequest } from "./api.js";
import { defaults } from "./config.js";
import { carryOidcClient, readOidcClient } from "./oidc-client.js";
import { listOidcClients } from "./oidc-callback.js";
import { withBlocksIdentityProviderDiscovery } from "./oidc-discovery.js";
import { diffSubset, type PlanItem } from "./project-plan.js";
import { requestContext } from "./request-context.js";

/**
 * The `auth.oidcClients` list of the project file (decision 0007 §3, §7, build step 4): OIDC
 * clients keyed by display name. The file never holds a client secret: a new client's secret
 * is returned once by the server and is dropped here (get one with `auth oidc-clients
 * rotate-secret`). Apply only creates and updates; it never deletes a client. An update
 * carries the stored client's own fields (`carryOidcClient`) under the stated keys, as
 * `auth oidc-clients save` does, so unstated fields survive.
 */

type Flags = Record<string, string | boolean>;
type Row = Record<string, unknown>;

/** File key -> server field. Lists compare sorted. */
export const OIDC_CLIENT_FIELDS: Record<string, { field: string }> = {
  allowedMfaMethods: { field: "allowedMfaMethods" },
  allowedResponseTypes: { field: "allowedResponseTypes" },
  allowedScopes: { field: "allowedScopes" },
  backChannelLogoutUri: { field: "backChannelLogoutUri" },
  clientType: { field: "clientType" },
  externalDiscoveryEndpoint: { field: "externalDiscoveryEndpoint" },
  frontChannelLogoutUri: { field: "frontChannelLogoutUri" },
  isActive: { field: "isActive" },
  isAutoRedirect: { field: "isAutoRedirect" },
  isDeviceFlowClient: { field: "isDeviceFlowClient" },
  loginMode: { field: "loginMode" },
  postLogoutRedirectUris: { field: "postLogoutRedirectUris" },
  redirectUris: { field: "redirectUris" },
  registerAsIdentityProvider: { field: "registerAsIdentityProvider" },
  requireConsent: { field: "requireConsent" },
  requireMfa: { field: "requireMfa" },
  requirePkce: { field: "requirePkce" },
  useTokensCookie: { field: "useTokensCookie" }
};

export type OidcClientEntry = { name: string } & Partial<Record<keyof typeof OIDC_CLIENT_FIELDS, boolean | string | Array<string | number>>>;

export type OidcPlan = { desired: OidcClientEntry[]; items: PlanItem[]; live: Row[] };

function liveName(row: Row): string | undefined {
  return typeof row.clientDisplayName === "string" ? row.clientDisplayName : undefined;
}

function normalise(value: unknown): unknown {
  return Array.isArray(value) ? [...value].sort() : value;
}

/** Duplicate names fail the plan: a natural key must identify one client. */
export function validateOidcDesired(desired: OidcClientEntry[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of desired) {
    if (seen.has(entry.name)) errors.push(`auth.oidcClients: '${entry.name}' appears more than once`);
    seen.add(entry.name);
  }
  return errors;
}

/** The server field values the file states for one client. */
export function desiredOidcFields(entry: OidcClientEntry): Row {
  const fields: Row = {};
  for (const [key, value] of Object.entries(entry)) {
    const mapping = OIDC_CLIENT_FIELDS[key];
    if (mapping && value !== undefined) fields[mapping.field] = value;
  }
  return fields;
}

/** Compares only the stated keys (§8); a client the file does not name is left alone (never deleted). */
export function diffOidcClients(desired: OidcClientEntry[], live: Row[]): PlanItem[] {
  const liveByName = new Map<string, Row>();
  for (const row of live) {
    const name = liveName(row);
    if (name && !liveByName.has(name)) liveByName.set(name, row);
  }
  return desired.map((entry): PlanItem => {
    const row = liveByName.get(entry.name);
    if (!row) {
      return { action: "create", area: "auth", kind: "oidcClient", name: entry.name, note: "the new client's secret is not shown; use auth oidc-clients rotate-secret" };
    }
    const changes: string[] = [];
    for (const [key, value] of Object.entries(entry)) {
      const mapping = OIDC_CLIENT_FIELDS[key];
      if (!mapping || value === undefined) continue;
      diffSubset(normalise(value), normalise(row[mapping.field]), key, changes);
    }
    return changes.length
      ? { action: "update", area: "auth", changes, kind: "oidcClient", name: entry.name }
      : { action: "unchanged", area: "auth", kind: "oidcClient", name: entry.name };
  });
}

export async function computeOidcPlan(flags: Flags, projectKey: string, desired: OidcClientEntry[]): Promise<OidcPlan> {
  const errors = validateOidcDesired(desired);
  if (errors.length) throw new Error(errors.join("; "));
  const live = await listOidcClients(projectKey, flags);
  return { desired, items: diffOidcClients(desired, live), live };
}

/**
 * Creates or updates one client. A new client gets the same bootstrap defaults as `auth
 * oidc-clients save` (auto redirect, registered as an identity provider, discovery URL).
 * The response (it holds the one-time secret) is discarded, never printed or journaled.
 */
export async function writeOidcClient(entry: OidcClientEntry, existing: Row | undefined, flags: Flags, projectKey: string): Promise<void> {
  const overrides = desiredOidcFields(entry);
  let current: Row = {};
  let itemId: string | undefined;
  if (existing) {
    itemId = typeof existing.itemId === "string" ? existing.itemId : typeof existing.clientId === "string" ? existing.clientId : undefined;
    if (!itemId) throw new Error(`OIDC client '${entry.name}' has no id in the list response.`);
    const stored = await readOidcClient(itemId, projectKey, flags);
    if (!stored) throw new Error(`OIDC client '${entry.name}' was not found when re-read.`);
    current = carryOidcClient(stored);
  }
  const newDefaults = existing ? {} : { isAutoRedirect: true, registerAsIdentityProvider: true };
  const oidcUrl = stringFlag(flags, "oidc-url", { defaultValue: defaults().oidcUrl });
  const body = withBlocksIdentityProviderDiscovery(
    { ...newDefaults, ...current, ...overrides, clientDisplayName: entry.name, ...(itemId ? { itemId } : {}) },
    oidcUrl,
    projectKey
  );
  await blocksRequest<unknown>("/iam/v4/oidc-clients", { body, impersonatedProjectAuth: true, ...requestContext(flags), projectTenantId: projectKey });
}
