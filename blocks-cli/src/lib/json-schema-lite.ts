/**
 * A small JSON Schema (2020-12) validator covering only the keywords
 * `schema/blocks.project.schema.json` uses: type, properties, required,
 * additionalProperties, enum, const, items, minItems, uniqueItems, pattern, minLength,
 * minimum, oneOf, anyOf and local `$ref` (`#/$defs/...`). Annotation keywords
 * (title, description, $schema, $id, examples, default) are ignored.
 *
 * The published schema stays the contract for editors and agents; this validator is
 * how the CLI applies the same contract without a dependency. A keyword it does not
 * know is reported as an error, so the schema cannot silently outgrow it.
 */

export type JsonSchema = Record<string, unknown>;

const KNOWN = new Set([
  "$schema", "$id", "$defs", "$ref", "$comment", "title", "description", "examples", "default", "deprecated",
  "type", "properties", "required", "additionalProperties", "enum", "const", "items", "minItems",
  "uniqueItems", "pattern", "minLength", "minimum", "oneOf", "anyOf"
]);

export function validateJsonSchema(value: unknown, schema: JsonSchema): string[] {
  const errors: string[] = [];
  check(value, schema, schema, "", errors);
  return errors;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function label(path: string): string {
  return path || "(root)";
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  const defs = root.$defs as Record<string, JsonSchema> | undefined;
  if (!match || !defs || !defs[match[1]]) throw new Error(`project file schema: cannot resolve $ref '${ref}'`);
  return defs[match[1]];
}

function check(value: unknown, schema: JsonSchema, root: JsonSchema, path: string, errors: string[]): void {
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) throw new Error(`project file schema: keyword '${key}' is not supported by the CLI's validator`);
  }

  if (typeof schema.$ref === "string") {
    check(value, resolveRef(root, schema.$ref), root, path, errors);
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${label(path)}: must be ${types.join(" or ")}, not ${typeOf(value)}`);
      return;
    }
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${label(path)}: must be ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${label(path)}: must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${label(path)}: must be at least ${schema.minLength} character(s)`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${label(path)}: does not match the pattern ${schema.pattern}`);
    }
  }

  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${label(path)}: must be at least ${schema.minimum}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${label(path)}: must have at least ${schema.minItems} item(s)`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      value.forEach((item, index) => {
        const keyText = JSON.stringify(item);
        if (seen.has(keyText)) errors.push(`${path}[${index}]: duplicate item`);
        seen.add(keyText);
      });
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => check(item, schema.items as JsonSchema, root, `${path}[${index}]`, errors));
    }
  }

  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const name of (schema.required as string[] | undefined) ?? []) {
      if (!(name in record)) errors.push(`${label(path)}: missing required key '${name}'`);
    }
    for (const [name, item] of Object.entries(record)) {
      const childPath = path ? `${path}.${name}` : name;
      if (properties[name]) {
        check(item, properties[name], root, childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${childPath}: unknown key (check the spelling; unknown keys are an error)`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        check(item, schema.additionalProperties as JsonSchema, root, childPath, errors);
      }
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const passes = (schema.anyOf as JsonSchema[]).some((option) => {
      const sub: string[] = [];
      check(value, option, root, path, sub);
      return sub.length === 0;
    });
    if (!passes) errors.push(`${label(path)}: does not match any allowed form`);
  }

  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as JsonSchema[]).filter((option) => {
      const sub: string[] = [];
      check(value, option, root, path, sub);
      return sub.length === 0;
    }).length;
    if (passing !== 1) errors.push(`${label(path)}: must match exactly one allowed form (matched ${passing})`);
  }
}
