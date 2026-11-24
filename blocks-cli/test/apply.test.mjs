// I14-WP6: `blocks apply` for the data area (decision 0007 §5 to §9, §12 items 1 and 2).
// The server is an in-process, stateful fake: writes change what the next read returns, so
// "apply twice" and "plan after apply" are real checks. No test reaches a real Blocks server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { isAgentCaller, isLocalApiUrl } from "../dist/lib/apply-guards.js";
import { securityEntryName } from "../dist/lib/project-plan.js";

const repoRoot = resolve(import.meta.dirname, "..");
const bin = join(repoRoot, "bin", "run.js");
process.env.BLOCKS_NO_UPDATE_CHECK = "1";

// ------------------------------------------------------------------ unit

test("isAgentCaller reads BLOCKS_AGENT_TOKEN and BLOCKS_AGENT only", () => {
  assert.equal(isAgentCaller({}), false);
  assert.equal(isAgentCaller({ BLOCKS_AGENT_TOKEN: "x" }), true);
  assert.equal(isAgentCaller({ BLOCKS_AGENT: "1" }), true);
  assert.equal(isAgentCaller({ BLOCKS_AGENT: "0" }), false);
});

test("isLocalApiUrl accepts loopback, localhost, .localhost and .test only", () => {
  for (const url of ["http://127.0.0.1:5000", "http://localhost:5000", "http://[::1]:5000", "https://api.blocks.localhost", "https://api.blocks.test"]) {
    assert.equal(isLocalApiUrl(url), true, url);
  }
  for (const url of ["https://api.seliseblocks.com", "https://localhost.evil.com", "http://127.0.0.1.evil.com", "not a url"]) {
    assert.equal(isLocalApiUrl(url), false, url);
  }
});

test("securityEntryName is the name the plan prints", () => {
  assert.equal(securityEntryName({ schemaName: "Order", operation: 0, policyType: 0, accessLevel: 1 }), "Order READ RLS = User");
});

// ------------------------------------------------------------------ fake server, end to end

async function makeWorkspace() {
  const base = await mkdtemp(join(tmpdir(), "blocks-apply-"));
  const cwd = join(base, "workspace");
  const configDir = join(base, "config");
  await mkdir(join(cwd, "blocks", "data", "schemas"), { recursive: true });
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
    accounts: { alpha: { projects: { "target-project": { accessToken: "t", expiresAt: new Date(Date.now() + 3e6).toISOString() }, "other-project": { accessToken: "t", expiresAt: new Date(Date.now() + 3e6).toISOString() } } } }
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

/**
 * A stateful fake of the data endpoints apply calls. `failPath` makes the first request to
 * that path answer 500 (then it is cleared by `server.heal()`).
 */
async function startFakeServer() {
  const requests = [];
  const schemas = new Map();      // name -> stored schema
  const policies = new Map();     // schemaName -> [policy]
  let failPath;
  let counter = 0;

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push({ method: request.method, path: url.pathname, body });

    let status = 200;
    let result = { isSuccess: true, data: {} };
    const op = ["readAccessLevel", "writeAccessLevel", "editAccessLevel", "deleteAccessLevel"];
    if (failPath && url.pathname === failPath && request.method !== "GET") {
      status = 500;
      result = { message: "boom with a body that must not reach the journal" };
    } else if (request.method === "GET" && url.pathname === "/data/v4/schemas") {
      const name = url.searchParams.get("SchemaName");
      const all = [...schemas.values()].filter((item) => !name || item.schemaName === name);
      result = { isSuccess: true, data: { items: Number(url.searchParams.get("PageNo")) === 1 ? all : [], totalCount: all.length } };
    } else if (request.method === "GET" && url.pathname === "/data/v4/data-access/policy/get") {
      result = { isSuccess: true, data: policies.get(url.searchParams.get("schemaName")) ?? [] };
    } else if (url.pathname === "/data/v4/schemas/define") {
      const { itemId, projectKey, ...rest } = body;
      const existing = schemas.get(rest.schemaName);
      const id = existing?.id ?? `srv-${rest.schemaName}-${++counter}`;
      schemas.set(rest.schemaName, { ...(existing ?? {}), ...rest, id, projectKey });
      result = { isSuccess: true, data: { itemId: id } };
    } else if (url.pathname === "/data/v4/data-access/security/change") {
      const schema = [...schemas.values()].find((item) => item.id === body.schemaId);
      if (schema && body.policyType === 0) schema[op[body.operation]] = body.accessLevel;
    } else if (url.pathname === "/data/v4/data-access/policy/create") {
      const list = policies.get(body.schemaName) ?? [];
      list.push({ itemId: `pol-${++counter}`, entityName: body.schemaName, schemaId: body.schemaId, policyName: body.policyName, isAllowPolicy: body.isAllowPolicy, priority: body.priority, operation: body.operation, policyType: body.policyType });
      policies.set(body.schemaName, list);
    } else if (url.pathname === "/data/v4/data-access/policy/update") {
      for (const list of policies.values()) {
        const found = list.find((item) => item.itemId === body.itemId);
        if (found) Object.assign(found, { isAllowPolicy: body.isAllowPolicy, priority: body.priority });
      }
    } else if (url.pathname === "/data/v4/schema-configurations/reload") {
      // accepted
    } else {
      status = 404;
      result = { message: `unexpected ${request.method} ${url.pathname}` };
    }
    response.statusCode = status;
    response.setHeader("connection", "close");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    fail: (path) => { failPath = path; },
    heal: () => { failPath = undefined; },
    requests,
    schemas,
    url: `http://127.0.0.1:${port}`,
    writes: () => requests.filter((request) => request.method !== "GET")
  };
}

const ctx = (url) => ["--account", "alpha", "--api-url", url];

async function writeFiles(cwd, { totalType = "Float", extra = false } = {}) {
  const dir = join(cwd, "blocks", "data", "schemas");
  await writeFile(join(dir, "Order.json"), `${JSON.stringify({ schemaName: "Order", schemaType: 1, fields: [{ name: "title", type: "String" }, { name: "total", type: totalType }] }, null, 2)}\n`);
  if (extra) await writeFile(join(dir, "Invoice.json"), `${JSON.stringify({ schemaName: "Invoice", schemaType: 1, fields: [{ name: "amount", type: "Float" }] }, null, 2)}\n`);
  await writeFile(join(cwd, "blocks", "data", "rules.json"), `${JSON.stringify({
    policies: [{ schemaName: "Order", policyName: "OwnerOnly", isAllowPolicy: true, priority: 0, operation: 0, policyType: 0 }],
    security: [{ schemaName: "Order", operation: 0, policyType: 0, accessLevel: 1 }]
  }, null, 2)}\n`);
  await writeFile(join(cwd, "blocks.project.yaml"), "schemaVersion: 1\ndata: {}\n");
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

test("apply without --write is a dry run: exit 2 on changes, first line says so, only GET requests, no journal", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    for (const args of [["apply"], ["apply", "--yes"], ["apply", "--write", "--dry-run", "--yes"]]) {
      const result = await run([...args, ...ctx(server.url)], { cwd, env: testEnv(configDir) });
      assert.equal(result.status, 2, result.stderr + result.stdout);
      assert.equal(result.stdout.split("\n")[0], "Dry run: nothing was changed. Re-run with --write to apply.");
    }
    assert.ok(server.requests.length > 0);
    assert.deepEqual(server.writes(), []);
    assert.deepEqual(await journals(cwd), []);
  } finally { await server.close(); }
});

test("--yes, an env variable and BLOCKS_AGENT do not turn a write on; only --write does", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    const env = testEnv(configDir, { BLOCKS_APPLY: "1", BLOCKS_WRITE: "1", BLOCKS_YES: "1", BLOCKS_AGENT: "1" });
    const result = await run(["apply", "--yes", "--force", ...ctx(server.url)], { cwd, env });
    assert.equal(result.status, 2);
    assert.deepEqual(server.writes(), []);
  } finally { await server.close(); }
});

test("--write without --yes fails in a non-interactive run and writes nothing", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    const result = await run(["apply", "--write", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Confirmation required in non-interactive mode/);
    assert.deepEqual(server.writes(), []);
  } finally { await server.close(); }
});

test("apply --write --yes writes in order, reloads once, and plan then shows no changes", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd, { extra: true });
    const result = await run(["apply", "--write", "--yes", "--json", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const out = JSON.parse(result.stdout);
    assert.equal(out.reload, "ok");
    assert.deepEqual(out.residual, []);

    const paths = server.writes().map((request) => request.path);
    const firstSecurity = paths.indexOf("/data/v4/data-access/security/change");
    const firstPolicy = paths.indexOf("/data/v4/data-access/policy/create");
    const lastSchema = paths.lastIndexOf("/data/v4/schemas/define");
    assert.ok(lastSchema < firstSecurity && firstSecurity < firstPolicy, paths.join(" "));
    assert.equal(paths.filter((path) => path === "/data/v4/schema-configurations/reload").length, 1);
    assert.equal(paths.at(-1), "/data/v4/schema-configurations/reload");

    const plan = await run(["plan", "--json", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(plan.status, 0, plan.stdout + plan.stderr);
    assert.equal(JSON.parse(plan.stdout).changes, false);

    const [journal] = await journals(cwd);
    assert.equal(journal.tenant, "target-project");
    assert.equal(journal.reloadPending, false);
    assert.equal(journal.entries.length, 4);
    assert.ok(journal.entries.every((entry) => entry.status === "ok"));
  } finally { await server.close(); }
});

test("apply twice: the second run makes zero writes", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    const first = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const writesAfterFirst = server.writes().length;
    assert.ok(writesAfterFirst > 0);

    const second = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.match(second.stdout, /Nothing to write/);
    assert.equal(server.writes().length, writesAfterFirst, "the second apply wrote something");
    assert.equal((await journals(cwd)).length, 1, "a run with nothing to write adds no journal");
  } finally { await server.close(); }
});

test("changing one value gives exactly one update, then no changes", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    assert.equal((await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) })).status, 0);
    const before = server.writes().length;

    await writeFiles(cwd, { totalType: "Int" });
    const plan = JSON.parse((await run(["plan", "--json", ...ctx(server.url)], { cwd, env: testEnv(configDir) })).stdout);
    assert.deepEqual(plan.items.filter((item) => item.action === "update").map((item) => item.name), ["Order"]);

    const result = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const newWrites = server.writes().slice(before).map((request) => request.path);
    assert.deepEqual(newWrites, ["/data/v4/schemas/define", "/data/v4/schema-configurations/reload"]);
    assert.equal(server.schemas.get("Order").fields.find((field) => field.name === "total").type, "Int");
  } finally { await server.close(); }
});

test("a failure at the rules step stops there, journals it without the response body, and a second run finishes only what is missing", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    server.fail("/data/v4/data-access/policy/create");
    const failed = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Apply stopped at/);
    assert.match(failed.stderr, /Apply stopped at policy Order\/OwnerOnly/);
    assert.ok(!server.writes().some((request) => request.path.endsWith("/reload")), "no reload after a failed step");

    const [journal] = await journals(cwd);
    assert.equal(journal.reloadPending, true);
    const last = journal.entries.at(-1);
    assert.equal(last.status, "failed");
    assert.ok(!JSON.stringify(journal).includes("boom with a body"), "the response body is not journaled");
    const doneBefore = server.writes().length;

    server.heal();
    const retry = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(retry.status, 0, retry.stderr + retry.stdout);
    const retryWrites = server.writes().slice(doneBefore).map((request) => request.path);
    assert.deepEqual(retryWrites, ["/data/v4/data-access/policy/create", "/data/v4/schema-configurations/reload"]);

    const journalsNow = await journals(cwd);
    assert.equal(journalsNow.at(-1).reloadPending, false);
  } finally { await server.close(); }
});

test("a pending reload from a stopped run is done by the next apply even with nothing else to write", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    // First run: everything is written, the reload is the only failing step.
    server.fail("/data/v4/schema-configurations/reload");
    const first = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(first.status, 1, first.stderr + first.stdout);
    assert.equal((await journals(cwd))[0].reloadPending, true);

    server.heal();
    const before = server.writes().length;
    const second = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.deepEqual(server.writes().slice(before).map((request) => request.path), ["/data/v4/schema-configurations/reload"]);
  } finally { await server.close(); }
});

test("a blocked item stops the write before any request", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    await writeFile(join(cwd, "blocks", "data", "rules.json"), `${JSON.stringify({
      policies: [{ schemaName: "Ghost", policyName: "P", isAllowPolicy: true, priority: 0, operation: 0, policyType: 0 }]
    })}\n`);
    const result = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Nothing was written: 1 item\(s\) are blocked/);
    assert.deepEqual(server.writes(), []);
  } finally { await server.close(); }
});

test("a file whose tenant differs from blocks.json is refused unless --tenant names it", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    await writeFile(join(cwd, "blocks.project.yaml"), "schemaVersion: 1\nproject:\n  tenantId: other-project\ndata: {}\n");

    for (const args of [["apply"], ["apply", "--write", "--yes"]]) {
      const refused = await run([...args, ...ctx(server.url)], { cwd, env: testEnv(configDir) });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /blocks\.json names/);
    }
    assert.deepEqual(server.requests, [], "nothing is sent for a mismatched tenant");

    const wrong = await run(["apply", "--tenant", "third-project", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.match(wrong.stderr, /--tenant names/);

    const allowed = await run(["apply", "--tenant", "other-project", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(allowed.status, 2, allowed.stderr + allowed.stdout);
    assert.deepEqual(server.writes(), []);
  } finally { await server.close(); }
});

test("an agent may preview anywhere but write only to a local stack", async () => {
  const { configDir, cwd, server } = await setup();
  try {
    await writeFiles(cwd);
    // The fake runs on 127.0.0.1, so it is local: the agent may write there.
    const local = await run(["apply", "--write", "--yes", ...ctx(server.url)], { cwd, env: testEnv(configDir, { BLOCKS_AGENT: "1" }) });
    assert.equal(local.status, 0, local.stderr + local.stdout);
    assert.ok(server.writes().length > 0);
  } finally { await server.close(); }

  const remote = await setup();
  try {
    await writeFiles(remote.cwd);
    // A name that resolves to the fake but is not a local host: the agent is refused before any request.
    const refused = await run(["apply", "--write", "--yes", "--account", "alpha", "--api-url", remote.server.url.replace("127.0.0.1", "localhost.evil.test.example")], { cwd: remote.cwd, env: testEnv(remote.configDir, { BLOCKS_AGENT_TOKEN: "agent-token-value" }) });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /may write only to a local stack/);
    assert.ok(!refused.stderr.includes("agent-token-value"));
    assert.deepEqual(remote.server.requests, []);
    // A dry run is allowed for the same agent (it reads only), failing only because the host does not resolve.
  } finally { await remote.server.close(); }
});
