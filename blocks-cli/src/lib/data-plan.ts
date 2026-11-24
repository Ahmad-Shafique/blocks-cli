import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { readRulesFile, readSchemaFiles, validateSchemas, validateSecurityEntries, type SchemaDocument } from "./data-files.js";
import { fetchAllSchemas, fetchSchemaPolicies } from "./data-readers.js";
import { CliActionableError } from "./errors.js";
import type { LoadedProjectFile } from "./project-file.js";
import { diffPolicies, diffSchemas, diffSecurity, type PlanItem } from "./project-plan.js";
import { findWorkspace, pathsFromWorkspace } from "./workspace.js";

/**
 * The data area of the project plan (decision 0007 §4), shared by `blocks plan` and
 * `blocks apply`: local files through the `data` readers, live state through the `data`
 * server readers (GET only). It also returns the desired documents, so `apply` writes
 * exactly what the plan compared.
 */
export type DataPlan = {
  items: PlanItem[];
  desired: {
    newSchemaAccess: "user" | "public";
    policies: Array<Record<string, unknown>>;
    rulesManaged: boolean;
    schemas: SchemaDocument[];
    security: Array<Record<string, unknown>>;
  };
};

export function displayPath(path: string): string {
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
export async function computeDataPlan(
  loaded: LoadedProjectFile,
  flags: Record<string, string | boolean>,
  projectKey: string,
  notes: string[]
): Promise<DataPlan> {
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

  const newSchemaAccess = data.newSchemaAccess ?? "user";
  const items = [
    ...diffSchemas(schemas.map(({ schema }) => schema), liveSchemas, newSchemaAccess),
    ...(rules ? diffPolicies(policies as Array<Record<string, unknown>>, livePolicies, liveSchemaNames, localSchemaNames) : []),
    ...(rules ? diffSecurity(security as Array<Record<string, unknown>>, liveSchemas, localSchemaNames) : [])
  ];
  return {
    desired: {
      newSchemaAccess,
      policies: policies as Array<Record<string, unknown>>,
      rulesManaged: rules !== undefined,
      schemas: schemas.map(({ schema }) => schema),
      security: security as Array<Record<string, unknown>>
    },
    items
  };
}
