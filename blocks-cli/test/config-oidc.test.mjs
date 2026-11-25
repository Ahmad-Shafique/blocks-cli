// I14-WP8 (part 2): the auth.oidcClients list of `blocks plan` and `blocks apply` (decision 0007 §11 step 4).
// The server is an in-process, stateful fake of /iam/v4/oidc-clients. No real Blocks server is reached.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { OIDC_CLIENT_FIELDS, desiredOidcFields, diffOidcClients, validateOidcDesired } from "../dist/lib/oidc-config.js";
import { projectFileSchema, validateProjectDocument } from "../dist/lib/project-file.js";

const repoRoot = resolve(import.meta.dirname, "..");
const bin = join(repoRoot, "bin", "run.js");
process.env.BLOCKS_NO_UPDATE_CHECK = "1";

// ------------------------------------------------------------------ unit

test("the schema lists exactly the mapped oidc client keys plus name, and has no secret field", async () => {
  const schema = await projectFileSchema();
  const listed = Object.keys(schema.properties.auth.properties.oidcClients.items.properties).filter((key) => key !== "name").sort();
  assert.deepEqual(listed, Object.keys(OIDC_CLIENT_FIELDS).sort());
  assert.ok(!listed.some((key) => /secret/i.test(key)));
});

test("the schema checks oidcClients types, the required name and unknown keys", async () => {
  const schema = await projectFileSchema();
  const doc = (client) => ({ schemaVersion: 1, auth: { oidcClients: [client] } });
  assert.deepEqual(validateProjectDocument(doc({ name: "Web", redirectUris: ["https://a.test/cb"], requirePkce: true }), schema), []);
  assert.ok(validateProjectDocument(doc({ redirectUris: [] }), schema).length > 0, "name is required");
  assert.ok(validateProjectDocument(doc({ name: "Web", requirePkce: "yes" }), schema).length > 0);
  assert.ok(validateProjectDocument(doc({ name: "Web", clientSecret: "x" }), schema).length > 0, "a secret never goes in the file");
});

test("diffOidcClients compares only stated keys, lists sorted, and never lists a client for removal", () => {
  const live = [{ clientDisplayName: "Web", itemId: "c1", redirectUris: ["b", "a"], requirePkce: true, other: 1 }, { clientDisplayName: "Other", itemId: "c2" }];
  const items = diffOidcClients([{ name: "Web", redirectUris: ["a", "b"] }, { name: "New", clientType: "public" }, { name: "Web2" }], live);
  assert.equal(items[0].action, "unchanged");
  assert.equal(items[1].action, "create");
  assert.equal(items[2].action, "create");
  const changed = diffOidcClients([{ name: "Web", redirectUris: ["a"], requirePkce: false }], live)[0];
  assert.equal(changed.action, "update");
  assert.deepEqual(changed.changes, ["redirectUris", "requirePkce"]);
  assert.ok(!items.some((item) => item.action === "not-in-file"));
  assert.deepEqual(desiredOidcFields({ name: "Web", requirePkce: true }), { requirePkce: true });
});

test("duplicate client names are an error", () => {
  assert.equal(validateOidcDesired([{ name: "A" }, { name: "B" }]).length, 0);
  assert.equal(validateOidcDesired([{ name: "A" }, { name: "A" }]).length, 1);
});

// ------------------------------------------------------------------ fake server, end to end

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "blocks-wp8o-"));
  const cwd = join(base, "workspace");
  const configDir = join(base, "config");
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(cwd, "blocks.json"), `${JSON.stringify({ project: { tenantId: "target-project" } }, null, 2)}\n`);

  const requests = [];
  const clients = [{
    itemId: "client-1", clientId: "client-1", clientSecret: "stored-secret-value", clientDisplayName: "Web App", clientType: "public",
    redirectUris: ["https://app.example.test/cb"], allowedScopes: ["openid", "profile"], isAutoRedirect: true, requirePkce: true,
    registerAsIdentityProvider: true, externalDiscoveryEndpoint: "https://iam.example.test/target-project/.well-known/openid-configuration"
  }];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    requests.push({ method: request.method, path, body });
    let status = 200;
    let result = { isSuccess: true };
    if (path === "/iam/v4/oidc-clients" && request.method === "GET") result = { isSuccess: true, oIDCClientCredentials: clients };
    else if (path === "/iam/v4/oidc-clients/client-1" && request.method === "GET") result = { isSuccess: true, oIDCClientCredential: clients[0] };
    else if (path === "/iam/v4/oidc-clients" && request.method === "POST") {
      const index = clients.findIndex((client) => client.itemId === body.itemId);
      if (index >= 0) clients[index] = { ...clients[index], ...body };
      else clients.push({ ...body, itemId: `client-${clients.length + 1}`, clientSecret: "one-time-new-secret" });
      result = { isSuccess: true, clientSecret: "one-time-new-secret" };
    } else { status = 404; result = { message: `unexpected ${request.method} ${path}` }; }
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
    clients, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    cwd, env, requests, url, writes: () => requests.filter((request) => request.method !== "GET")
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
const FILE = [
  "schemaVersion: 1", "auth:", "  oidcClients:",
  "    - name: Web App", "      redirectUris: [\"https://app.example.test/cb\", \"https://app.example.test/cb2\"]",
  "    - name: Mobile", "      clientType: public", "      requirePkce: true", ""
].join("\n");

test("plan lists an update and a create, sends no write; apply --write updates, creates and drops the secret", async () => {
  const t = await setup();
  try {
    await writeFile(join(t.cwd, "blocks.project.yaml"), FILE);
    const plan = await run(["plan", ...ctx(t.url)], t);
    assert.equal(plan.status, 2, plan.stdout + plan.stderr);
    assert.match(plan.stdout, /~ update\s+oidcClient Web App: redirectUris/);
    assert.match(plan.stdout, /\+ create\s+oidcClient Mobile/);
    assert.deepEqual(t.writes(), []);

    const applied = await run(["apply", "--write", "--yes", "--json", ...ctx(t.url)], t);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    assert.deepEqual(JSON.parse(applied.stdout).residual, []);
    assert.equal(t.writes().length, 2);
    for (const secret of ["one-time-new-secret", "stored-secret-value"]) {
      assert.ok(!applied.stdout.includes(secret) && !applied.stderr.includes(secret), "no secret reaches the output");
    }
    // the update carried the stored fields and never echoed the stored secret
    const update = t.writes().find((request) => request.body.itemId === "client-1").body;
    assert.deepEqual(update.redirectUris, ["https://app.example.test/cb", "https://app.example.test/cb2"]);
    assert.equal(update.requirePkce, true);
    assert.deepEqual(update.allowedScopes, ["openid", "profile"]);
    assert.equal(update.clientSecret, undefined);
    // the create got the bootstrap defaults and the discovery endpoint
    const created = t.writes().find((request) => request.body.itemId === undefined).body;
    assert.equal(created.clientDisplayName, "Mobile");
    assert.equal(created.isAutoRedirect, true);
    assert.equal(created.registerAsIdentityProvider, true);
    assert.match(created.externalDiscoveryEndpoint, /target-project\/\.well-known\/openid-configuration$/);
    assert.equal(t.clients.length, 2);
  } finally { await t.close(); }
});

test("apply twice: the second run makes zero writes; plan then exits 0; an unlisted client is left alone", async () => {
  const t = await setup();
  try {
    t.clients.push({ itemId: "client-9", clientDisplayName: "Not in file" });
    await writeFile(join(t.cwd, "blocks.project.yaml"), FILE);
    assert.equal((await run(["apply", "--write", "--yes", ...ctx(t.url)], t)).status, 0);
    const before = t.writes().length;
    const second = await run(["apply", "--write", "--yes", ...ctx(t.url)], t);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Nothing to write/);
    assert.equal(t.writes().length, before);
    assert.equal((await run(["plan", ...ctx(t.url)], t)).status, 0);
    assert.ok(t.clients.some((client) => client.itemId === "client-9"), "no client is ever deleted");
  } finally { await t.close(); }
});
