// I14-WP8 (first part): the auth.config area of `blocks plan` and `blocks apply` (decision 0007 §11 step 4).
// The server is an in-process, stateful fake of GET and POST /iam/v4/auth/config. No real Blocks server is reached.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { AUTH_CONFIG_FIELDS, desiredAuthFields, diffAuthConfig } from "../dist/lib/auth-config.js";
import { projectFileSchema, validateProjectDocument } from "../dist/lib/project-file.js";

const repoRoot = resolve(import.meta.dirname, "..");
const bin = join(repoRoot, "bin", "run.js");
process.env.BLOCKS_NO_UPDATE_CHECK = "1";

// ------------------------------------------------------------------ unit

test("every auth config key maps to one server field and the schema lists exactly those keys", async () => {
  const schema = await projectFileSchema();
  const listed = Object.keys(schema.properties.auth.properties.config.properties).sort();
  assert.deepEqual(listed, Object.keys(AUTH_CONFIG_FIELDS).sort());
  assert.equal(new Set(Object.values(AUTH_CONFIG_FIELDS).map((entry) => entry.field)).size, listed.length);
});

test("the schema checks auth.config types and unknown keys", async () => {
  const schema = await projectFileSchema();
  assert.deepEqual(validateProjectDocument({ schemaVersion: 1, auth: { config: { oidcEnabled: true, accessTokenMinutes: 30 } } }, schema), []);
  assert.ok(validateProjectDocument({ schemaVersion: 1, auth: { config: { oidcEnabled: "yes" } } }, schema).length > 0);
  assert.ok(validateProjectDocument({ schemaVersion: 1, auth: { config: { accessTokenMinutes: -1 } } }, schema).length > 0);
  assert.ok(validateProjectDocument({ schemaVersion: 1, auth: { config: { colour: "red" } } }, schema).length > 0);
  assert.ok(validateProjectDocument({ schemaVersion: 1, auth: { identityProviders: [] } }, schema).length > 0, "identityProviders is not managed yet");
});

test("diffAuthConfig compares only the stated keys, by the file's own names", () => {
  const live = { isOidcEnabled: false, accessTokenValidForNumberMinutes: 60, passwordPolicyMinLength: 8, other: "x" };
  assert.equal(diffAuthConfig({}, live)[0].action, "unchanged");
  assert.equal(diffAuthConfig({ accessTokenMinutes: 60 }, live)[0].action, "unchanged");
  const item = diffAuthConfig({ oidcEnabled: true, accessTokenMinutes: 60, passwordPolicyMinLength: 12 }, live)[0];
  assert.equal(item.action, "update");
  assert.deepEqual(item.changes, ["oidcEnabled", "passwordPolicyMinLength"]);
  assert.deepEqual(desiredAuthFields({ oidcEnabled: true, accessTokenMinutes: 5 }), { isOidcEnabled: true, accessTokenValidForNumberMinutes: 5 });
});

// ------------------------------------------------------------------ fake server, end to end

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "blocks-wp8-"));
  const cwd = join(base, "workspace");
  const configDir = join(base, "config");
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(cwd, "blocks.json"), `${JSON.stringify({ project: { tenantId: "target-project" } }, null, 2)}\n`);

  const requests = [];
  let stored = { isOidcEnabled: false, accessTokenValidForNumberMinutes: 60, passwordPolicyMinLength: 8, passwordPolicyMessage: null, secretLikeKeep: "kept", accountActivationPath: "activate/", accountActionBaseUrl: "https://app.example.test" };
  let fail = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    requests.push({ method: request.method, path, body });
    let status = 200;
    let result = { isSuccess: true };
    if (path === "/iam/v4/auth/config" && request.method === "GET") result = stored;
    else if (path === "/iam/v4/auth/config" && fail) { status = 500; result = { message: "boom with a body that must not reach the journal" }; }
    else if (path === "/iam/v4/auth/config") stored = { ...body };
    else { status = 404; result = { message: `unexpected ${request.method} ${path}` }; }
    response.statusCode = status;
    response.setHeader("connection", "close");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const profile = { apiUrl: url, clientId: "client-id", createdAt: "2026-01-01T00:00:00.000Z", oidcUrl: "https://iam.example.test", osUrl: url, rootTenantId: "alpha-root", scope: "openid", updatedAt: "2026-01-01T00:00:00.000Z" };
  await writeFile(join(configDir, "config.json"), `${JSON.stringify({ activeAccount: "alpha", accounts: { alpha: { ...profile, selectedProject: { tenantId: "target-project" } } } }, null, 2)}\n`);
  await writeFile(join(configDir, "tokens.json"), `${JSON.stringify({ accounts: { alpha: { projects: { "target-project": { accessToken: "t", expiresAt: new Date(Date.now() + 3e6).toISOString() } } } } }, null, 2)}\n`);
  const env = { ...process.env, BLOCKS_CONFIG_DIR: configDir, BLOCKS_SECRET_STORE: "file", BLOCKS_OPEN_BROWSER: "0", BLOCKS_NO_UPDATE_CHECK: "1", BLOCKS_NO_LINK_CHECK: "1" };
  delete env.BLOCKS_AGENT; delete env.BLOCKS_AGENT_TOKEN;
  return {
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    cwd, env, fail: (value) => { fail = value; }, requests, state: () => stored, url,
    writes: () => requests.filter((request) => request.method !== "GET")
  };
}

function run(args, { cwd, env }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.stdout.on("data", (c) => stdout.push(c));
    child.stderr.on("data", (c) => stderr.push(c));
    child.on("close", (status) => { clearTimeout(timer); resolveRun({ status, stderr: Buffer.concat(stderr).toString("utf8"), stdout: Buffer.concat(stdout).toString("utf8") }); });
  });
}

const ctx = (url) => ["--account", "alpha", "--api-url", url];
const FILE = "schemaVersion: 1\nauth:\n  config:\n    accessTokenMinutes: 30\n    passwordPolicyMinLength: 12\n";

test("plan shows the changed keys, exit 2, and sends no write; apply --write merges over the stored document", async () => {
  const t = await setup();
  try {
    await writeFile(join(t.cwd, "blocks.project.yaml"), FILE);
    const plan = await run(["plan", ...ctx(t.url)], t);
    assert.equal(plan.status, 2, plan.stdout + plan.stderr);
    assert.match(plan.stdout, /~ update\s+config auth config: accessTokenMinutes, passwordPolicyMinLength/);
    assert.deepEqual(t.writes(), []);

    const applied = await run(["apply", "--write", "--yes", "--json", ...ctx(t.url)], t);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    assert.deepEqual(JSON.parse(applied.stdout).residual, []);
    assert.equal(t.writes().length, 1);
    const saved = t.state();
    assert.equal(saved.accessTokenValidForNumberMinutes, 30);
    assert.equal(saved.passwordPolicyMinLength, 12);
    assert.equal(saved.secretLikeKeep, "kept", "unstated fields survive the full-document save");
    assert.equal(saved.passwordPolicyMessage, undefined, "null fields are dropped, as auth config save does");
    assert.equal(saved.isOidcEnabled, false);
  } finally { await t.close(); }
});

test("apply twice: the second run makes zero writes; plan then exits 0", async () => {
  const t = await setup();
  try {
    await writeFile(join(t.cwd, "blocks.project.yaml"), FILE);
    assert.equal((await run(["apply", "--write", "--yes", ...ctx(t.url)], t)).status, 0);
    const before = t.writes().length;
    const second = await run(["apply", "--write", "--yes", ...ctx(t.url)], t);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /Nothing to write/);
    assert.equal(t.writes().length, before);
    assert.equal((await run(["plan", ...ctx(t.url)], t)).status, 0);
  } finally { await t.close(); }
});

test("turning OIDC on points the activation path at OIDC and the base URL at the IAM host, like auth config save", async () => {
  const t = await setup();
  try {
    await writeFile(join(t.cwd, "blocks.project.yaml"), "schemaVersion: 1\nauth:\n  config:\n    oidcEnabled: true\n");
    const applied = await run(["apply", "--write", "--yes", ...ctx(t.url)], t);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    assert.equal(t.state().isOidcEnabled, true);
    assert.equal(t.state().accountActivationPath, "oidc/activate/");
    assert.equal(t.state().accountActionBaseUrl, "https://iam.example.test");
    assert.equal((await run(["plan", ...ctx(t.url)], t)).status, 0, "the plan after apply shows no changes");
  } finally { await t.close(); }
});

test("a failed save is named, keeps the response body out of the output, and a re-run finishes it", async () => {
  const t = await setup();
  try {
    await writeFile(join(t.cwd, "blocks.project.yaml"), FILE);
    t.fail(true);
    const first = await run(["apply", "--write", "--yes", ...ctx(t.url)], t);
    assert.equal(first.status, 1);
    assert.match(first.stderr, /Apply stopped at config auth config/);
    assert.doesNotMatch(first.stdout + first.stderr, /boom with a body/);
    t.fail(false);
    const second = await run(["apply", "--write", "--yes", ...ctx(t.url)], t);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.equal(t.state().accessTokenValidForNumberMinutes, 30);
  } finally { await t.close(); }
});
