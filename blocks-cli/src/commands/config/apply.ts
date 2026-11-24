import { dirname, join } from "node:path";
import { booleanFlag, stringFlag } from "../../lib/args.js";
import { assertAgentMayWrite, assertTenantMatchesWorkspace } from "../../lib/apply-guards.js";
import { briefError, latestJournal, newJournal, saveJournal, type Journal } from "../../lib/apply-journal.js";
import { confirmMutation } from "../../lib/confirm.js";
import { computeDataPlan, displayPath, type DataPlan } from "../../lib/data-plan.js";
import { policyIdsByName, schemaIdsByName, writePolicy, writeSchema, writeSecurity } from "../../lib/data-apply.js";
import { reloadDataGateway } from "../../lib/data-gateway.js";
import { CliActionableError } from "../../lib/errors.js";
import { loadProjectFile, RESERVED_AREAS } from "../../lib/project-file.js";
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
 * `blocks apply` (decision 0007 §5, build step 2: the data area). A dry run unless
 * `--write` is given: `--write` is its own flag, separate from `--yes`, and nothing else
 * turns a write on. `--write --dry-run` is a dry run. The dry run and the plan that
 * decides what to write both run inside `runReadOnly`, so a bug there fails before a
 * request leaves the machine.
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
  if (!document.data) {
    console.log("The file manages no area that apply covers yet (data); nothing was changed.");
    process.exitCode = 0;
    return;
  }
  const tenant = fileTenant || await selectedProject(flags);
  await assertTenantMatchesWorkspace(tenant, stringFlag(flags, "tenant"));
  // An agent's write to a non-local target is refused before any request, even the plan's reads.
  if (writeAllowed) await assertAgentMayWrite(flags);

  const notes: string[] = [];
  const before = await runReadOnly("blocks apply (plan)", () => computeDataPlan(loaded, flags, tenant, notes));
  const summary = summarize(before.items);
  const changes = hasChanges(before.items);
  const blocked = before.items.filter((item) => item.action === "blocked");
  const toWrite = before.items.filter((item) => item.action === "create" || item.action === "update");

  const heading = `blocks apply: ${displayPath(loaded.baseFile)}${loaded.overlayFile ? ` + ${displayPath(loaded.overlayFile)}` : ""}, tenant ${tenant}`;
  const json = booleanFlag(flags, "json");
  const workspace = await findWorkspace();
  const logsDir = join(workspace ? dirname(workspace.path) : loaded.root, "logs");
  const previous = await latestJournal(logsDir, tenant);
  const reloadPending = previous?.reloadPending === true;

  // ---- dry run (the default)
  if (!writeAllowed) {
    const message = "Dry run: nothing was changed. Re-run with --write to apply.";
    if (json) {
      console.log(JSON.stringify({ changes, dryRun: true, items: before.items, notCompared, notes, reloadPending, summary, tenant }, null, 2));
    } else {
      console.log(message);
      console.log(heading);
      console.log("Area data");
      for (const line of renderPlanLines(before.items)) console.log(line);
      if (before.items.length === 0) console.log("  (no schemas or rules in the file or the project)");
      if (reloadPending) console.log("The last apply wrote data but did not reload the gateway; --write reloads it.");
      if (notCompared.length) console.log(`Not applied yet (apply covers data only): ${notCompared.join(", ")}`);
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
  if (toWrite.length === 0 && !reloadPending) {
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
    `Apply the project file to tenant '${tenant}': ${summary.create} create, ${summary.update} update (data schemas, policies and security entries), then reload the data gateway. Nothing is deleted.`
  );

  const journal = newJournal(tenant);
  journal.reloadPending = reloadPending;
  const written = await writeData(before, toWrite, tenant, flags, journal, logsDir);
  const journalFile = journal.file ? displayPath(journal.file) : undefined;

  if (written.failure) {
    if (written.wrote > 0) journal.reloadPending = true;
    journal.finishedAt = new Date().toISOString();
    await saveJournal(logsDir, journal);
    throw new CliActionableError(
      `Apply stopped at ${written.failure.kind} ${written.failure.name}: ${briefError(written.failure.error)}. ${written.wrote} resource(s) were written first; later steps did not run, and the gateway was not reloaded. Nothing was rolled back.`,
      "apply_step_failed",
      `Fix the cause and run 'blocks apply --write' again: finished resources show '=' and are skipped. Journal: ${journalFile}.`
    );
  }

  // The gateway reloads once, only after every write succeeded (as `data sync` orders it).
  let reloaded: "ok" | "failed" | "not-needed" = "not-needed";
  if (written.wrote > 0 || reloadPending) {
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
  journal.finishedAt = new Date().toISOString();
  await saveJournal(logsDir, journal);

  // Step 9: plan again, and say plainly whether the project now matches.
  const afterNotes: string[] = [];
  const after = await runReadOnly("blocks apply (check)", () => computeDataPlan(loaded, flags, tenant, afterNotes));
  const residual = hasChanges(after.items);
  const afterSummary = summarize(after.items);

  if (json) {
    console.log(JSON.stringify({ dryRun: false, journal: journalFile, notCompared, reload: reloaded, residual: residual ? after.items.filter((item) => item.action !== "unchanged" && item.action !== "not-in-file") : [], summary: afterSummary, tenant, written: journal.entries.filter((entry) => entry.status === "ok") }, null, 2));
  } else {
    console.log(heading);
    for (const entry of journal.entries) console.log(`  ${entry.status === "ok" ? "done" : "FAILED"} ${entry.action} ${entry.kind} ${entry.name}`);
    console.log(`Gateway reload: ${reloaded}. Journal: ${journalFile}.`);
    if (notCompared.length) console.log(`Not applied yet (apply covers data only): ${notCompared.join(", ")}`);
    console.log(residual ? `The project still differs from the file. ${renderSummary(afterSummary)}` : `The project now matches the file. ${renderSummary(afterSummary)}`);
  }
  process.exitCode = residual || reloaded === "failed" ? 1 : 0;
}

type WriteOutcome = { failure?: { error: unknown; kind: string; name: string }; wrote: number };

/** Applies create and update items in order: schemas, then security entries, then policies. Stops at the first failure. */
async function writeData(
  plan: DataPlan,
  toWrite: PlanItem[],
  tenant: string,
  flags: Record<string, string | boolean>,
  journal: Journal,
  logsDir: string
): Promise<WriteOutcome> {
  const { desired } = plan;
  const wanted = (kind: PlanItem["kind"]) => new Map(toWrite.filter((item) => item.kind === kind).map((item) => [item.name, item]));
  const schemaItems = wanted("schema");
  const securityItems = wanted("security");
  const policyItems = wanted("policy");
  let wrote = 0;

  const run = async (item: PlanItem, task: () => Promise<void>): Promise<WriteOutcome | undefined> => {
    const entry = { action: item.action, area: "data", kind: item.kind, name: item.name };
    try {
      await task();
      journal.entries.push({ ...entry, status: "ok" });
      wrote += 1;
      await saveJournal(logsDir, journal);
      return undefined;
    } catch (error) {
      journal.entries.push({ ...entry, error: briefError(error), status: "failed" });
      return { failure: { error, kind: item.kind, name: item.name }, wrote };
    }
  };

  for (const schema of desired.schemas) {
    const item = schemaItems.get(String(schema.schemaName));
    if (!item) continue;
    const failed = await run(item, async () => { await writeSchema(schema, tenant, flags, desired.newSchemaAccess); });
    if (failed) return failed;
  }

  if (securityItems.size === 0 && policyItems.size === 0) return { wrote };

  let schemaIds: Map<string, string>;
  try {
    schemaIds = await schemaIdsByName(flags, tenant);
  } catch (error) {
    const item = [...securityItems.values(), ...policyItems.values()][0];
    journal.entries.push({ action: item.action, area: "data", error: briefError(error), kind: item.kind, name: item.name, status: "failed" });
    return { failure: { error, kind: item.kind, name: item.name }, wrote };
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
  return { wrote };
}
