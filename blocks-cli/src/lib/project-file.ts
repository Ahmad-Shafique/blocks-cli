import { access, readFile } from "node:fs/promises";
import { inspect } from "node:util";
import { basename, dirname, extname, join, resolve } from "node:path";
import { CliActionableError } from "./errors.js";
import { validateJsonSchema, type JsonSchema } from "./json-schema-lite.js";
import { findWorkspace } from "./workspace.js";
import { findDuplicateJsonKey, parseYamlLite, YamlLiteError } from "./yaml-lite.js";

/**
 * The project file of decision 0007 (`blocks.project.yaml`, or `.yml` / `.json`), with
 * one optional overlay per environment (`blocks.project.<env>.yaml`, owner's answer 6).
 *
 * Loading order, each step failing closed:
 * 1. parse each file (strict YAML subset or JSON; duplicate keys rejected);
 * 2. reject literal secrets in each file (field names and a high-entropy check, §9);
 * 3. merge the overlay over the base (mappings merge key by key; lists and scalars replace);
 * 4. validate the merged document against `schema/blocks.project.schema.json`;
 * 5. substitute `${env:NAME}` for non-secret values only.
 *
 * `secretRef` values are never read here. `resolveSecretRefs` turns them into
 * `SecretValue`s in memory when a later step needs the value (owner's answer 7); a
 * `SecretValue` prints and serialises as "(secret)", so it cannot reach output, a journal
 * or a file by accident.
 */

export const PROJECT_FILE_BASENAME = "blocks.project";
export const PROJECT_FILE_EXTENSIONS = [".yaml", ".yml", ".json"] as const;
export const SUPPORTED_SCHEMA_VERSION = 1;

export const MANAGED_AREAS = ["data"] as const;
export const RESERVED_AREAS = ["iam", "auth", "mail", "storage", "localization", "logic"] as const;

export type ProjectDocument = {
  $schema?: string;
  schemaVersion: number;
  project?: { tenantId?: string; name?: string };
  data?: { schemas?: string; rules?: string; newSchemaAccess?: "user" | "public" };
  secrets?: { required?: string[] };
} & Partial<Record<(typeof RESERVED_AREAS)[number], Record<string, unknown>>>;

export type SecretRefUse = { name: string; path: string };

export type LoadedProjectFile = {
  /** Absolute path of the base file. */
  baseFile: string;
  /** The merged, validated and env-substituted document. */
  document: ProjectDocument;
  env?: string;
  /** Absolute path of the overlay, when `--env` selected one. */
  overlayFile?: string;
  /** Folder of the base file; relative paths in the file resolve against it. */
  root: string;
  /** Every `{ secretRef: NAME }` in the document, by path. Names only, never values. */
  secretRefs: SecretRefUse[];
};

type LoadOptions = {
  cwd?: string;
  env?: string;
  environment?: NodeJS.ProcessEnv;
  file?: string;
};

export async function loadProjectFile(options: LoadOptions = {}): Promise<LoadedProjectFile> {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  const baseFile = options.file ? resolve(cwd, options.file) : await findBaseFile(cwd);
  const root = dirname(baseFile);

  const base = await readProjectFile(baseFile);
  let merged = base;
  let overlayFile: string | undefined;

  if (options.env !== undefined) {
    overlayFile = await findOverlayFile(baseFile, options.env);
    const overlay = await readProjectFile(overlayFile);
    if (!isPlainObject(overlay)) {
      throw invalid(`${basename(overlayFile)}: an overlay must be a mapping of keys`);
    }
    if (overlay.schemaVersion !== undefined && isPlainObject(base) && overlay.schemaVersion !== base.schemaVersion) {
      throw invalid(`${basename(overlayFile)}: schemaVersion ${String(overlay.schemaVersion)} differs from the base file's ${String(base.schemaVersion)}`);
    }
    merged = mergeOverlay(base, overlay);
  }

  const errors = validateProjectDocument(merged, await projectFileSchema());
  if (errors.length) {
    throw invalid(`Project file is not valid:\n${errors.map((error) => `  ${error}`).join("\n")}`);
  }

  const document = substituteEnv(merged, environment) as ProjectDocument;
  return { baseFile, document, env: options.env, overlayFile, root, secretRefs: collectSecretRefs(document) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findBaseFile(cwd: string): Promise<string> {
  const workspace = await findWorkspace();
  const folder = workspace ? dirname(workspace.path) : cwd;
  const found: string[] = [];
  for (const extension of PROJECT_FILE_EXTENSIONS) {
    const candidate = join(folder, `${PROJECT_FILE_BASENAME}${extension}`);
    if (await exists(candidate)) found.push(candidate);
  }
  if (found.length > 1) {
    throw new CliActionableError(
      `More than one project file in ${folder}: ${found.map((path) => basename(path)).join(", ")}.`,
      "project_file_ambiguous",
      "Keep one base file (blocks.project.yaml is the default), or pass --file <path>."
    );
  }
  if (found.length === 0) {
    throw new CliActionableError(
      `No project file found in ${folder} (looked for ${PROJECT_FILE_EXTENSIONS.map((ext) => `${PROJECT_FILE_BASENAME}${ext}`).join(", ")}).`,
      "project_file_not_found",
      "Create blocks.project.yaml next to blocks.json (see schema/blocks.project.schema.json in the CLI package), or pass --file <path>."
    );
  }
  return found[0];
}

const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

async function findOverlayFile(baseFile: string, env: string): Promise<string> {
  if (!ENV_NAME.test(env) || env.toLowerCase() === "schema") {
    throw new CliActionableError(
      `'${env}' is not a valid environment name.`,
      "project_file_invalid",
      "Use letters, digits, '-' or '_' (for example --env dev); 'schema' is reserved for blocks.project.schema.json."
    );
  }
  const folder = dirname(baseFile);
  const stem = basename(baseFile, extname(baseFile));
  const found: string[] = [];
  for (const extension of PROJECT_FILE_EXTENSIONS) {
    const candidate = join(folder, `${stem}.${env}${extension}`);
    if (await exists(candidate)) found.push(candidate);
  }
  if (found.length !== 1) {
    throw new CliActionableError(
      found.length
        ? `More than one overlay for environment '${env}': ${found.map((path) => basename(path)).join(", ")}.`
        : `No overlay for environment '${env}' next to ${basename(baseFile)} (looked for ${stem}.${env}.yaml, .yml, .json).`,
      found.length ? "project_file_ambiguous" : "project_file_not_found",
      found.length ? "Keep one overlay per environment." : `Create ${stem}.${env}.yaml, or run without --env to use the base file alone.`
    );
  }
  return found[0];
}

/** Parses one file and rejects literal secrets in it. Never echoes a value from the file. */
export async function readProjectFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw invalid(`${basename(path)}: cannot read it (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
  const document = parseProjectText(text, path);
  const secrets = findLiteralSecrets(document);
  if (secrets.length) {
    throw new CliActionableError(
      `${basename(path)} holds ${secrets.length} literal secret(s); values are not shown:\n${secrets.map((hit) => `  ${hit.path}: ${hit.reason}`).join("\n")}`,
      "project_file_secret",
      "Never put a secret value in the project file. Store it in Blocks Secrets (blocks secrets set) and write { secretRef: NAME } instead."
    );
  }
  return document;
}

export function parseProjectText(text: string, fileName: string): unknown {
  const name = basename(fileName);
  if (extname(fileName).toLowerCase() === ".json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^﻿/, ""));
    } catch (error) {
      throw invalid(`${name}: not valid JSON (${(error as Error).message})`);
    }
    const duplicate = findDuplicateJsonKey(text);
    if (duplicate) throw invalid(`${name}: line ${duplicate.line}: duplicate key '${duplicate.key}'`);
    return parsed;
  }
  try {
    return parseYamlLite(text);
  } catch (error) {
    if (error instanceof YamlLiteError) throw invalid(`${name}: ${error.message}`);
    throw error;
  }
}

function invalid(message: string): CliActionableError {
  return new CliActionableError(message, "project_file_invalid", "Fix the project file and run blocks plan again.");
}

// ---------------------------------------------------------------- schema

let cachedSchema: JsonSchema | undefined;

export async function projectFileSchema(): Promise<JsonSchema> {
  if (!cachedSchema) {
    const url = new URL("../../schema/blocks.project.schema.json", import.meta.url);
    cachedSchema = JSON.parse(await readFile(url, "utf8")) as JsonSchema;
  }
  return cachedSchema;
}

export function validateProjectDocument(document: unknown, schema: JsonSchema): string[] {
  if (!isPlainObject(document)) return ["(root): the project file must be a mapping of keys"];
  const errors = validateJsonSchema(document, schema);
  if (typeof document.schemaVersion === "number" && document.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    errors.push(`schemaVersion: ${document.schemaVersion} is newer than this CLI knows (${SUPPORTED_SCHEMA_VERSION}); update the CLI`);
  }
  errors.push(...findMisplacedSecretRefs(document));
  return errors;
}

/** `{ secretRef }` must be exactly that one key; a reference with extra keys is a typo. */
function findMisplacedSecretRefs(value: unknown, path = ""): string[] {
  const errors: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => errors.push(...findMisplacedSecretRefs(item, `${path}[${index}]`)));
  } else if (isPlainObject(value)) {
    if ("secretRef" in value && !isSecretRef(value)) {
      errors.push(`${path || "(root)"}: a secret reference is exactly { secretRef: NAME } with a valid name`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (key !== "secretRef") errors.push(...findMisplacedSecretRefs(item, path ? `${path}.${key}` : key));
    }
  }
  return errors;
}

// ---------------------------------------------------------------- overlay

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mappings merge key by key; a list or a scalar in the overlay replaces the base value. */
export function mergeOverlay(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay) || isSecretRef(overlay)) return overlay;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = key in base ? mergeOverlay(base[key], value) : value;
  }
  return result;
}

// ---------------------------------------------------------------- secrets

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Field names that hold a secret value (0007 §9: clientSecret, accountPassword, passwords, tokens, keys). */
const SECRET_FIELD = /(secret|password|passwd|passphrase|pwd|token|apikey|api_key|api-key|accesskey|access_key|access-key|privatekey|private_key|private-key|signingkey|signing_key|connectionstring|connection_string|credential|credentials)$/i;

export function isSecretFieldName(key: string): boolean {
  return key !== "secretRef" && SECRET_FIELD.test(key);
}

export function isSecretRef(value: unknown): value is { secretRef: string } {
  return isPlainObject(value)
    && Object.keys(value).length === 1
    && typeof value.secretRef === "string"
    && SECRET_NAME.test(value.secretRef);
}

const KNOWN_TOKEN_SHAPES: Array<[RegExp, string]> = [
  [/^(AKIA|ASIA)[0-9A-Z]{16}$/, "looks like a cloud access key id"],
  [/^gh[pousr]_[A-Za-z0-9]{20,}$/, "looks like a GitHub token"],
  [/^xox[abprs]-[A-Za-z0-9-]{10,}$/, "looks like a Slack token"],
  [/^sk-[A-Za-z0-9_-]{20,}$/, "looks like an API secret key"],
  [/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/, "looks like a JWT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "looks like a private key"]
];

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * A long, unbroken string with high entropy and a mix of character classes. Tuned to
 * pass names, paths, URLs, UUIDs and hex ids (at most 4 bits per character) and to
 * catch random base64-like keys.
 */
export function looksLikeHighEntropySecret(value: string): boolean {
  if (value.length < 20 || /\s/.test(value) || /^\$\{env:[^}]+\}$/.test(value) || /^https?:\/\//i.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
  return classes >= 3 && shannonEntropy(value) >= 4.2;
}

export type LiteralSecretHit = { path: string; reason: string };

/** Paths (never values) of literal secrets: a value in a secret-named field, a known token shape, or a high-entropy string. */
export function findLiteralSecrets(value: unknown, path = ""): LiteralSecretHit[] {
  const hits: LiteralSecretHit[] = [];

  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...findLiteralSecrets(item, `${path}[${index}]`)));
    return hits;
  }

  if (isPlainObject(value)) {
    if (isSecretRef(value)) return hits;
    for (const [key, item] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isSecretFieldName(key) && item !== null && typeof item !== "boolean" && !isSecretRef(item) && !isPlainObject(item) && !Array.isArray(item)) {
        hits.push({ path: childPath, reason: "a secret-named field holds a literal value; use { secretRef: NAME }" });
        continue;
      }
      hits.push(...findLiteralSecrets(item, childPath));
    }
    return hits;
  }

  if (typeof value === "string") {
    const shape = KNOWN_TOKEN_SHAPES.find(([pattern]) => pattern.test(value));
    if (shape) hits.push({ path: path || "(root)", reason: `${shape[1]}; use { secretRef: NAME }` });
    else if (looksLikeHighEntropySecret(value)) hits.push({ path: path || "(root)", reason: "a high-entropy string that looks like a secret; use { secretRef: NAME }" });
  }
  return hits;
}

export function collectSecretRefs(value: unknown, path = ""): SecretRefUse[] {
  if (isSecretRef(value)) return [{ name: value.secretRef, path: path || "(root)" }];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectSecretRefs(item, `${path}[${index}]`));
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, item]) => collectSecretRefs(item, path ? `${path}.${key}` : key));
  }
  return [];
}

/**
 * A secret value held in memory only. Every way of turning it into text gives
 * "(secret)"; the value is read only through `reveal()`, at the point of use.
 */
export class SecretValue {
  readonly #value: string;
  readonly name: string;

  constructor(name: string, value: string) {
    this.name = name;
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "(secret)";
  }

  toJSON(): string {
    return "(secret)";
  }

  [inspect.custom](): string {
    return "(secret)";
  }
}

/**
 * Returns a copy of the document with every `{ secretRef: NAME }` replaced by a
 * `SecretValue`, looked up by `lookup` (Blocks Secrets in `apply`). Nothing is cached or
 * written. Missing names fail together, by name only.
 */
export async function resolveSecretRefs(
  document: unknown,
  lookup: (name: string) => Promise<string | undefined>
): Promise<unknown> {
  const missing = new Set<string>();
  const values = new Map<string, SecretValue>();
  for (const { name } of collectSecretRefs(document)) {
    if (values.has(name) || missing.has(name)) continue;
    const value = await lookup(name);
    if (value === undefined) missing.add(name);
    else values.set(name, new SecretValue(name, value));
  }
  if (missing.size) {
    throw new CliActionableError(
      `Secret(s) not found in Blocks Secrets: ${[...missing].sort().join(", ")}.`,
      "project_file_secret_missing",
      "Create each one with 'blocks secrets set' (the value never goes into the project file)."
    );
  }
  const replace = (value: unknown): unknown => {
    if (isSecretRef(value)) return values.get(value.secretRef);
    if (Array.isArray(value)) return value.map(replace);
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  return replace(document);
}

// ---------------------------------------------------------------- ${env:NAME}

const ENV_REFERENCE = /\$\{env:([^}]*)\}/g;
const ENV_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ENV_NAME = /(SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SIGNING_?KEY|CREDENTIAL|CONNECTION_?STRING)/i;

/** Replaces `${env:NAME}` in string values. Secret-looking names and unset variables are errors. */
export function substituteEnv(value: unknown, environment: NodeJS.ProcessEnv, path = ""): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_REFERENCE, (_match, name: string) => {
      const where = path || "(root)";
      if (!ENV_VARIABLE.test(name)) throw invalid(`${where}: '\${env:${name}}' is not a valid environment variable reference`);
      if (SECRET_ENV_NAME.test(name)) {
        throw new CliActionableError(
          `${where}: \${env:${name}} looks like a secret; \${env:} is only for non-secret values (tenant id, base URLs).`,
          "project_file_secret",
          "Store the secret in Blocks Secrets and write { secretRef: NAME } instead."
        );
      }
      const resolved = environment[name];
      if (resolved === undefined || resolved === "") throw invalid(`${where}: environment variable ${name} is not set`);
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((item, index) => substituteEnv(item, environment, `${path}[${index}]`));
  if (isPlainObject(value)) {
    if (isSecretRef(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteEnv(item, environment, path ? `${path}.${key}` : key)]));
  }
  return value;
}
