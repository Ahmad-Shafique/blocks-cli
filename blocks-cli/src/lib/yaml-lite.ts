/**
 * A strict parser for the small YAML subset the project file uses (decision 0007 §3).
 *
 * The CLI has no runtime dependencies, and 0007 names no YAML library, so the project
 * file is read with this parser instead of adding one. It is deliberately narrow:
 *
 * - block mappings (`key: value`), block sequences (`- item`), and single-line flow
 *   collections (`[a, b]`, `{ secretRef: NAME }`);
 * - plain, single-quoted and double-quoted scalars; `null`/`~`, `true`/`false`, and
 *   decimal numbers (YAML 1.2 core schema: `yes`/`no`/`on`/`off` stay strings);
 * - `#` comments and one optional leading `---`.
 *
 * It rejects, with the line number, everything that could make the applied value differ
 * from what a reviewer reads: duplicate keys, anchors and aliases (`&a`, `*a`), merge keys
 * (`<<`), tags (`!x`), block scalars (`|`, `>`), complex keys (`?`), several documents,
 * and tabs used for indentation.
 */

export class YamlLiteError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.name = "YamlLiteError";
    this.line = line;
  }
}

type Line = { indent: number; lineNo: number; text: string };

export function parseYamlLite(source: string): unknown {
  const lines = toLines(source);
  if (lines.length === 0) return null;

  const state = { index: 0, lines };
  const value = parseBlock(state, lines[0].indent);
  if (state.index < lines.length) {
    const line = lines[state.index];
    throw new YamlLiteError("unexpected indentation or content after the document", line.lineNo);
  }
  return value;
}

function toLines(source: string): Line[] {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const result: Line[] = [];
  let sawContent = false;

  text.split("\n").forEach((raw, offset) => {
    const lineNo = offset + 1;
    const stripped = stripComment(raw, lineNo).replace(/\s+$/, "");
    if (!stripped.trim()) return;

    const indentMatch = /^[ \t]*/.exec(stripped)?.[0] ?? "";
    if (indentMatch.includes("\t")) throw new YamlLiteError("tabs are not allowed for indentation; use spaces", lineNo);
    const content = stripped.slice(indentMatch.length);

    if (content === "---" || content.startsWith("--- ")) {
      if (sawContent) throw new YamlLiteError("only one YAML document is allowed in the project file", lineNo);
      if (content.length > 3) throw new YamlLiteError("put content on the line after '---'", lineNo);
      return;
    }
    if (content === "..." ) throw new YamlLiteError("document end markers ('...') are not supported", lineNo);
    if (/^%/.test(content) && indentMatch.length === 0) throw new YamlLiteError("YAML directives are not supported", lineNo);

    sawContent = true;
    result.push({ indent: indentMatch.length, lineNo, text: content });
  });

  return result;
}

/** Removes a `#` comment that starts the line or follows whitespace, outside quotes. */
function stripComment(raw: string, lineNo: number): string {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote === '"') {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (ch === "'" && raw[i + 1] === "'") i += 1;
      else if (ch === "'") quote = undefined;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
    if ((ch === '"' || ch === "'") && (i === 0 || /[\s\[{,:-]/.test(raw[i - 1]))) quote = ch;
  }
  void lineNo;
  return raw;
}

type State = { index: number; lines: Line[] };

function isSequenceItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function parseBlock(state: State, indent: number): unknown {
  const line = state.lines[state.index];
  if (line.indent !== indent) throw new YamlLiteError("unexpected indentation", line.lineNo);
  return isSequenceItem(line.text) ? parseSequence(state, indent) : parseMapping(state, indent);
}

function parseSequence(state: State, indent: number): unknown[] {
  const items: unknown[] = [];

  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlLiteError("unexpected indentation inside a list", line.lineNo);
    if (!isSequenceItem(line.text)) {
      throw new YamlLiteError("expected a list item ('- ...') at this indentation", line.lineNo);
    }

    const rest = line.text.slice(1);
    const content = rest.replace(/^ +/, "");
    if (!content) {
      state.index += 1;
      const next = state.lines[state.index];
      items.push(next && next.indent > indent ? parseBlock(state, next.indent) : null);
      continue;
    }

    const childIndent = indent + 1 + (rest.length - content.length);
    if (isSequenceItem(content)) {
      // "- - a": a nested list on the same line. Re-read the rest as its own line.
      state.lines[state.index] = { indent: childIndent, lineNo: line.lineNo, text: content };
      items.push(parseSequence(state, childIndent));
      continue;
    }
    if (splitMappingEntry(content, line.lineNo)) {
      // "- key: value" starts a mapping whose other keys sit at the column of "key".
      state.lines[state.index] = { indent: childIndent, lineNo: line.lineNo, text: content };
      items.push(parseMapping(state, childIndent));
      continue;
    }

    items.push(parseInlineValue(content, line.lineNo));
    state.index += 1;
  }

  return items;
}

function parseMapping(state: State, indent: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlLiteError("unexpected indentation inside a mapping", line.lineNo);
    if (isSequenceItem(line.text)) throw new YamlLiteError("a list item cannot appear among mapping keys", line.lineNo);

    const entry = splitMappingEntry(line.text, line.lineNo);
    if (!entry) throw new YamlLiteError("expected 'key: value'", line.lineNo);
    const { key, value } = entry;
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new YamlLiteError(`duplicate key '${key}'`, line.lineNo);
    }

    state.index += 1;
    if (value) {
      result[key] = parseInlineValue(value, line.lineNo);
      continue;
    }

    const next = state.lines[state.index];
    if (next && next.indent > indent) {
      result[key] = parseBlock(state, next.indent);
    } else if (next && next.indent === indent && isSequenceItem(next.text)) {
      // "key:\n- a" (a list at the same indentation as its key) is valid YAML.
      result[key] = parseSequence(state, indent);
    } else {
      result[key] = null;
    }
  }

  return result;
}

/** Splits "key: value" / "key:" outside quotes and flow brackets. Returns undefined when the text is not an entry. */
function splitMappingEntry(text: string, lineNo: number): { key: string; value: string } | undefined {
  if (text.startsWith("? ") || text === "?") throw new YamlLiteError("complex keys ('?') are not supported", lineNo);
  if (text.startsWith("[") || text.startsWith("{")) return undefined;

  let keyText: string;
  let rest: string;

  if (text.startsWith('"') || text.startsWith("'")) {
    const { value, end } = readQuoted(text, 0, lineNo);
    const after = text.slice(end);
    if (!/^\s*:(\s|$)/.test(after)) return undefined;
    keyText = value;
    rest = after.replace(/^\s*:/, "");
  } else {
    const match = /^([^\s:#][^:]*?)\s*:(\s|$)/.exec(text);
    if (!match) return undefined;
    keyText = match[1];
    rest = text.slice(match[0].length - match[2].length);
    if (/^[&*!]/.test(keyText)) throw new YamlLiteError("anchors, aliases and tags are not allowed", lineNo);
  }

  if (keyText === "<<") throw new YamlLiteError("merge keys ('<<') are not allowed", lineNo);
  return { key: keyText, value: rest.trim() };
}

function parseInlineValue(text: string, lineNo: number): unknown {
  const first = text[0];
  if (first === "&" || first === "*") throw new YamlLiteError("anchors and aliases are not allowed in the project file", lineNo);
  if (first === "!") throw new YamlLiteError("YAML tags are not allowed in the project file", lineNo);
  if (first === "|" || first === ">") throw new YamlLiteError("block scalars ('|', '>') are not supported; use a quoted string", lineNo);

  if (first === "[" || first === "{" || first === '"' || first === "'") {
    const parser = new FlowParser(text, lineNo);
    const value = parser.value();
    parser.end();
    return value;
  }

  if (/:\s/.test(text) || text.endsWith(":")) {
    throw new YamlLiteError("a plain value cannot contain ': '; quote it", lineNo);
  }
  return plainScalar(text);
}

function plainScalar(text: string): unknown {
  if (text === "null" || text === "~" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^[-+]?\d+$/.test(text)) {
    const value = Number(text);
    if (Number.isSafeInteger(value)) return value;
    return text;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  return text;
}

function readQuoted(text: string, start: number, lineNo: number): { end: number; value: string } {
  const quote = text[start];
  let i = start + 1;
  let value = "";

  if (quote === "'") {
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") { value += "'"; i += 2; continue; }
        return { end: i + 1, value };
      }
      value += text[i];
      i += 1;
    }
    throw new YamlLiteError("unterminated single-quoted string", lineNo);
  }

  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') return { end: i + 1, value };
    if (ch === "\\") {
      const next = text[i + 1];
      const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", "0": "\0", " ": " " };
      if (next !== undefined && simple[next] !== undefined) { value += simple[next]; i += 2; continue; }
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      throw new YamlLiteError(`unsupported escape '\\${next ?? ""}' in a double-quoted string`, lineNo);
    }
    value += ch;
    i += 1;
  }
  throw new YamlLiteError("unterminated double-quoted string", lineNo);
}

/** Flow collections on one line: `[a, "b", {k: v}]`, `{ secretRef: NAME }`, or one quoted scalar. */
class FlowParser {
  private pos = 0;

  constructor(private readonly text: string, private readonly lineNo: number) {}

  value(): unknown {
    this.skipSpace();
    const ch = this.text[this.pos];
    if (ch === "[") return this.sequence();
    if (ch === "{") return this.mapping();
    if (ch === '"' || ch === "'") {
      const { value, end } = readQuoted(this.text, this.pos, this.lineNo);
      this.pos = end;
      return value;
    }
    if (ch === "&" || ch === "*") throw new YamlLiteError("anchors and aliases are not allowed in the project file", this.lineNo);
    if (ch === "!") throw new YamlLiteError("YAML tags are not allowed in the project file", this.lineNo);
    const start = this.pos;
    while (this.pos < this.text.length && !",]}".includes(this.text[this.pos])) {
      if (this.text[this.pos] === ":" && /\s/.test(this.text[this.pos + 1] ?? " ")) break;
      this.pos += 1;
    }
    const raw = this.text.slice(start, this.pos).trim();
    if (!raw) throw new YamlLiteError("missing value in a flow collection", this.lineNo);
    return plainScalar(raw);
  }

  end(): void {
    this.skipSpace();
    if (this.pos !== this.text.length) {
      throw new YamlLiteError(`unexpected text after the value: '${this.text.slice(this.pos)}'`, this.lineNo);
    }
  }

  private sequence(): unknown[] {
    this.pos += 1;
    const items: unknown[] = [];
    this.skipSpace();
    if (this.text[this.pos] === "]") { this.pos += 1; return items; }
    for (;;) {
      items.push(this.value());
      this.skipSpace();
      const ch = this.text[this.pos];
      if (ch === ",") { this.pos += 1; this.skipSpace(); if (this.text[this.pos] === "]") { this.pos += 1; return items; } continue; }
      if (ch === "]") { this.pos += 1; return items; }
      throw new YamlLiteError("expected ',' or ']' in a flow list", this.lineNo);
    }
  }

  private mapping(): Record<string, unknown> {
    this.pos += 1;
    const result: Record<string, unknown> = {};
    this.skipSpace();
    if (this.text[this.pos] === "}") { this.pos += 1; return result; }
    for (;;) {
      this.skipSpace();
      const key = this.key();
      if (key === "<<") throw new YamlLiteError("merge keys ('<<') are not allowed", this.lineNo);
      if (Object.prototype.hasOwnProperty.call(result, key)) throw new YamlLiteError(`duplicate key '${key}'`, this.lineNo);
      this.skipSpace();
      if (this.text[this.pos] !== ":") throw new YamlLiteError(`expected ':' after key '${key}'`, this.lineNo);
      this.pos += 1;
      result[key] = this.value();
      this.skipSpace();
      const ch = this.text[this.pos];
      if (ch === ",") { this.pos += 1; this.skipSpace(); if (this.text[this.pos] === "}") { this.pos += 1; return result; } continue; }
      if (ch === "}") { this.pos += 1; return result; }
      throw new YamlLiteError("expected ',' or '}' in a flow mapping", this.lineNo);
    }
  }

  private key(): string {
    const ch = this.text[this.pos];
    if (ch === '"' || ch === "'") {
      const { value, end } = readQuoted(this.text, this.pos, this.lineNo);
      this.pos = end;
      return value;
    }
    if (ch === "&" || ch === "*" || ch === "!" || ch === "?") {
      throw new YamlLiteError("anchors, aliases, tags and complex keys are not allowed", this.lineNo);
    }
    const start = this.pos;
    while (this.pos < this.text.length && !":,{}[]".includes(this.text[this.pos])) this.pos += 1;
    const key = this.text.slice(start, this.pos).trim();
    if (!key) throw new YamlLiteError("missing key in a flow mapping", this.lineNo);
    return key;
  }

  private skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos += 1;
  }
}

/**
 * Finds duplicate object keys in JSON text, which `JSON.parse` silently resolves to the
 * last one. The project file rejects them in JSON exactly as in YAML. Call it only on
 * text `JSON.parse` already accepted.
 */
export function findDuplicateJsonKey(text: string): { key: string; line: number } | undefined {
  const stack: Array<Set<string> | null> = [];
  let line = 1;
  let i = 0;
  let expectKey = false;

  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") { line += 1; i += 1; continue; }
    if (ch === "{") { stack.push(new Set()); expectKey = true; i += 1; continue; }
    if (ch === "[") { stack.push(null); expectKey = false; i += 1; continue; }
    if (ch === "}" || ch === "]") { stack.pop(); expectKey = false; i += 1; continue; }
    if (ch === ",") { expectKey = stack[stack.length - 1] instanceof Set; i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") { value += text.slice(j, j + 2); j += 2; continue; }
        value += text[j];
        j += 1;
      }
      if (expectKey) {
        const keys = stack[stack.length - 1];
        const key = JSON.parse(`"${value}"`) as string;
        if (keys instanceof Set) {
          if (keys.has(key)) return { key, line };
          keys.add(key);
        }
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return undefined;
}
