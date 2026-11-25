// I14-WP8 (part 3): the storage.configs list of `blocks plan` and `blocks apply` (decision 0007 §11 step 4).
// The server is an in-process, stateful fake of /os/v4/Storage. No real Blocks server is reached.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { STORAGE_UPLOAD_FIELDS, desiredStorageFields, diffStorageConfigs, validateStorageDesired } from "../dist/lib/storage-config.js";
import { projectFileSchema, validateProjectDocument } from "../dist/lib/project-file.js";

const repoRoot = resolve(import.meta.dirname, "..");
const bin = join(repoRoot, "bin", "run.js");
process.env.BLOCKS_NO_UPDATE_CHECK = "1";

test("the schema lists exactly the upload keys plus name and storageStrategy, and no credential", async () => {
  const schema = await projectFileSchema();
  const listed = Object.keys(schema.properties.storage.properties.configs.items.properties).filter((key) => key !== "name" && key !== "storageStrategy").sort();
  assert.deepEqual(listed, Object.keys(STORAGE_UPLOAD_FIELDS).sort());
  const doc = (config) => ({ schemaVersion: 1, storage: { configs: [config] } });
  assert.deepEqual(validateProjectDocument(doc({ name: "a", maxFileSizeInBytes: 5 }), schema), []);
  assert.ok(validateProjectDocument(doc({ maxFileSizeInBytes: 5 }), schema).length > 0, "name is required");
  assert.ok(validateProjectDocument(doc({ name: "a", secretKey: "x" }), schema).length > 0, "no credential in the file");
});

test("diffStorageConfigs: unchanged, update, blocked for a missing config and for a strategy change; nothing removed", () => {
  const live = [{ name: "main-store", itemId: "cfg-1", storageStrategy: "s3", uploadUrlExpirySeconds: 300, uploadCompletionRequiredFor: ["b", "a"] }, { name: "other" }];
  const items = diffStorageConfigs([
    { name: "main-store", uploadCompletionRequiredFor: ["a", "b"], uploadUrlExpirySeconds: 300 },
    { name: "main-store", uploadUrlExpirySeconds: 60 },
    { name: "missing" },
    { name: "main-store", storageStrategy: "sftp" }
  ], live);
  assert.deepEqual(items.map((item) => item.action), ["unchanged", "update", "blocked", "blocked"]);
  assert.deepEqual(items[1].changes, ["uploadUrlExpirySeconds"]);
  assert.ok(!items.some((item) => item.action === "not-in-file"));
  assert.deepEqual(desiredStorageFields({ name: "x", maxFileSizeInBytes: 9 }), { maxFileSizeInBytes: 9 });
});

test("duplicate storage names are an error", () => {
  assert.equal(validateStorageDesired([{ name: "A" }, { name: "B" }]).length, 0);
  assert.equal(validateStorageDesired([{ name: "A" }, { name: "A" }]).length, 1);
});

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "blocks-wp8o-"));
  const cwd = join(base, "workspace");
  const configDir = join(base, "config");
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(cwd, "blocks.json"), `${JSON.stringify({ project: { tenantId: "target-project" } }, null, 2)}\n`);

  const requests = [];
  const configs = [{ itemId: "cfg-1", name: "main-store", storageStrategy: "s3", accessKeyStatus: "active", secretKeyStatus: "active", uploadUrlExpirySeconds: 300, downloadUrlExpirySeconds: 600, maxFileSizeInBytes: 1000, uploadCompletionRequiredFor: ["a", "b"] }];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    requests.push({ method: request.method, path, body });
    let status = 200;
    let result = { isSuccess: true };
    if (path === "/os/v4/Storage/Gets" && request.method === "GET") result = { isSuccess: true, configurations: configs };
    else if (path === "/os/v4/Storage/Save" && request.method === "POST") {
      const index = configs.findIndex((config) => config.itemId === body.itemId);
      if (index >= 0) configs[index] = { ...configs[index], uploadUrlExpirySeconds: body.uploadUrlExpirySeconds, downloadUrlExpirySeconds: body.downloadUrlExpirySeconds, maxFileSizeInBytes: body.maxFileSizeInBytes, uploadCompletionRequiredFor: body.uploadCompletionRequiredFor };
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
    configs, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
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
const FILE = ["schemaVersion: 1", "storage:", "  configs:", "    - name: main-store", "      maxFileSizeInBytes: 5000", ""].join(String.fromCharCode(10));

test("plan shows an update with no write; apply --write saves once, carries the other settings, and the second run writes nothing", async () => {
  const t = await setup();
  try {
    await writeFile(join(t.cwd, "blocks.project.yaml"), FILE);
    const plan = await run(["plan", ...ctx(t.url)], t);
    assert.equal(plan.status, 2, plan.stdout + plan.stderr);
    assert.match(plan.stdout, /~ update +storageConfig main-store: maxFileSizeInBytes/);
    assert.deepEqual(t.writes(), []);
    const applied = await run(["apply", "--write", "--yes", "--json", ...ctx(t.url)], t);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    assert.equal(t.writes().length, 1);
    const body = t.writes()[0].body;
    assert.equal(body.maxFileSizeInBytes, 5000);
    assert.equal(body.uploadUrlExpirySeconds, 300);
    assert.deepEqual(body.uploadCompletionRequiredFor, ["a", "b"]);
    assert.equal(body.updateRequest, true);
    assert.equal(body.itemId, "cfg-1");
    for (const key of ["accessKey", "secretKey", "storageStrategy", "password", "connectionString"]) assert.equal(body[key], undefined, key + " is never sent");
    const second = await run(["apply", "--write", "--yes", ...ctx(t.url)], t);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(t.writes().length, 1);
    assert.equal((await run(["plan", ...ctx(t.url)], t)).status, 0);
  } finally { await t.close(); }
});

test("a config the project lacks is blocked, and apply writes nothing for it", async () => {
  const t = await setup();
  try {
    await writeFile(join(t.cwd, "blocks.project.yaml"), ["schemaVersion: 1", "storage:", "  configs:", "    - name: ghost", "      maxFileSizeInBytes: 1", ""].join(String.fromCharCode(10)));
    const plan = await run(["plan", ...ctx(t.url)], t);
    assert.equal(plan.status, 2);
    assert.match(plan.stdout, /! blocked +storageConfig ghost/);
    const applied = await run(["apply", "--write", "--yes", ...ctx(t.url)], t);
    assert.notEqual(applied.status, 0);
    assert.deepEqual(t.writes(), []);
  } finally { await t.close(); }
});
