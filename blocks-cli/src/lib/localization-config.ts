import { resolve } from "node:path";
import { mergedKeys } from "../commands/localization/push.js";
import {
  findLocalizationModuleId,
  generateUilmFile,
  getLocalizationKeysByNames,
  resolveLocalizationModuleId,
  saveLocalizationKeys
} from "./localization-api.js";
import { readLocalizationDictionary, validateLocalizationDictionary, type LocalizationDictionary } from "./localization-files.js";
import type { LocalizationModuleEntry } from "./project-file.js";
import type { PlanItem } from "./project-plan.js";

/**
 * The localization area of the project file (decision 0007 §3, §7, build step 3). One plan
 * item per module and language: its dictionary file against the keys the module stores.
 * Planning reads with `Module/Gets` and `Key/GetsByKeyNames` only. Apply writes through
 * the same save path as `localization push` (merging one culture into each stored key), but
 * only the keys that differ, with publishing off, then regenerates each touched module's
 * UILM file once (`--publish once`, the default). Keys the file omits are never deleted.
 */

type Flags = Record<string, string | boolean>;

export type DictionaryTarget = {
  dictionary: LocalizationDictionary;
  file: string;
  language: string;
  moduleName: string;
  publish: "once" | "none";
};

export type LocalizationPlan = {
  items: PlanItem[];
  /** The keys apply writes, by item name `module/language`. */
  pending: Map<string, { keys: LocalizationDictionary; moduleExists: boolean; target: DictionaryTarget }>;
};

const KEY_BATCH = 200;
const LISTED_KEYS = 8;

export function dictionaryItemName(moduleName: string, language: string): string {
  return `${moduleName}/${language}`;
}

export function expandPattern(pattern: string, moduleName: string, language: string): string {
  return pattern.split("{module}").join(moduleName).split("{language}").join(language);
}

/** Reads and validates every dictionary file the section names. Fails once with every problem. */
export async function readDictionaryTargets(
  modules: LocalizationModuleEntry[],
  root: string,
  defaultFolder: string
): Promise<DictionaryTarget[]> {
  const targets: DictionaryTarget[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of modules) {
    for (const language of entry.languages) {
      const name = dictionaryItemName(entry.name, language);
      if (seen.has(name)) { errors.push(`localization.modules: '${name}' appears more than once`); continue; }
      seen.add(name);
      const file = resolve(root, entry.files ? expandPattern(entry.files, entry.name, language) : `${defaultFolder}/${entry.name}.${language}.json`);
      try {
        const dictionary = await readLocalizationDictionary(file);
        const problems = validateLocalizationDictionary(dictionary, entry.name);
        for (const problem of problems) errors.push(`${name}: ${problem}`);
        targets.push({ dictionary, file, language, moduleName: entry.name, publish: entry.publish ?? "once" });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        errors.push(`${name}: ${code === "ENOENT" ? "dictionary file does not exist" : (error as Error).message}`);
      }
    }
  }
  if (errors.length) throw new Error(`Localization validation failed:\n${errors.map((error) => `  ${error}`).join("\n")}`);
  return targets;
}

type StoredKey = Record<string, unknown>;

function storedValue(row: StoredKey | undefined, language: string): string | undefined {
  const resources = row && Array.isArray(row.resources) ? row.resources : [];
  for (const resource of resources) {
    if (resource && typeof resource === "object") {
      const record = resource as Record<string, unknown>;
      if (typeof record.culture === "string" && record.culture.toLowerCase() === language.toLowerCase()) {
        return typeof record.value === "string" ? record.value : undefined;
      }
    }
  }
  return undefined;
}

/** Splits a dictionary against the stored keys: names to create and names whose value differs. Values are never returned. */
export function diffDictionary(dictionary: LocalizationDictionary, language: string, stored: Map<string, StoredKey>): { created: string[]; updated: string[] } {
  const created: string[] = [];
  const updated: string[] = [];
  for (const [name, value] of Object.entries(dictionary)) {
    const row = stored.get(name);
    if (!row) created.push(name);
    else if (storedValue(row, language) !== value) updated.push(name);
  }
  return { created, updated };
}

function changeList(created: string[], updated: string[]): string[] {
  const all = [...created.map((name) => `+${name}`), ...updated.map((name) => `~${name}`)];
  return all.length > LISTED_KEYS ? [...all.slice(0, LISTED_KEYS), `(+${all.length - LISTED_KEYS} more key(s))`] : all;
}

async function storedKeys(names: string[], moduleId: string, flags: Flags, tenant: string): Promise<Map<string, StoredKey>> {
  const stored = new Map<string, StoredKey>();
  for (let index = 0; index < names.length; index += KEY_BATCH) {
    for (const [name, row] of await getLocalizationKeysByNames(names.slice(index, index + KEY_BATCH), moduleId, flags, tenant)) stored.set(name, row);
  }
  return stored;
}

export async function computeLocalizationPlan(targets: DictionaryTarget[], flags: Flags, tenant: string): Promise<LocalizationPlan> {
  const items: PlanItem[] = [];
  const pending: LocalizationPlan["pending"] = new Map();
  const moduleIds = new Map<string, string | undefined>();

  for (const target of targets) {
    const name = dictionaryItemName(target.moduleName, target.language);
    if (!moduleIds.has(target.moduleName)) moduleIds.set(target.moduleName, await findLocalizationModuleId(target.moduleName, flags, tenant));
    const moduleId = moduleIds.get(target.moduleName);
    const keyCount = Object.keys(target.dictionary).length;

    if (!moduleId) {
      items.push({ action: "create", area: "localization", changes: changeList(Object.keys(target.dictionary), []), kind: "dictionary", name, note: `new module; ${keyCount} key(s)` });
      pending.set(name, { keys: target.dictionary, moduleExists: false, target });
      continue;
    }
    const stored = await storedKeys(Object.keys(target.dictionary), moduleId, flags, tenant);
    const { created, updated } = diffDictionary(target.dictionary, target.language, stored);
    if (created.length === 0 && updated.length === 0) {
      items.push({ action: "unchanged", area: "localization", kind: "dictionary", name });
      continue;
    }
    items.push({ action: "update", area: "localization", changes: changeList(created, updated), kind: "dictionary", name, note: `${created.length} new, ${updated.length} changed of ${keyCount} key(s)` });
    const keys: LocalizationDictionary = {};
    for (const keyName of [...created, ...updated]) keys[keyName] = target.dictionary[keyName];
    pending.set(name, { keys, moduleExists: true, target });
  }
  return { items, pending };
}

/** Saves one dictionary's differing keys, unpublished. Returns the module id, for the UILM regeneration. */
export async function writeDictionary(
  entry: { keys: LocalizationDictionary; target: DictionaryTarget },
  flags: Flags,
  tenant: string
): Promise<string> {
  const { keys, target } = entry;
  const moduleId = await resolveLocalizationModuleId(target.moduleName, flags, tenant, { createIfMissing: true });
  const merged = await mergedKeys(keys, moduleId, target.language, flags, tenant, { lookup: true, mode: "none" });
  await saveLocalizationKeys(merged.keys, flags, tenant);
  return moduleId;
}

export async function regenerateModule(moduleName: string, flags: Flags, tenant: string): Promise<void> {
  const moduleId = await resolveLocalizationModuleId(moduleName, flags, tenant, { createIfMissing: false });
  await generateUilmFile(moduleId, flags, tenant);
}
