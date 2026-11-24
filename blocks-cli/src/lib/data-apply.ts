import { blocksRequest } from "./api.js";
import { applyNewSchemaAccess, createdSchemaId, type NewSchemaAccess } from "./data-gateway.js";
import { fetchAllSchemas, fetchSchemaPolicies } from "./data-readers.js";
import { isRecord, unwrapSchemaListResponse } from "./data-response.js";
import type { SchemaDocument } from "./data-files.js";
import { requestContext } from "./request-context.js";

/**
 * The write half of the data area of `blocks apply` (decision 0007 §5 step 4, §7). It makes
 * the same requests as `data schema push` and `data rules deploy`, but one resource at a
 * time, so apply writes only what the plan says differs (§8) and `data sync`'s "push
 * everything" never happens. Callers pass a resource only when its plan action is create
 * or update. The gateway reload is a separate step (`reloadDataGateway`), run once.
 */
type Flags = Record<string, string | boolean>;

export async function writeSchema(schema: SchemaDocument, projectKey: string, flags: Flags, access: NewSchemaAccess): Promise<{ created: boolean }> {
  const schemaName = String(schema.schemaName);

  // The destination project's own copy is found by name; a local id may belong to another project.
  const existing = await blocksRequest<unknown>("/data/v4/schemas", {
    impersonatedProjectAuth: true,
    ...requestContext(flags),
    projectTenantId: projectKey,
    query: { PageNo: 1, PageSize: 5, ProjectKey: projectKey, SchemaName: schemaName }
  });
  const destination = unwrapSchemaListResponse(existing).items.find((item) => item.schemaName === schemaName);
  const destinationId = typeof destination?.id === "string" ? destination.id : undefined;

  const portable: Record<string, unknown> = { ...schema };
  delete portable.itemId;
  delete portable.id;
  const response = await blocksRequest<unknown>("/data/v4/schemas/define", {
    acceptFailureEnvelope: true,
    body: destinationId ? { ...portable, itemId: destinationId, projectKey } : { ...portable, projectKey },
    impersonatedProjectAuth: true,
    ...requestContext(flags),
    projectTenantId: projectKey,
    method: destinationId ? "PUT" : "POST"
  });
  if (response === undefined || response === null) throw new Error(`Push failed for schema '${schemaName}': the server returned an empty response.`);
  if (isRecord(response) && response.isSuccess === false) throw new Error(`Push failed for schema '${schemaName}': the server refused it.`);

  if (!destinationId) {
    const createdId = createdSchemaId(response);
    if (createdId) await applyNewSchemaAccess(createdId, projectKey, flags, access);
  }
  return { created: !destinationId };
}

/** Schema ids by name, read fresh after the schema writes. */
export async function schemaIdsByName(flags: Flags, projectKey: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const item of await fetchAllSchemas(flags, projectKey)) {
    if (typeof item.schemaName === "string" && typeof item.id === "string") ids.set(item.schemaName, item.id);
  }
  return ids;
}

export async function writeSecurity(entry: Record<string, unknown>, schemaIds: Map<string, string>, projectKey: string, flags: Flags): Promise<void> {
  const { schemaName, ...rest } = entry;
  const schemaId = typeof schemaName === "string" && schemaName ? schemaIds.get(schemaName) : rest.schemaId;
  if (!schemaId) throw new Error(`Security entry targets schema '${String(schemaName)}', which is not in project '${projectKey}'.`);
  await blocksRequest<unknown>("/data/v4/data-access/security/change", {
    body: { ...rest, schemaId, projectKey },
    impersonatedProjectAuth: true,
    ...requestContext(flags),
    projectTenantId: projectKey
  });
}

/** Existing policy ids of one schema, by policy name. */
export async function policyIdsByName(flags: Flags, projectKey: string, schemaName: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const item of await fetchSchemaPolicies(flags, projectKey, schemaName)) {
    if (typeof item.policyName === "string" && typeof item.itemId === "string") ids.set(item.policyName, item.itemId);
  }
  return ids;
}

export async function writePolicy(
  policy: Record<string, unknown>,
  schemaIds: Map<string, string>,
  existingItemId: string | undefined,
  projectKey: string,
  flags: Flags
): Promise<void> {
  const schemaName = String(policy.schemaName ?? "");
  const policyName = String(policy.policyName ?? "");
  const schemaId = schemaIds.get(schemaName);
  if (!schemaId) throw new Error(`Rule policy '${policyName}' targets unknown schema '${schemaName}' in project '${projectKey}'.`);

  // Fields are mapped explicitly: the portable format and the request DTOs use different names.
  const common = {
    fieldNames: policy.fieldNames,
    isAllowPolicy: policy.isAllowPolicy,
    policyDescription: policy.policyDescription,
    policyName,
    priority: policy.priority,
    projectKey,
    ruleGroup: policy.ruleGroup
  };
  if (existingItemId) {
    await blocksRequest<unknown>("/data/v4/data-access/policy/update", {
      body: { ...common, itemId: existingItemId },
      impersonatedProjectAuth: true,
      ...requestContext(flags),
      projectTenantId: projectKey
    });
  } else {
    await blocksRequest<unknown>("/data/v4/data-access/policy/create", {
      body: { ...common, operation: policy.operation, policyType: policy.policyType, schemaId, schemaName },
      impersonatedProjectAuth: true,
      ...requestContext(flags),
      projectTenantId: projectKey
    });
  }
}
