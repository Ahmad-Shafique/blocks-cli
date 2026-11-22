import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { stringFlag } from "../../lib/args.js";
import { readRulesFile, readSchemaFiles, validateSchemas, validateSecurityEntries } from "../../lib/data-files.js";
import { fetchAllSchemas, fetchSchemaPolicies } from "../../lib/data-readers.js";
import { CliActionableError } from "../../lib/errors.js";
import { loadProjectFile, RESERVED_AREAS, type LoadedProjectFile } from "../../lib/project-file.js";
import {
  diffPolicies,
  diffSchemas,
  diffSecurity,
  hasChanges,
  renderPlanLines,
  renderSummary,
  summarize,
  type PlanItem
} from "../../lib/project-plan.js";
import { runReadOnly } from "../../lib/read-only-requests.js";
import { findWorkspace, parseCommand, pathsFromWorkspace, selectedProject } from "../../lib/workspace.js";

/**
 * `blocks plan`: compare the project file with the live project and print the difference
 * (decision 0007 §4; build step 1 covers the data area only). Read-only: it runs inside
 * `runReadOnly`, so any non-GET request throws before it is sent, and it writes nothing.
 *
 * Exit codes (as `terraform plan -detailed-exitcode`): 0 no changes, 2 changes, 1 error.
 */
export async function plan(argv: string[]): Promise<void> {
  await runReadOnly("blocks plan", () => planReadOnly(argv));
}

async function planReadOnly(argv: string[]): Promise<void> {
  const { flags } = parseCommand(argv);
  const loaded = await loadProjectFile({
    env: stringFlag(flags, "env") || undefined,
    file: stringFlag(flags, "file") || undefined
  });
  const { document } = loaded;

  const notCompared = RESERVED_AREAS.filter((area) => document[area] !== undefined);
  const items: PlanItem[] = [];
  let tenant: string | undefined;
  const notes: string[] = [];

  if (document.data) {
    const fileTenant = document.project?.tenantId;
    const flagTenant = stringFlag(flags, "project");
    if (fileTenant && flagTenant && fileTenant !== flagTenant) {
      throw new CliActionableError(
        `The project file names tenant '${fileTenant}', but --project is '${flagTenant}'.`,
        "plan_tenant_mismatch",
        "Drop --project, or change project.tenantId in the file (or its overlay)."
      );
    }
    tenant = fileTenant || await selectedProject(flags);
    items.push(...await planData(loaded, flags, tenant, notes));
  } else {
    notes.push("The file manages no area that plan compares yet (data); nothing was read from the server.");
  }

  const summary = summarize(items);
  const changes = hasChanges(items);
  const result = {
    changes,
    env: loaded.env ?? null,
    files: {
      base: displayPath(loaded.baseFile),
      ...(loaded.overlayFile ? { overlay: displayPath(loaded.overlayFile) } : {})
    },
    items,
    notCompared,
    notes,
    schemaVersion: document.schemaVersion,
    // Names and paths only: plan never reads a secret value.
    secretRefs: loaded.secretRefs,
    summary,
    tenant: tenant ?? null
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const files = [result.files.base, ...(loaded.overlayFile ? [displayPath(loaded.overlayFile)] : [])].join(" + ");
    console.log(`blocks plan: ${files} (schemaVersion ${document.schemaVersion})${tenant ? `, tenant ${tenant}` : ""}`);
    if (document.data) {
      console.log("Area data");
      for (const line of renderPlanLines(items)) console.log(line);
      if (items.length === 0) console.log("  (no schemas or rules in the file or the project)");
    }
    if (notCompared.length) console.log(`Not compared yet (plan covers data only): ${notCompared.join(", ")}`);
    if (loaded.secretRefs.length) {
      console.log(`Secret references: ${[...new Set(loaded.secretRefs.map((ref) => ref.name))].join(", ")} (names only; values are resolved in memory by apply, never by plan)`);
    }
    for (const note of notes) console.log(note);
    console.log(renderSummary(summary));
    console.log(changes ? "Changes found (exit code 2)." : "No changes (exit code 0).");
  }

  process.exitCode = changes ? 2 : 0;
}

function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The data area: local files through the `data` readers, live state through the `data` server readers (GET only). */
async function planData(
  loaded: LoadedProjectFile,
  flags: Record<string, string | boolean>,
  projectKey: string,
  notes: string[]
): Promise<PlanItem[]> {
  const data = loaded.document.data ?? {};
  const workspace = await findWorkspace();
  const defaults = pathsFromWorkspace(workspace?.config ?? {});
  const schemasDir = resolve(loaded.root, data.schemas ?? defaults.schemas);
  const rulesPath = resolve(loaded.root, data.rules ?? defaults.rules);

  if (data.schemas && !(await isDirectory(schemasDir))) {
    throw new CliActionableError(`data.schemas: folder ${displayPath(schemasDir)} does not exist.`, "project_file_invalid", "Fix the path (it is relative to the project file), or run 'blocks data schema pull'.");
  }

  const schemas = await readSchemaFiles(schemasDir);
  const errors = validateSchemas(schemas);
  const seen = new Map<string, string>();
  for (const { file, schema } of schemas) {
    const name = String(schema.schemaName ?? "");
    if (name && seen.has(name)) errors.push(`${file}: schemaName '${name}' is also defined in ${seen.get(name)}`);
    seen.set(name, file);
  }

  let rules: Record<string, unknown> | undefined;
  try {
    rules = await readRulesFile(rulesPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !data.rules) {
      notes.push(`No rules file at ${displayPath(rulesPath)}: data rules are not managed.`);
    } else {
      errors.push(`rules file ${displayPath(rulesPath)}: ${code === "ENOENT" ? "does not exist" : (error as Error).message}`);
    }
  }

  const policies = rules && Array.isArray(rules.policies) ? (rules.policies as unknown[]) : [];
  const security = rules && Array.isArray(rules.security) ? (rules.security as unknown[]) : [];
  if (rules) {
    if (rules.policies !== undefined && !Array.isArray(rules.policies)) errors.push("rules file: 'policies' must be an array");
    errors.push(...validateSecurityEntries(rules));
    policies.forEach((policy, index) => {
      const record = policy as Record<string, unknown>;
      if (typeof policy !== "object" || policy === null || Array.isArray(policy)) errors.push(`policies[${index}]: must be an object`);
      else if (!record.schemaName || !record.policyName) errors.push(`policies[${index}]: needs schemaName and policyName`);
    });
  }

  if (errors.length) {
    throw new CliActionableError(`Data model validation failed:\n${errors.map((error) => `  ${error}`).join("\n")}`, "data_validation_failed", "Fix the files, or run 'blocks data validate'.");
  }

  const liveSchemas = await fetchAllSchemas(flags, projectKey);
  const liveSchemaNames = new Set(liveSchemas.map((item) => item.schemaName).filter((name): name is string => typeof name === "string" && name.length > 0));
  const localSchemaNames = new Set(schemas.map(({ schema }) => String(schema.schemaName)));

  const livePolicies = new Map<string, Record<string, unknown>[]>();
  if (rules) {
    for (const schemaName of [...liveSchemaNames].sort()) {
      livePolicies.set(schemaName, await fetchSchemaPolicies(flags, projectKey, schemaName));
    }
  }

  return [
    ...diffSchemas(schemas.map(({ schema }) => schema), liveSchemas, data.newSchemaAccess ?? "user"),
    ...(rules ? diffPolicies(policies as Array<Record<string, unknown>>, livePolicies, liveSchemaNames, localSchemaNames) : []),
    ...(rules ? diffSecurity(security as Array<Record<string, unknown>>, liveSchemas, localSchemaNames) : [])
  ];
}
