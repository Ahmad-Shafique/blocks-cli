import { toPortablePolicy, writeRulesFile } from "../../../lib/data-files.js";
import { fetchAllSchemas, fetchSchemaPolicies } from "../../../lib/data-readers.js";
import { writeOutput } from "../../../lib/output.js";
import { parseCommand, selectedProject } from "../../../lib/workspace.js";

export async function dataRulesPull(argv: string[]): Promise<void> {
  const { flags } = parseCommand(argv);
  const projectKey = await selectedProject(flags);
  const schemas = await fetchAllSchemas(flags, projectKey);

  const policies: unknown[] = [];
  for (const schema of schemas) {
    const schemaName = schema.schemaName;
    if (typeof schemaName !== "string" || !schemaName) continue;
    for (const item of await fetchSchemaPolicies(flags, projectKey, schemaName)) {
      policies.push(toPortablePolicy(item, schemaName));
    }
  }

  const file = await writeRulesFile({ policies });
  writeOutput({ count: policies.length, file }, flags);
}
