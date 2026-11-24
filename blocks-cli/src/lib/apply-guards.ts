import { stringFlag } from "./args.js";
import { getAccountProfile, readConfig } from "./config.js";
import { CliActionableError } from "./errors.js";
import { findWorkspace } from "./workspace.js";

/**
 * The checks `blocks apply --write` makes before it sends anything (decision 0007 §6, §9,
 * and the strategist's answers in §14): the tenant must be the workspace's own (or named
 * with --tenant), and an agent may write only to a local stack.
 */

/** True when the caller says it is an agent: BLOCKS_AGENT_TOKEN is set, or BLOCKS_AGENT is 1, true or yes. */
export function isAgentCaller(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.BLOCKS_AGENT_TOKEN ?? "").trim()) return true;
  return ["1", "true", "yes"].includes((env.BLOCKS_AGENT ?? "").trim().toLowerCase());
}

/** A development host: localhost, a loopback address, or a name ending in .localhost or .test. */
export function isLocalApiUrl(apiUrl: string): boolean {
  let host: string;
  try {
    host = new URL(apiUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost") || host.endsWith(".test");
}

export async function effectiveApiUrl(flags: Record<string, string | boolean>): Promise<string> {
  const fromFlag = stringFlag(flags, "api-url");
  if (fromFlag) return fromFlag;
  const config = await readConfig();
  return getAccountProfile(config, stringFlag(flags, "account") || undefined).profile.apiUrl;
}

/**
 * Refuses an agent's write to anything that is not a local stack (owner's answer 8).
 * Tenant branches do not exist in this build, so local is the only allowed target.
 */
export async function assertAgentMayWrite(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isAgentCaller(env)) return;
  const apiUrl = await effectiveApiUrl(flags);
  if (isLocalApiUrl(apiUrl)) return;
  let host = apiUrl;
  try { host = new URL(apiUrl).host; } catch { /* keep the raw value */ }
  throw new CliActionableError(
    `Refused: an agent may write only to a local stack, and the target ${host} is not one.`,
    "apply_agent_target_refused",
    "Run 'blocks apply' without --write to preview, and ask a person to run the write against this project."
  );
}

/**
 * The file's tenant must be the one blocks.json names, unless --tenant names it
 * explicitly (0007 §6; §14 answer 4). A --tenant that names another tenant is refused too.
 */
export async function assertTenantMatchesWorkspace(tenant: string, named: string): Promise<void> {
  if (named && named !== tenant) {
    throw new CliActionableError(
      `--tenant names '${named}', but the target tenant is '${tenant}'.`,
      "apply_tenant_flag_mismatch",
      "Make --tenant, project.tenantId in the file and --project agree."
    );
  }
  const workspaceTenant = (await findWorkspace())?.config.project?.tenantId;
  if (workspaceTenant && workspaceTenant !== tenant && named !== tenant) {
    throw new CliActionableError(
      `The project file targets tenant '${tenant}', but this workspace's blocks.json names '${workspaceTenant}'.`,
      "apply_tenant_mismatch",
      `If '${tenant}' is intended, pass --tenant ${tenant} explicitly.`
    );
  }
}
