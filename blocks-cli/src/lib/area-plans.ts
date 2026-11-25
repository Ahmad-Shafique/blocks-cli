import { computeAuthPlan, type AuthPlan } from "./auth-config.js";
import { computeStoragePlan, type StoragePlan } from "./storage-config.js";
import { computeOidcPlan, type OidcPlan } from "./oidc-config.js";
import { computeDataPlan, type DataPlan } from "./data-plan.js";
import { computeIamPlan, type IamPlan } from "./iam-config.js";
import { computeLocalizationPlan, readDictionaryTargets, type LocalizationPlan } from "./localization-config.js";
import { MANAGED_AREAS, type LoadedProjectFile } from "./project-file.js";
import type { PlanItem } from "./project-plan.js";
import { findWorkspace, pathsFromWorkspace } from "./workspace.js";

/**
 * Every managed area of the project file, planned in the order apply writes them (IAM,
 * data, localization; decision 0007 §5). Shared by `blocks plan` and `blocks apply`, so
 * apply writes exactly what the plan compared.
 */
export type ManagedArea = (typeof MANAGED_AREAS)[number];

export type AreaPlans = {
  areas: ManagedArea[];
  auth?: AuthPlan;
  data?: DataPlan;
  iam?: IamPlan;
  items: PlanItem[];
  localization?: LocalizationPlan;
  oidc?: OidcPlan;
  storage?: StoragePlan;
};

export const AREA_ORDER: readonly ManagedArea[] = ["iam", "data", "auth", "storage", "localization"];

export function managedAreas(document: LoadedProjectFile["document"]): ManagedArea[] {
  return AREA_ORDER.filter((area) => document[area] !== undefined);
}

export async function computeAreaPlans(
  loaded: LoadedProjectFile,
  flags: Record<string, string | boolean>,
  tenant: string,
  notes: string[]
): Promise<AreaPlans> {
  const { document } = loaded;
  const areas = managedAreas(document);
  const plans: AreaPlans = { areas, items: [] };

  if (document.iam) {
    plans.iam = await computeIamPlan(flags, tenant, { permissions: document.iam.permissions ?? [], roles: document.iam.roles ?? [] });
    plans.items.push(...plans.iam.items);
  }
  if (document.data) {
    plans.data = await computeDataPlan(loaded, flags, tenant, notes);
    plans.items.push(...plans.data.items);
  }
  if (document.auth?.config) {
    plans.auth = await computeAuthPlan(flags, tenant, document.auth.config);
    plans.items.push(...plans.auth.items);
  }
  if (document.auth?.oidcClients) {
    plans.oidc = await computeOidcPlan(flags, tenant, document.auth.oidcClients);
    plans.items.push(...plans.oidc.items);
  }
  if (document.storage?.configs) {
    plans.storage = await computeStoragePlan(flags, tenant, document.storage.configs);
    plans.items.push(...plans.storage.items);
  }
  if (document.localization) {
    const workspace = await findWorkspace();
    const folder = pathsFromWorkspace(workspace?.config ?? {}).dictionaries;
    const targets = await readDictionaryTargets(document.localization.modules ?? [], loaded.root, folder);
    plans.localization = await computeLocalizationPlan(targets, flags, tenant);
    plans.items.push(...plans.localization.items);
  }
  return plans;
}
