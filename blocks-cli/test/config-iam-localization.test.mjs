// I14-WP7: the iam and localization areas of `blocks plan` and `blocks apply` (decision 0007 §11 step 3).
// The server is an in-process, stateful fake: writes change what the next read returns, so
// "apply twice" and "plan after apply" are real checks. No test reaches a real Blocks server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { diffIam, rolesParentsFirst, validateIamDesired } from "../dist/lib/iam-config.js";
import { diffDictionary, expandPattern } from "../dist/lib/localization-config.js";
import { assertRequestAllowed, runReadOnly } from "../dist/lib/read-only-requests.js";
import { validateProjectDocument, projectFileSchema } from "../dist/lib/project-file.js";

const repoRoot = resolve(import.meta.dirname, "..");
const bin = join(repoRoot, "bin", "run.js");
process.env.BLOCKS_NO_UPDATE_CHECK = "1";

// ------------------------------------------------------------------ unit

test("the read-only context allows only the exact read-style POST paths", async () => {
  await runReadOnly("test", async () => {
    assertRequestAllowed("POST", "/iam/v4/iam/roles");
    assertRequestAllowed("POST", "/iam/v4/iam/permissions");
    assertRequestAllowed("POST", "/localization/v4/Key/GetsByKeyNames");
    assertRequestAllowed("GET", "/anything");
    for (const [method, path] of [
      ["POST", "/iam/v4/iam/roles/create"],
      ["POST", "/iam/v4/iam/roles/update"],
      ["POST", "/iam/v4/iam/roles/assign-permissions"],
      ["POST", "/iam/v4/iam/permissions/create"],
      ["POST", "/iam/v4/iam/permissions/abc"],
      ["POST", "/localization/v4/Key/SaveKeys"],
      ["POST", "/localization/v4/Module/Save"],
      ["POST", "/localization/v4/Key/GenerateUilmFile"],
      ["PUT", "/iam/v4/iam/roles"]
    ]) {
      assert.throws(() => assertRequestAllowed(method, path), /read-only/, `${method} ${path}`);
    }
  });
  assertRequestAllowed("POST", "/iam/v4/iam/roles/create"); // outside the context nothing is checked
});

test("the schema checks unknown keys in iam and localization", async () => {
  const schema = await projectFileSchema();
  const good = { schemaVersion: 1, iam: { roles: [{ slug: "a", name: "A", permissions: ["p"] }], permissions: [{ name: "p" }] }, localization: { modules: [{ name: "shop", languages: ["en-US"] }] } };
  assert.deepEqual(validateProjectDocument(good, schema), []);
  assert.ok(validateProjectDocument({ schemaVersion: 1, iam: { rolez: [] } }, schema).length > 0);
  assert.ok(validateProjectDocument({ schemaVersion: 1, iam: { roles: [{ slug: "a", colour: "red" }] } }, schema).length > 0);
  assert.ok(validateProjectDocument({ schemaVersion: 1, iam: { roles: [{ name: "no slug" }] } }, schema).length > 0);
  assert.ok(validateProjectDocument({ schemaVersion: 1, localization: { modules: [{ name: "shop" }] } }, schema).length > 0);
  assert.ok(validateProjectDocument({ schemaVersion: 1, localization: { modules: [{ name: "shop", languages: ["en-US"], publish: "per-key" }] } }, schema).length > 0);
});

test("validateIamDesired rejects duplicates and parent cycles; rolesParentsFirst orders parents first", () => {
  assert.deepEqual(validateIamDesired({ permissions: [], roles: [{ slug: "a" }, { slug: "b", parentRoleSlug: "a" }] }), []);
  assert.match(validateIamDesired({ permissions: [{ name: "p" }, { name: "p" }], roles: [] })[0], /more than once/);
  assert.match(validateIamDesired({ permissions: [], roles: [{ slug: "a", parentRoleSlug: "b" }, { slug: "b", parentRoleSlug: "a" }] }).join("\n"), /cycle/);
  assert.match(validateIamDesired({ permissions: [], roles: [{ slug: "a", parentRoleSlug: "a" }] })[0], /own parent/);
  const ordered = rolesParentsFirst([{ slug: "child", parentRoleSlug: "mid" }, { slug: "mid", parentRoleSlug: "root" }, { slug: "root" }]);
  assert.deepEqual(ordered.map((role) => role.slug), ["root", "mid", "child"]);
});

test("diffIam: create, update, unchanged, blocked, not-in-file, add-only permissions", () => {
  const live = {
    permissions: [
      { itemId: "p1", name: "shop.read", resource: "shop::read", description: "Read", tags: ["b", "a"] },
      { itemId: "p2", name: "shop.extra", resource: "shop::extra" },
      { itemId: "p3", name: "sys.builtin", isBuiltIn: true }
    ],
    rolePermissions: new Map([["viewer", [{ name: "shop.read", resource: "shop::read" }, { name: "shop.extra", resource: "shop::extra" }]]]),
    roles: [
      { itemId: "r1", slug: "viewer", name: "Viewer", description: "", parentRoleSlug: null, canCreateOwn: false },
      { itemId: "r2", slug: "legacy", name: "Legacy" }
    ]
  };
  const desired = {
    permissions: [
      { name: "shop.read", description: "Read", tags: ["a", "b"] },
      { name: "shop.write", resource: "shop::write" }
    ],
    roles: [
      { slug: "viewer", name: "Viewer v2", permissions: ["shop.read", "shop.write"] },
      { slug: "editor", name: "Editor", parentRoleSlug: "viewer", permissions: ["shop::write"] },
      { slug: "broken", name: "Broken", permissions: ["no.such"] },
      { slug: "orphan", name: "Orphan", parentRoleSlug: "ghost" },
      { slug: "nameless" }
    ]
  };
  const plan = diffIam(desired, live);
  const by = (kind, name) => plan.items.find((item) => item.kind === kind && item.name === name);
  assert.equal(by("permission", "shop.read").action, "unchanged"); // tags compare as sets, "" description = none
  assert.equal(by("permission", "shop.write").action, "create");
  assert.equal(by("permission", "shop.extra").action, "not-in-file");
  assert.equal(by("permission", "sys.builtin"), undefined); // built-in permissions are not reported
  assert.equal(by("role", "viewer").action, "update");
  assert.deepEqual(by("role", "viewer").changes, ["name", "permissions (+shop.write)"]);
  assert.deepEqual(plan.missingPermissions.get("viewer"), ["shop.write"]);
  assert.equal(by("role", "editor").action, "create");
  assert.equal(by("role", "broken").action, "blocked");
  assert.match(by("role", "broken").note, /unknown permission/);
  assert.match(by("role", "orphan").note, /parent role 'ghost'/);
  assert.match(by("role", "nameless").note, /needs a name/);
  assert.equal(by("role", "legacy").action, "not-in-file");
  // viewer is listed before editor (its parent), and no item ever asks to remove anything
  assert.ok(plan.items.findIndex((item) => item.name === "viewer") < plan.items.findIndex((item) => item.name === "editor"));
});

test("diffDictionary compares only the stated culture and never returns values", () => {
  const stored = new Map([
    ["a", { resources: [{ culture: "en-US", value: "A" }, { culture: "de-DE", value: "Ah" }] }],
    ["b", { resources: [{ culture: "de-DE", value: "Be" }] }],
    ["c", { resources: [{ culture: "EN-us", value: "old" }] }]
  ]);
  const result = diffDictionary({ a: "A", b: "B", c: "new", d: "D" }, "en-US", stored);
  // b has the key but no en-US text, c's text differs (culture matched case-insensitively), d is new
  assert.deepEqual(result, { created: ["d"], updated: ["b", "c"] });
  assert.equal(expandPattern("blocks/{module}/{language}.json", "shop", "en-US"), "blocks/shop/en-US.json");
});

// ------------------------------------------------------------------ fake server, end to end

async function makeWorkspace() {
  const base = await mkdtemp(join(tmpdir(), "blocks-wp7-"));
  const cwd = join(base, "workspace");
  const configDir = join(base, "config");
  await mkdir(join(cwd, "blocks", "localization"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(cwd, "blocks.json"), `${JSON.stringify({ project: { tenantId: "target-project" } }, null, 2)}\n`);
  return { cwd, configDir };
}

async function writeProjectAuth(configDir, apiUrl) {
  const profile = {
    apiUrl, clientId: "client-id", createdAt: "2026-01-01T00:00:00.000Z",
    oidcUrl: "https://iam.example.test", osUrl: apiUrl, rootTenantId: "alpha-root",
    scope: "openid", updatedAt: "2026-01-01T00:00:00.000Z"
  };
  await writeFile(join(configDir, "config.json"), `${JSON.stringify({
    activeAccount: "alpha",
    accounts: { alpha: { ...profile, selectedProject: { tenantId: "target-project" } } }
  }, null, 2)}\n`);
  await writeFile(join(configDir, "tokens.json"), `${JSON.stringify({
    accounts: { alpha: { projects: { "target-project": { accessToken: "t", expiresAt: new Date(Date.now() + 3e6).toISOString() } } } }
  }, null, 2)}\n`);
}

function testEnv(configDir, extra = {}) {
  const base = { ...process.env };
  delete base.BLOCKS_AGENT; delete base.BLOCKS_AGENT_TOKEN;
  return { ...base, BLOCKS_CONFIG_DIR: configDir, BLOCKS_SECRET_STORE: "file", BLOCKS_OPEN_BROWSER: "0", BLOCKS_NO_UPDATE_CHECK: "1", ...extra };
}

function run(args, { cwd, env }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.stdout.on("data", (c) => stdout.push(c));
    child.stderr.on("data", (c) => stderr.push(c));
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({ status, stderr: Buffer.concat(stderr).toString("utf8"), stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });
}

/** A stateful fake of the IAM and localization endpoints the two areas call. */
async function startFakeServer() {
  const requests = [];
  const permissions = new Map();   // itemId -> row
  const roles = new Map();         // slug -> row
  const assigned = new Map();      // slug -> Set(permission itemId)
  const modules = new Map();       // name -> itemId
  const keys = new Map();          // `${moduleId}|${keyName}` -> row
  let failPath;
  let counter = 0;

  permissions.set("p-builtin", { itemId: "p-builtin", name: "sys.builtin", resource: "sys::builtin", isBuiltIn: true });

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname;
    requests.push({ method: request.method, path, body });

    let status = 200;
    let result = { isSuccess: true, data: {} };
    const list = (rows) => ({ data: body.page === 0 ? rows : [], totalCount: rows.length });

    if (failPath && path === failPath && request.method !== "GET") {
      status = 500;
      result = { message: "boom with a body that must not reach the journal" };
    } else if (request.method === "POST" && path === "/iam/v4/iam/permissions") {
      let rows = [...permissions.values()];
      if (body.roles?.length) rows = rows.filter((row) => body.roles.some((slug) => assigned.get(slug)?.has(row.itemId)));
      result = list(rows);
    } else if (request.method === "POST" && path === "/iam/v4/iam/roles") {
      result = list([...roles.values()]);
    } else if (request.method === "POST" && path === "/iam/v4/iam/permissions/create") {
      const id = `p-${++counter}`;
      permissions.set(id, { ...body, itemId: id });
    } else if (path.startsWith("/iam/v4/iam/permissions/")) {
      const id = decodeURIComponent(path.split("/").pop());
      if (request.method === "GET") result = { isSuccess: true, data: permissions.get(id) };
      else permissions.set(id, { ...permissions.get(id), ...body });
    } else if (path === "/iam/v4/iam/roles/create") {
      const id = `r-${++counter}`;
      roles.set(body.slug, { canCreateOwn: false, description: "", parentRoleSlug: null, ...body, itemId: id });
    } else if (request.method === "GET" && path.startsWith("/iam/v4/iam/roles/")) {
      const id = decodeURIComponent(path.split("/").pop());
      result = { isSuccess: true, data: [...roles.values()].find((row) => row.itemId === id) };
    } else if (path === "/iam/v4/iam/roles/update") {
      const row = [...roles.values()].find((candidate) => candidate.itemId === body.itemId);
      Object.assign(row, body);
    } else if (path === "/iam/v4/iam/roles/assign-permissions") {
      const set = assigned.get(body.slug) ?? new Set();
      for (const id of body.addPermissions ?? []) set.add(id);
      assigned.set(body.slug, set);
    } else if (request.method === "GET" && path === "/localization/v4/Module/Gets") {
      result = [...modules].map(([moduleName, itemId]) => ({ itemId, moduleName }));
    } else if (path === "/localization/v4/Module/Save") {
      modules.set(body.moduleName, `m-${++counter}`);
      result = { success: true };
    } else if (path === "/localization/v4/Key/GetsByKeyNames") {
      result = body.keyNames.map((name) => keys.get(`${body.moduleId}|${name}`)).filter(Boolean);
    } else if (path === "/localization/v4/Key/SaveKeys") {
      // Like the real endpoint: the request's Resources replace the stored ones.
      for (const key of body) keys.set(`${key.moduleId}|${key.keyName}`, { ...key, itemId: `k-${++counter}` });
      result = { success: true };
    } else if (path === "/localization/v4/Key/GenerateUilmFile") {
      result = { success: true };
    } else {
      status = 404;
      result = { message: `unexpected ${request.method} ${path}` };
    }
    response.statusCode = status;
    response.setHeader("connection", "close");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    assigned,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    fail: (path) => { failPath = path; },
    heal: () => { failPath = undefined; },
    keys,
    permissions,
    requests,
    roles,
    url: `http://127.0.0.1:${port}`,
    writes: () => requests.filter((request) => request.method !== "GET" && !READ_POSTS.has(request.path) && !request.path.endsWith("/Key/GetsByKeyNames"))
  };
}

const READ_POSTS = new Set(["/iam/v4/iam/roles", "/iam/v4/iam/permissions", "/localization/v4/Key/GetsByKeyNames"]);
const ctx = (url) => ["--account", "alpha", "--api-url", url];

const PROJECT_FILE = `schemaVersion: 1
iam:
  permissions:
    - name: shop.read
      resource: "shop::read"
      resourceGroup: shop
      description: Read orders
    - name: shop.write
      resource: "shop::write"
      resourceGroup: shop
  roles:
    - slug: shop-editor
      name: Shop editor
      parentRoleSlug: shop-viewer
      permissions: [shop.write]
    - slug: shop-viewer
      name: Shop viewer
      permissions: [shop.read]
localization:
  modules:
    - name: shop
      languages: [en-US, de-DE]
`;

async function writeFiles(cwd, { title = "Title" } = {}) {
  await writeFile(join(cwd, "blocks.project.yaml"), PROJECT_FILE);
  await writeFile(join(cwd, "blocks", "localization", "shop.en-US.json"), `${JSON.stringify({ title, cart: "Cart" }, null, 2)}\n`);
  await writeFile(join(cwd, "blocks", "localization", "shop.de-DE.json"), `${JSON.stringify({ title: "Titel", cart: "Warenkorb" }, null, 2)}\n`);
}

async function journals(cwd) {
  try {
    const names = (await readdir(join(cwd, "logs"))).filter((name) => name.startsWith("blocks-apply-")).sort();
    return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(cwd, "logs", name), "utf8"))));
  } catch { return []; }
}

async function setup() {
  const { cwd, configDir } = await makeWorkspace();
  const server = await startFakeServer();
  await writeProjectAuth(configDir, server.url);
  return { configDir, cwd, server };
}


test("plan on an empty project shows every create, exit 2, and sends no write", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    const result = await run(["plan", "--json", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(result.status, 2, result.stderr + result.stdout);
    const out = JSON.parse(result.stdout);
    const creates = out.items.filter((item) => item.action === "create").map((item) => `${item.kind} ${item.name}`).sort();
    assert.deepEqual(creates, [
      "dictionary shop/de-DE", "dictionary shop/en-US",
      "permission shop.read", "permission shop.write",
      "role shop-editor", "role shop-viewer"
    ]);
    assert.deepEqual(server.writes(), []);
    assert.equal(server.keys.size, 0);
    assert.deepEqual(await journals(cwd), []);
  } finally { await server.close(); }
});

test("apply --write: writes in order, saves unpublished, regenerates once, then plan shows no changes", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    const result = await run(["apply", "--write", "--yes", "--json", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const out = JSON.parse(result.stdout);
    assert.deepEqual(out.residual, []);
    assert.equal(out.uilm, "ok");

    const writes = server.writes().map((request) => request.path);
    const last = (path) => writes.lastIndexOf(path);
    const first = (path) => writes.indexOf(path);
    assert.ok(last("/iam/v4/iam/permissions/create") < first("/iam/v4/iam/roles/create"), writes.join(" "));
    // each role is created, then its permissions are added; parents come first (checked below)
    assert.ok(first("/iam/v4/iam/roles/create") < first("/iam/v4/iam/roles/assign-permissions"), writes.join(" "));
    assert.equal(writes.filter((path) => path === "/iam/v4/iam/roles/assign-permissions").length, 2);
    assert.ok(last("/iam/v4/iam/roles/assign-permissions") < first("/localization/v4/Key/SaveKeys"), writes.join(" "));
    assert.equal(writes.filter((path) => path === "/localization/v4/Key/SaveKeys").length, 2);
    assert.equal(writes.filter((path) => path === "/localization/v4/Key/GenerateUilmFile").length, 1, "one regeneration per module");
    assert.equal(writes.at(-1), "/localization/v4/Key/GenerateUilmFile");

    // the parent role was created before its child
    const roleCreates = server.requests.filter((request) => request.path === "/iam/v4/iam/roles/create").map((request) => request.body.slug);
    assert.deepEqual(roleCreates, ["shop-viewer", "shop-editor"]);
    // nothing is ever removed
    assert.ok(server.requests.every((request) => !request.body || !request.body.removePermissions));
    // keys saved unpublished
    assert.ok(server.requests.filter((request) => request.path.endsWith("/Key/SaveKeys")).every((request) => request.body.every((key) => key.shouldPublish === false)));
    // both cultures survived on every key (the merge reads the other culture first)
    for (const row of server.keys.values()) assert.deepEqual(row.resources.map((resource) => resource.culture).sort(), ["de-DE", "en-US"]);

    const plan = await run(["plan", "--json", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(plan.status, 0, plan.stdout + plan.stderr);
    assert.equal(JSON.parse(plan.stdout).changes, false);

    const [journal] = await journals(cwd);
    assert.deepEqual(journal.uilmPending, []);
    assert.ok(journal.entries.every((entry) => entry.status === "ok"));
    assert.ok(journal.entries.some((entry) => entry.area === "iam" && entry.kind === "role"));
    assert.ok(journal.entries.some((entry) => entry.kind === "uilm"));
  } finally { await server.close(); }
});

test("apply twice: the second run makes zero writes", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    const first = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const before = server.writes().length;
    const second = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.match(second.stdout, /Nothing to write/);
    assert.equal(server.writes().length, before);
  } finally { await server.close(); }
});

test("one changed value is one update and one key write; the other culture is kept", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    assert.equal((await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) })).status, 0);
    await writeFiles(cwd, { title: "New title" });

    const plan = await run(["plan", "--json", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(plan.status, 2, plan.stdout + plan.stderr);
    const changed = JSON.parse(plan.stdout).items.filter((item) => item.action !== "unchanged" && item.action !== "not-in-file");
    assert.equal(changed.length, 1);
    assert.equal(changed[0].name, "shop/en-US");
    assert.deepEqual(changed[0].changes, ["~title"]);

    const mark = server.writes().length;
    const applied = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    const newWrites = server.writes().slice(mark);
    const saves = newWrites.filter((request) => request.path.endsWith("/Key/SaveKeys"));
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].body.map((key) => key.keyName), ["title"]);
    assert.equal(newWrites.filter((request) => request.path.endsWith("/GenerateUilmFile")).length, 1);
    assert.equal(newWrites.filter((request) => request.path.startsWith("/iam/")).length, 0);
    const title = [...server.keys.values()].find((row) => row.keyName === "title");
    assert.equal(title.resources.find((resource) => resource.culture === "en-US").value, "New title");
    assert.equal(title.resources.find((resource) => resource.culture === "de-DE").value, "Titel");
  } finally { await server.close(); }
});

test("a role holding extra permissions is never trimmed: plan reports no change, apply sends no removal", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    assert.equal((await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) })).status, 0);
    // someone grants shop-viewer the write permission by hand
    const write = [...server.permissions.values()].find((row) => row.name === "shop.write");
    server.assigned.get("shop-viewer").add(write.itemId);
    const plan = await run(["plan", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(plan.status, 0, plan.stdout + plan.stderr);
    const mark = server.writes().length;
    const applied = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(applied.status, 0);
    assert.equal(server.writes().length, mark);
    assert.ok(server.assigned.get("shop-viewer").has(write.itemId));
  } finally { await server.close(); }
});

test("a role naming an unknown permission is blocked: exit 2 on plan, and apply writes nothing", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    await writeFile(join(cwd, "blocks.project.yaml"), "schemaVersion: 1\niam:\n  roles:\n    - slug: r\n      name: R\n      permissions: [does.not.exist]\n");
    const plan = await run(["plan", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(plan.status, 2);
    assert.match(plan.stdout, /! blocked\s+role r.*unknown permission\(s\): does\.not\.exist/);
    const applied = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(applied.status, 1);
    assert.match(applied.stderr, /Nothing was written: 1 item\(s\) are blocked/);
    assert.deepEqual(server.writes(), []);
  } finally { await server.close(); }
});

test("a missing dictionary file fails the plan before any request, naming the file and no value", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFile(join(cwd, "blocks.project.yaml"), "schemaVersion: 1\nlocalization:\n  modules:\n    - name: shop\n      languages: [fr-FR]\n");
    const plan = await run(["plan", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(plan.status, 1);
    assert.match(plan.stderr, /shop\/fr-FR: dictionary file does not exist/);
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test("a failed UILM regeneration is journaled as pending, and the next run finishes it without rewriting keys", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    server.fail("/localization/v4/Key/GenerateUilmFile");
    const first = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(first.status, 1, first.stderr + first.stdout);
    assert.match(first.stderr, /UILM file was not regenerated/);
    assert.doesNotMatch(first.stdout + first.stderr, /boom with a body/);
    const [journal] = await journals(cwd);
    assert.deepEqual(journal.uilmPending, ["shop"]);

    server.heal();
    const dry = await run(["apply", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /did not regenerate the UILM file of: shop/);

    const mark = server.writes().length;
    const second = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(second.status, 0, second.stderr + second.stdout);
    const newWrites = server.writes().slice(mark).map((request) => request.path);
    assert.deepEqual(newWrites, ["/localization/v4/Key/GenerateUilmFile"]);
  } finally { await server.close(); }
});

test("a failure in IAM stops later areas, names the step, and a re-run finishes only what is missing", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    server.fail("/iam/v4/iam/roles/create");
    const first = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(first.status, 1);
    assert.match(first.stderr, /Apply stopped at role shop-viewer/);
    assert.equal(server.keys.size, 0, "localization did not run");
    assert.doesNotMatch(first.stdout + first.stderr, /boom with a body/);
    assert.equal([...server.permissions.values()].filter((row) => !row.isBuiltIn).length, 2, "permissions written before the failure stay");

    server.heal();
    const second = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.equal(server.requests.filter((request) => request.path === "/iam/v4/iam/permissions/create").length, 2, "permissions are not created twice");
    const plan = await run(["plan", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  } finally { await server.close(); }
});
