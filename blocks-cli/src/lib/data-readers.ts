import { blocksRequest } from "./api.js";
import { unwrapDataArray, unwrapSchemaListResponse } from "./data-response.js";
import { requestContext } from "./request-context.js";

/**
 * The server-side read half of the `data` commands, shared by `data schema pull`,
 * `data rules pull` and `blocks plan` (decision 0007 §7: commands are reused as library
 * functions, and a command that only printed is refactored to return its result).
 * Both are GET-only.
 */

const SCHEMA_PAGE_SIZE = 500;

/** Every schema of the project, page by page (`GET /data/v4/schemas`). */
export async function fetchAllSchemas(
  flags: Record<string, string | boolean>,
  projectKey: string
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let pageNo = 1;
  let totalCount = Infinity;

  while (items.length < totalCount) {
    const response = await blocksRequest<unknown>("/data/v4/schemas", {
      impersonatedProjectAuth: true,
      ...requestContext(flags),
      projectTenantId: projectKey,
      query: { PageNo: pageNo, PageSize: SCHEMA_PAGE_SIZE, ProjectKey: projectKey }
    });
    const page = unwrapSchemaListResponse(response);
    totalCount = page.totalCount;
    if (page.items.length === 0) break;
    items.push(...page.items);
    pageNo += 1;
  }

  return items;
}

/** The data-access policies of one schema (`GET /data/v4/data-access/policy/get`), as the API returns them. */
export async function fetchSchemaPolicies(
  flags: Record<string, string | boolean>,
  projectKey: string,
  schemaName: string
): Promise<Record<string, unknown>[]> {
  const response = await blocksRequest<unknown>("/data/v4/data-access/policy/get", {
    impersonatedProjectAuth: true,
    ...requestContext(flags),
    projectTenantId: projectKey,
    query: { schemaName }
  });
  return unwrapDataArray(response, "data access policy");
}
