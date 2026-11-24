import { dirname, join } from "node:path";
import { booleanFlag, stringFlag } from "../../lib/args.js";
import { assertAgentMayWrite, assertTenantMatchesWorkspace } from "../../lib/apply-guards.js";
import { briefError, latestJournal, newJournal, saveJournal, type Journal } from "../../lib/apply-journal.js";
import { computeAreaPlans, managedAreas, type AreaPlans } from "../../lib/area-plans.js";
import { confirmMutation } from "../../lib/confirm.js";
import { displayPath, type DataPlan } from "../../lib/data-plan.js";
import { policyIdsByName, schemaIdsByName, writePolicy, writeSchema, writeSecurity } from "../../lib/data-apply.js";
import { reloadDataGateway } from "../../lib/data-gateway.js";
import { CliActionableError } from "../../lib/errors.js";
import { addRolePermissions, iamIdsBySlugAndName, rolesParentsFirst, writePermission, writeRole } from "../../lib/iam-config.js";
import { regenerateModule, writeDictionary } from "../../lib/localization-config.js";
import { writeAuthConfig } from "../../lib/auth-config.js";
import { loadProjectFile, MANAGED_AREAS, RESERVED_AREAS } from "../../lib/project-file.js";
import {
  hasChanges,
  renderPlanLines,
  renderSummary,
  securityEntryName,
  summarize,
  type PlanItem
} from "../../lib/project-plan.js";
import { runReadOnly } from "../../lib/read-only-requests.js";
import { findWorkspace, parseCommand, selectedProject } from "../../lib/workspace.js";

/**
 * `blocks apply` (decision 0007 §5, build steps 2 to 4: the data, iam, auth and localization
 * areas). A dry run unless `--write` is given: `--write` is its own flag, separate from
 * `--yes`, and nothing else turns a write on. `--write --dry-run` is a dry run. The dry run
 * and the plan that decides what to write both run inside `runReadOnly`, so a bug there
 * fails before a request leaves the machine.
 *
 * Areas are written in this order: iam (permissions, roles parents first, role permissions
 * added), data (schemas, security entries, policies, then one gateway reload), auth (the
 * configuration document, saved once), localization
 * (dictionaries saved unpublished, then one UILM regeneration per touched module).
 *
 * Exit codes: 0 nothing to do (or applied and the project now matches), 2 a dry run found
 * changes, 1 an error, a failed step, or a project that still differs after the write.
 */
export async function apply(argv: string[]): Promise<void> {
  const { flags } = parseCommand(argv);
  const writeAllowed = booleanFlag(flags, "write") && !booleanFlag(flags, "dry-run");

  const loaded = await loadProjectFile({
    env: stringFlag(flags, "env") || undefined,
    file: stringFlag(flags, "file") || undefined
  });
  const { document } = loaded;
  const notCompared = RESERVED_AREAS.filter((area) => document[area] !== undefined);

  const fileTenant = document.project?.tenantId;
  const flagTenant = stringFlag(flags, "project");
  if (fileTenant && flagTenant && fileTenant !== flagTenant) {
    throw new CliActionableError(
      `The project file names tenant '${fileTenant}', but --project is '${flagTenant}'.`,
      "apply_tenant_mismatch",
      "Drop --project, or change project.tenantId in the file (or its overlay)."
    );
  }
  const areas = managedAreas(document);
  if (areas.length === 0) {
    console.log(`The file manages no area that apply covers yet (${MANAGED_AREAS.join(", ")}); nothing was changed.`);
    process.exitCode = 0;
    return;
  }
  const tenant = fileTenant || await selectedProject(flags);
  await assertTenantMatchesWorkspace(tenant, stringFlag(flags, "tenant"));
  // An agent's write to a non-local target is refused before any request, even the plan's reads.
  if (writeAllowed) await assertAgentMayWrite(flags);

  const notes: string[] = [];
  const before = await runReadOnly("blocks apply (plan)", () => computeAreaPlans(loaded, flags, tenant, notes));
  const summary = summarize(before.items);
  const changes = hasChanges(before.items);
  const blocked = before.items.filter((item) => item.action === "blocked");
  const toWrite = before.items.filter((item) => item.action === "create" || item.action === "update");

  const heading = `blocks apply: ${displayPath(loaded.baseFile)}${loaded.overlayFile ? ` + ${displayPath(loaded.overlayFile)}` : ""}, tenant ${tenant}`;
  const json = booleanFlag(flags, "json");
  const workspace = await findWorkspace();
  const logsDir = join(workspace ? dirname(workspace.path) : loaded.root, "logs");
  const previous = await latestJournal(logsDir, tenant);
  const reloadPending = previous?.reloadPending === true && areas.includes("data");
  const uilmPending = areas.includes("localization") ? [...(previous?.uilmPending ?? [])] : [];

  // ---- dry run (the default)
  if (!writeAllowed) {
    const message = "Dry run: nothing was changed. Re-run with --write to apply.";
    if (json) {
      console.log(JSON.stringify({ changes, dryRun: true, items: before.items, notCompared, notes, reloadPending, summary, tenant, uilmPending }, null, 2));
    } else {
      console.log(message);
      console.log(heading);
      for (const area of areas) {
        console.log(`Area ${area}`);
        const lines = renderPlanLines(before.items.filter((item) => item.area === area));
        for (const line of lines) console.log(line);
        if (lines.length === 0) console.log("  (nothing in the file or the project)");
      }
      if (reloadPending) console.log("The last apply wrote data but did not reload the gateway; --write reloads it.");
      if (uilmPending.length) console.log(`The last apply saved localization keys but did not regenerate the UILM file of: ${uilmPending.join(", ")}; --write does it.`);
      if (notCompared.length) console.log(`Not applied yet (apply covers ${MANAGED_AREAS.join(", ")} only): ${notCompared.join(", ")}`);
      for (const note of notes) console.log(note);
      console.log(renderSummary(summary));
    }
    process.exitCode = changes ? 2 : 0;
    return;
  }

  // ---- write: refuse before anything is written
  if (blocked.length) {
    throw new CliActionableError(
      `Nothing was written: ${blocked.length} item(s) are blocked:\n${blocked.map((item) => `  ! ${item.kind} ${item.name}${item.note ? ` (${item.note})` : ""}`).join("\n")}`,
      "apply_blocked",
      "Fix the file or the project, then run blocks apply again."
    );
  }
  if (toWrite.length === 0 && !reloadPending && uilmPending.length === 0) {
    if (json) console.log(JSON.stringify({ changes: false, dryRun: false, items: before.items, written: 0, summary, tenant }, null, 2));
    else {
      console.log(heading);
      console.log(`Nothing to write: the project already matches the file. ${renderSummary(summary)}`);
    }
    process.exitCode = 0;
    return;
  }

  await confirmMutation(
    flags,
    `Apply the project file to tenant '${tenant}': ${summary.create} create, ${summary.update} update (${areas.join(", ")}). Nothing is deleted${areas.includes("iam") ? "; role permissions are only added, never removed" : ""}${areas.includes("data") ? "; the data gateway is reloaded after the data writes" : ""}.`
  );

  const journal = newJournal(tenant);
  journal.reloadPending = reloadPending;
  journal.uilmPending = uilmPending;
  const written = await writeAll(before, toWrite, tenant, flags, journal, logsDir);
  const journalFile = journal.file ? displayPath(journal.file) : undefined;

  if (written.failure) {
    if (written.dataWrote > 0) journal.reloadPending = true;
    journal.finishedAt = new Date().toISOString();
    await saveJournal(logsDir, journal);
    throw new CliActionableError(
      `Apply stopped at ${written.failure.kind} ${written.failure.name}: ${briefError(written.failure.error)}. ${written.wrote} resource(s) were written first; later steps did not run${areas.includes("data") ? ", and the gateway was not reloaded" : ""}. Nothing was rolled back.`,
      "apply_step_failed",
      `Fix the cause and run 'blocks apply --write' again: finished resources show '=' and are skipped. Journal: ${journalFile}.`
    );
  }

  // The gateway reloads once, only after every write succeeded (as `data sync` orders it).
  let reloaded: "ok" | "failed" | "not-needed" = "not-needed";
  if (areas.includes("data") && (written.dataWrote > 0 || reloadPending)) {
    try {
      await reloadDataGateway(flags, tenant);
      reloaded = "ok";
      journal.reloadPending = false;
    } catch (error) {
      reloaded = "failed";
      journal.reloadPending = true;
      console.error(`Warning: the data was written but the gateway reload failed (${briefError(error)}). Run 'blocks apply --write' again, or 'blocks data reload --yes'.`);
    }
  }
  // Each touched module's UILM file is regenerated once, after all of its languages are saved.
  const uilm = await regenerateTouchedModules(journal, flags, tenant, logsDir);
  journal.finishedAt = new Date().toISOString();
  await saveJournal(logsDir, journal);

  // Step 9: plan again, and say plainly whether the project now matches.
  const afterNotes: string[] = [];
  const after = await runReadOnly("blocks apply (check)", () => computeAreaPlans(loaded, flags, tenant, afterNotes));
  const residual = hasChanges(after.items);
  const afterSummary = summarize(after.items);

  if (json) {
    console.log(JSON.stringify({ dryRun: false, journal: journalFile, notCompared, reload: reloaded, residual: residual ? after.items.filter((item) => item.action !== "unchanged" && item.action !== "not-in-file") : [], summary: afterSummary, tenant, uilm, written: journal.entries.filter((entry) => entry.status === "ok") }, null, 2));
  } else {
    console.log(heading);
    for (const entry of journal.entries) console.log(`  ${entry.status === "ok" ? "done" : "FAILED"} ${entry.action} ${entry.kind} ${entry.name}`);
    if (areas.includes("data")) console.log(`Gateway reload: ${reloaded}.`);
    if (areas.includes("localization")) console.log(`UILM regeneration: ${uilm}.`);
    console.log(`Journal: ${journalFile}.`);
    if (notCompared.length) console.log(`Not applied yet (apply covers ${MANAGED_AREAS.join(", ")} only): ${notCompared.join(", ")}`);
    console.log(residual ? `The project still differs from the file. ${renderSummary(afterSummary)}` : `The project now matches the file. ${renderSummary(afterSummary)}`);
  }
  process.exitCode = residual || reloaded === "failed" || uilm === "failed" ? 1 : 0;
}

type Flags = Record<string, string | boolean>;
type Failure = { error: unknown; kind: string; name: string } | undefined;
type WriteOutcome = { dataWrote: number; failure?: NonNullable<Failure>; wrote: number };
type Runner = (item: PlanItem, task: () => Promise<void>) => Promise<Failure>;

/** A step runner: records the item in the journal (rewritten after every success) and turns a failure into a value. */
function makeRunner(area: string, journal: Journal, logsDir: string, counter: { wrote: number }): Runner {
  return async (item, task) => {
    const entry = { action: item.action, area, kind: item.kind, name: item.name };
    try {
      await task();
      journal.entries.push({ ...entry, status: "ok" });
      counter.wrote += 1;
      await saveJournal(logsDir, journal);
      return undefined;
    } catch (error) {
      journal.entries.push({ ...entry, error: briefError(error), status: "failed" });
      return { error, kind: item.kind, name: item.name };
    }
  };
}

/** Applies create and update items area by area: iam, then data, then localization. Stops at the first failure. */
async function writeAll(
  plans: AreaPlans,
  toWrite: PlanItem[],
  tenant: string,
  flags: Flags,
  journal: Journal,
  logsDir: string
): Promise<WriteOutcome> {
  const counters = { auth: { wrote: 0 }, data: { wrote: 0 }, iam: { wrote: 0 }, localization: { wrote: 0 } };
  const outcome = (failure?: Failure): WriteOutcome => ({
    dataWrote: counters.data.wrote,
    ...(failure ? { failure } : {}),
    wrote: counters.data.wrote + counters.iam.wrote + counters.auth.wrote + counters.localization.wrote
  });
  const itemsOf = (area: PlanItem["area"]) => toWrite.filter((item) => item.area === area);

  if (plans.iam) {
    const failure = await writeIam(plans, itemsOf("iam"), tenant, flags, makeRunner("iam", journal, logsDir, counters.iam));
    if (failure) return outcome(failure);
  }
  if (plans.data) {
    const failure = await writeData(plans.data, itemsOf("data"), tenant, flags, makeRunner("data", journal, logsDir, counters.data));
    if (failure) return outcome(failure);
  }
  if (plans.auth) {
    const failure = await writeAuth(plans, itemsOf("auth"), tenant, flags, makeRunner("auth", journal, logsDir, counters.auth));
    if (failure) return outcome(failure);
  }
  if (plans.localization) {
    const failure = await writeLocalization(plans, itemsOf("localization"), tenant, flags, makeRunner("localization", journal, logsDir, counters.localization), journal);
    if (failure) return outcome(failure);
  }
  return outcome();
}

/** Permissions first, then roles parents-first, then each role's missing permissions (added only). */
async function writeIam(plans: AreaPlans, toWrite: PlanItem[], tenant: string, flags: Flags, run: Runner): Promise<Failure> {
  const iam = plans.iam;
  if (!iam || toWrite.length === 0) return undefined;
  const wanted = (kind: PlanItem["kind"]) => new Map(toWrite.filter((item) => item.kind === kind).map((item) => [item.name, item]));
  const permissionItems = wanted("permission");
  const roleItems = wanted("role");
  let ids = await iamIdsBySlugAndName(flags, tenant);

  for (const permission of iam.desired.permissions) {
    const item = permissionItems.get(permission.name);
    if (!item) continue;
    const failed = await run(item, () => writePermission(permission, item.action === "update" ? ids.permissions.get(permission.name) : undefined, flags, tenant));
    if (failed) return failed;
  }
  if (permissionItems.size) ids = await iamIdsBySlugAndName(flags, tenant);

  for (const role of rolesParentsFirst(iam.desired.roles)) {
    const item = roleItems.get(role.slug);
    if (!item) continue;
    const fieldChange = item.action === "create" || (item.changes ?? []).some((change) => !change.startsWith("permissions"));
    const missing = iam.missingPermissions.get(role.slug) ?? [];
    const failed = await run(item, async () => {
      if (fieldChange) await writeRole(role, item.action === "update" ? ids.roles.get(role.slug) : undefined, flags, tenant);
      if (missing.length) await addRolePermissions(role.slug, missing, flags, tenant);
    });
    if (failed) return failed;
    if (item.action === "create") ids = await iamIdsBySlugAndName(flags, tenant);
  }
  return undefined;
}

/** The auth configuration: one document, merged over the stored one and saved once. */
async function writeAuth(plans: AreaPlans, toWrite: PlanItem[], tenant: string, flags: Flags, run: Runner): Promise<Failure> {
  const auth = plans.auth;
  const item = toWrite.find((candidate) => candidate.kind === "config");
  if (!auth || !item) return undefined;
  return run(item, () => writeAuthConfig(auth.desired, flags, tenant));
}

/** Saves each differing dictionary unpublished, and remembers which modules need a UILM regeneration. */
async function writeLocalization(plans: AreaPlans, toWrite: PlanItem[], tenant: string, flags: Flags, run: Runner, journal: Journal): Promise<Failure> {
  const localization = plans.localization;
  if (!localization) return undefined;
  for (const item of toWrite) {
    const entry = localization.pending.get(item.name);
    if (!entry) continue;
    const failed = await run(item, async () => {
      await writeDictionary(entry, flags, tenant);
      if (entry.target.publish === "once") {
        const pending = new Set(journal.uilmPending ?? []);
        pending.add(entry.target.moduleName);
        journal.uilmPending = [...pending];
      }
    });
    if (failed) return failed;
  }
  return undefined;
}

/** Regenerates each pending module's UILM file once, after all its languages are saved. */
async function regenerateTouchedModules(journal: Journal, flags: Flags, tenant: string, logsDir: string): Promise<"ok" | "failed" | "not-needed"> {
  const pending = [...(journal.uilmPending ?? [])];
  if (pending.length === 0) return "not-needed";
  let failedAny = false;
  for (const moduleName of pending) {
    const entry = { action: "regenerate", area: "localization", kind: "uilm", name: moduleName };
    try {
      await regenerateModule(moduleName, flags, tenant);
      journal.entries.push({ ...entry, status: "ok" });
      journal.uilmPending = (journal.uilmPending ?? []).filter((name) => name !== moduleName);
    } catch (error) {
      failedAny = true;
      journal.entries.push({ ...entry, error: briefError(error), status: "failed" });
      console.error(`Warning: localization keys of '${moduleName}' were saved but its UILM file was not regenerated (${briefError(error)}). Run 'blocks apply --write' again.`);
    }
    await saveJournal(logsDir, journal);
  }
  return failedAny ? "failed" : "ok";
}

/** Applies create and update items for the data area in order: schemas, security entries, policies. */
async function writeData(plan: DataPlan, toWrite: PlanItem[], tenant: string, flags: Flags, run: Runner): Promise<Failure> {
  const { desired } = plan;
  const wanted = (kind: PlanItem["kind"]) => new Map(toWrite.filter((item) => item.kind === kind).map((item) => [item.name, item]));
  const schemaItems = wanted("schema");
  const securityItems = wanted("security");
  const policyItems = wanted("policy");

  for (const schema of desired.schemas) {
    const item = schemaItems.get(String(schema.schemaName));
    if (!item) continue;
    const failed = await run(item, async () => { await writeSchema(schema, tenant, flags, desired.newSchemaAccess); });
    if (failed) return failed;
  }

  if (securityItems.size === 0 && policyItems.size === 0) return undefined;

  let schemaIds: Map<string, string>;
  try {
    schemaIds = await schemaIdsByName(flags, tenant);
  } catch (error) {
    const item = [...securityItems.values(), ...policyItems.values()][0];
    return run(item, async () => { throw error; });
  }

  for (const entry of desired.security) {
    const item = securityItems.get(securityEntryName(entry));
    if (!item) continue;
    const failed = await run(item, () => writeSecurity(entry, schemaIds, tenant, flags));
    if (failed) return failed;
  }

  const policyIds = new Map<string, Map<string, string>>();
  for (const policy of desired.policies) {
    const schemaName = String(policy.schemaName ?? "");
    const policyName = String(policy.policyName ?? "");
    const item = policyItems.get(`${schemaName}/${policyName}`);
    if (!item) continue;
    const failed = await run(item, async () => {
      if (!policyIds.has(schemaName)) policyIds.set(schemaName, await policyIdsByName(flags, tenant, schemaName));
      await writePolicy(policy, schemaIds, policyIds.get(schemaName)?.get(policyName), tenant, flags);
    });
    if (failed) return failed;
  }
  return undefined;
}
