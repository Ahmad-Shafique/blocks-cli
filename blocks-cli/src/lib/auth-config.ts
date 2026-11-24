import { iamAccountActionBaseUrl, OIDC_ACTIVATION_PATH } from "./account-action.js";
import { blocksRequest } from "./api.js";
import { isRecord } from "./data-response.js";
import { diffSubset, type PlanItem } from "./project-plan.js";
import { requestContext } from "./request-context.js";

/**
 * The `auth.config` section of the project file (decision 0007 §3, §7, build step 4): the
 * AuthController configuration of the project (token lifetimes, lockout, password policy,
 * OIDC on or off). It is one document that always exists, so the plan item is an update or
 * unchanged, never a create. Plan reads it with `GET /iam/v4/auth/config`; apply merges the
 * stated keys over the stored document and posts it back, exactly as `auth config save`
 * does (the endpoint replaces the whole document). It holds no secret.
 */

type Flags = Record<string, string | boolean>;

/** File key -> the server's field name (the same fields `auth config save` writes), with the value type. */
export const AUTH_CONFIG_FIELDS: Record<string, { field: string; type: "boolean" | "integer" | "string" }> = {
  absoluteRefreshTokenMinutes: { field: "absoluteRefreshTokenValidForNumberMinutes", type: "integer" },
  accessTokenMinutes: { field: "accessTokenValidForNumberMinutes", type: "integer" },
  accountActionBaseUrl: { field: "accountActionBaseUrl", type: "string" },
  accountLockDurationMinutes: { field: "accountLockDurationInMinutes", type: "integer" },
  logoutOnPasswordChange: { field: "logoutOnPasswordChange", type: "boolean" },
  oidcEnabled: { field: "isOidcEnabled", type: "boolean" },
  passwordPolicyMaxLength: { field: "passwordPolicyMaxLength", type: "integer" },
  passwordPolicyMessage: { field: "passwordPolicyMessage", type: "string" },
  passwordPolicyMinLength: { field: "passwordPolicyMinLength", type: "integer" },
  passwordPolicyRequireLowercase: { field: "passwordPolicyRequireLowercase", type: "boolean" },
  passwordPolicyRequireNumbers: { field: "passwordPolicyRequireNumbers", type: "boolean" },
  passwordPolicyRequireSpecialChars: { field: "passwordPolicyRequireSpecialChars", type: "boolean" },
  passwordPolicyRequireUppercase: { field: "passwordPolicyRequireUppercase", type: "boolean" },
  passwordStrengthMessage: { field: "passwordStrengthCheckerMessage", type: "string" },
  passwordStrengthRegex: { field: "passwordStrengthCheckerRegex", type: "string" },
  refreshTokenMinutes: { field: "refreshTokenValidForNumberMinutes", type: "integer" },
  rememberMeRefreshTokenMinutes: { field: "rememberMeRefreshTokenValidForNumberMinutes", type: "integer" },
  wrongAttemptsToLock: { field: "getNumberOfWrongAttemptsToLockTheAccount", type: "integer" }
};

export type AuthConfigEntry = Partial<Record<keyof typeof AUTH_CONFIG_FIELDS, boolean | number | string>>;

export type AuthPlan = { desired: AuthConfigEntry; items: PlanItem[] };

function projectAuth(flags: Flags, projectKey: string) {
  return { impersonatedProjectAuth: true as const, ...requestContext(flags), projectTenantId: projectKey };
}

function omitNil(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

/** The stored document, nil fields dropped (the same read `auth config save` does). */
export async function fetchAuthConfig(flags: Flags, projectKey: string): Promise<Record<string, unknown>> {
  const response = await blocksRequest<unknown>("/iam/v4/auth/config", projectAuth(flags, projectKey));
  if (!isRecord(response)) throw new Error("Unexpected auth config response: not an object.");
  return omitNil(response);
}

/** The file's keys mapped onto server field names. */
export function desiredAuthFields(entry: AuthConfigEntry): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    const mapping = AUTH_CONFIG_FIELDS[key];
    if (mapping && value !== undefined) fields[mapping.field] = value;
  }
  return fields;
}

/** Compares only the stated keys (§8); a changed key is listed by the file's own name. */
export function diffAuthConfig(entry: AuthConfigEntry, live: Record<string, unknown>): PlanItem[] {
  const changes: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    const mapping = AUTH_CONFIG_FIELDS[key];
    if (!mapping || value === undefined) continue;
    diffSubset(value, live[mapping.field], key, changes);
  }
  return [changes.length
    ? { action: "update", area: "auth", changes, kind: "config", name: "auth config" }
    : { action: "unchanged", area: "auth", kind: "config", name: "auth config" }];
}

export async function computeAuthPlan(flags: Flags, projectKey: string, desired: AuthConfigEntry): Promise<AuthPlan> {
  return { desired, items: diffAuthConfig(desired, await fetchAuthConfig(flags, projectKey)) };
}

/**
 * Saves the stated keys over the stored document. Turning OIDC on also points the activation
 * path at the OIDC variant and, unless the file states one, the base URL at the IAM host: the
 * same rule `auth config save` applies, so the stored document stays consistent.
 */
export async function writeAuthConfig(desired: AuthConfigEntry, flags: Flags, projectKey: string): Promise<void> {
  const current = await fetchAuthConfig(flags, projectKey);
  const body: Record<string, unknown> = { ...current, ...desiredAuthFields(desired) };
  if (body.isOidcEnabled) {
    body.accountActivationPath = OIDC_ACTIVATION_PATH;
    if (desired.accountActionBaseUrl === undefined) body.accountActionBaseUrl = await iamAccountActionBaseUrl(flags);
  }
  await blocksRequest<unknown>("/iam/v4/auth/config", { body, ...projectAuth(flags, projectKey) });
}
