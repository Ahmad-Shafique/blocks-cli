import { writeOutput } from "../../../lib/output.js";
import { toPortableSchema, writeSchemaFile } from "../../../lib/data-files.js";
import { fetchAllSchemas } from "../../../lib/data-readers.js";
import { parseCommand, selectedProject } from "../../../lib/workspace.js";

export async function dataSchemaPull(argv: string[]): Promise<void> {
  const { flags } = parseCommand(argv);
  const projectKey = await selectedProject(flags);
  const items = await fetchAllSchemas(flags, projectKey);

  const files: string[] = [];
  for (const schema of items) {
    files.push(await writeSchemaFile(toPortableSchema(schema)));
  }

  writeOutput({ files, count: files.length }, flags);
}
