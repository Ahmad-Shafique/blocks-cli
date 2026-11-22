// I14-WP5: the project file and `blocks plan` for the data area (decision 0007 §11 step 1, §12 items 1 and 2).
// Every server here is the in-process fake below; no test reaches a real Blocks server.
// Secret values in this file are obvious fakes ("test-secret-value").
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import test from "node:test";

import { findDuplicateJsonKey, parseYamlLite } from "../dist/lib/yaml-lite.js";
import {
  findLiteralSecrets,
  looksLikeHighEntropySecret,
  mergeOverlay,
  parseProjectText,
  projectFileSchema,
  resolveSecretRefs,
  substituteEnv,
  validateProjectDocument
} from "../dist/lib/project-file.js";
import { diffPolicies, diffSchemas, diffSecurity, hasChanges, summarize } from "../dist/lib/project-plan.js";
import { assertRequestAllowed, runReadOnly } from "../dist/lib/read-only-requests.js";
import { blocksRequest } from "../dist/lib/api.js";

const repoRoot = resolve(import.meta.dirname, "..");
const bin = join(repoRoot, "bin", "run.js");
process.env.BLOCKS_NO_UPDATE_CHECK = "1";

const FAKE_SECRET = "test-secret-value";

// ------------------------------------------------------------------ parser

const EXAMPLE_YAML = `# The 0007 §3 shape, trimmed
schemaVersion: 1                # integer
project:
  tenantId: "\${env:BLOCKS_TENANT_ID}"
  name: acme-shop

data:
  schemas: blocks/data/schemas/   # folder
  rules:   blocks/data/rules.json
  newSchemaAccess: user

iam:
  roles:
    - slug: shop-admin
      name: Shop admin
      parentRoleSlug: null
      permissions: [shop.orders.read, shop.orders.write]
    - slug: shop-viewer
      permissions:
      - shop.orders.read
mail:
  configs:
    - name: outbound
      clientSecret: { secretRef: MAIL_SMTP_PASSWORD }   # a reference, never a value
      url: https://app.example.test/callback
      label: 'it''s quoted'
secrets:
  required: [MAIL_SMTP_PASSWORD]
`;

test("yaml-lite parses the 0007 example shape", () => {
  const doc = parseYamlLite(EXAMPLE_YAML);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.project.tenantId, "${env:BLOCKS_TENANT_ID}");
  assert.equal(doc.data.schemas, "blocks/data/schemas/");
  assert.equal(doc.data.rules, "blocks/data/rules.json");
  assert.deepEqual(doc.iam.roles[0], {
    slug: "shop-admin", name: "Shop admin", parentRoleSlug: null, permissions: ["shop.orders.read", "shop.orders.write"]
  });
  assert.deepEqual(doc.iam.roles[1], { slug: "shop-viewer", permissions: ["shop.orders.read"] });
  assert.deepEqual(doc.mail.configs[0].clientSecret, { secretRef: "MAIL_SMTP_PASSWORD" });
  assert.equal(doc.mail.configs[0].url, "https://app.example.test/callback");
  assert.equal(doc.mail.configs[0].label, "it's quoted");
  assert.deepEqual(doc.secrets.required, ["MAIL_SMTP_PASSWORD"]);
});

test("yaml-lite keeps YAML 1.2 core scalars: yes/no stay strings, numbers and booleans are typed", () => {
  assert.deepEqual(parseYamlLite("a: yes\nb: no\nc: true\nd: 12\ne: 1.5\nf: ~\ng: \"x # not a comment\"\n"), {
    a: "yes", b: "no", c: true, d: 12, e: 1.5, f: null, g: "x # not a comment"
  });
});

test("yaml-lite rejects duplicate keys, anchors, aliases, merge keys, tags, block scalars, tabs and several documents", () => {
  const cases = [
    ["a: 1\na: 2\n", /line 2: duplicate key 'a'/],
    ["a:\n  b: 1\n  b: 2\n", /duplicate key 'b'/],
    ["a: { x: 1, x: 2 }\n", /duplicate key 'x'/],
    ["base: &b\n  x: 1\n", /anchors/],
    ["a: *b\n", /anchors and aliases/],
    ["a:\n  <<: { x: 1 }\n", /merge keys/],
    ["a: !secret x\n", /tags/],
    ["a: |\n  text\n", /block scalars/],
    ["a:\n\tb: 1\n", /tabs/],
    ["a: 1\n---\nb: 2\n", /only one YAML document/],
    ["a: b: c\n", /quote it/],
    ["a:\n  b: 1\n c: 2\n", /indentation/]
  ];
  for (const [text, pattern] of cases) {
    assert.throws(() => parseYamlLite(text), pattern, JSON.stringify(text));
  }
});

test("JSON is accepted with the same rules, and its duplicate keys are rejected too", () => {
  assert.deepEqual(parseProjectText('{"schemaVersion": 1, "data": {}}', "blocks.project.json"), { schemaVersion: 1, data: {} });
  assert.deepEqual(findDuplicateJsonKey('{"a": {"b": 1}, "c": [{"b": 2}]}'), undefined);
  assert.throws(() => parseProjectText('{\n "schemaVersion": 1,\n "schemaVersion": 2\n}', "blocks.project.json"), /line 3: duplicate key 'schemaVersion'/);
  assert.throws(() => parseProjectText("{ nope", "blocks.project.json"), /not valid JSON/);
});

// ------------------------------------------------------------------ schema

test("the JSON Schema accepts the example and rejects unknown keys, bad values and a newer schemaVersion", async () => {
  const schema = await projectFileSchema();
  const doc = parseYamlLite(EXAMPLE_YAML);
  assert.deepEqual(validateProjectDocument(doc, schema), []);

  const errorsFor = (value) => validateProjectDocument(value, schema).join("\n");
  assert.match(errorsFor({ schemaVersion: 1, dta: {} }), /dta: unknown key/);
  assert.match(errorsFor({ schemaVersion: 1, data: { schema: "x" } }), /data\.schema: unknown key/);
  assert.match(errorsFor({ schemaVersion: 1, data: { newSchemaAccess: "everyone" } }), /data\.newSchemaAccess: must be one of "user", "public"/);
  assert.match(errorsFor({ data: {} }), /missing required key 'schemaVersion'/);
  assert.match(errorsFor({ schemaVersion: "1" }), /schemaVersion: must be integer/);
  assert.match(errorsFor({ schemaVersion: 2 }), /newer than this CLI knows/);
  assert.match(errorsFor({ schemaVersion: 1, secrets: { required: ["bad name"] } }), /secrets\.required\[0\]: does not match/);
  assert.match(errorsFor({ schemaVersion: 1, mail: { x: { secretRef: "A", extra: 1 } } }), /mail\.x: a secret reference is exactly/);
});

// ------------------------------------------------------------------ secrets

test("a literal secret is found by field name or shape, and its value is never in the report", () => {
  const hits = findLiteralSecrets({
    schemaVersion: 1,
    mail: { configs: [{ name: "outbound", clientSecret: FAKE_SECRET, accountPassword: { secretRef: "MAIL_PASSWORD" } }] },
    project: { name: "Xk9fAkEq2Lm7TeSt8Rv4Wz1Np6/Yc3Hd5" },
    logic: { token: "ghp_testfaketokenvalue000000000000" }
  });
  assert.deepEqual(hits.map((hit) => hit.path), ["mail.configs[0].clientSecret", "project.name", "logic.token"]);
  assert.ok(!JSON.stringify(hits).includes(FAKE_SECRET));
});

test("the high-entropy check passes names, paths, URLs, UUIDs and hex ids", () => {
  for (const value of [
    "blocks/data/schemas/",
    "https://app.example.test/callback?state=abcdefghijkl",
    "3f2b8c1e-9d4a-4b7e-8f6a-1c2d3e4f5a6b",
    "0123456789abcdef0123456789abcdef01234567",
    "./node_modules/@seliseblocks/cli-os/schema/blocks.project.schema.json",
    "acme-shop-production-environment"
  ]) {
    assert.equal(looksLikeHighEntropySecret(value), false, value);
  }
  assert.equal(looksLikeHighEntropySecret("Xk9fAkEq2Lm7TeSt8Rv4Wz1Np6/Yc3Hd5"), true);
});

test("${env:NAME} is substituted for non-secret values only", () => {
  assert.deepEqual(substituteEnv({ project: { tenantId: "${env:T}" }, n: 1 }, { T: "tenant-1" }), { project: { tenantId: "tenant-1" }, n: 1 });
  assert.throws(() => substituteEnv({ a: "${env:MAIL_PASSWORD}" }, { MAIL_PASSWORD: FAKE_SECRET }), /looks like a secret/);
  assert.throws(() => substituteEnv({ a: "${env:API_KEY}" }, {}), /looks like a secret/);
  assert.throws(() => substituteEnv({ a: "${env:UNSET_VAR}" }, {}), /UNSET_VAR is not set/);
  assert.deepEqual(substituteEnv({ s: { secretRef: "X" } }, {}), { s: { secretRef: "X" } });
});

test("an overlay merges mappings key by key and replaces lists and scalars", () => {
  const base = { schemaVersion: 1, project: { tenantId: "dev-tenant", name: "shop" }, data: { newSchemaAccess: "user" }, secrets: { required: ["A", "B"] } };
  const overlay = { project: { tenantId: "prod-tenant" }, secrets: { required: ["C"] } };
  assert.deepEqual(mergeOverlay(base, overlay), {
    schemaVersion: 1, project: { tenantId: "prod-tenant", name: "shop" }, data: { newSchemaAccess: "user" }, secrets: { required: ["C"] }
  });
});

test("secretRef values resolve in memory and never print, serialise or inspect as the value", async () => {
  const doc = { mail: { configs: [{ name: "outbound", clientSecret: { secretRef: "MAIL_SMTP_PASSWORD" } }] } };
  const resolved = await resolveSecretRefs(doc, async (name) => (name === "MAIL_SMTP_PASSWORD" ? FAKE_SECRET : undefined));
  const secret = resolved.mail.configs[0].clientSecret;
  assert.equal(secret.reveal(), FAKE_SECRET);
  for (const text of [JSON.stringify(resolved), String(secret), `${secret}`, inspect(resolved, { depth: 10 })]) {
    assert.ok(!text.includes(FAKE_SECRET), text);
    assert.match(text, /\(secret\)/);
  }
  assert.deepEqual(doc.mail.configs[0].clientSecret, { secretRef: "MAIL_SMTP_PASSWORD" }, "the input document is not changed");

  await assert.rejects(resolveSecretRefs({ a: { secretRef: "MISSING_ONE" } }, async () => undefined), /not found in Blocks Secrets: MISSING_ONE/);
});

// ------------------------------------------------------------------ diff engine

const LIVE_ORDER = {
  id: "srv-order", schemaName: "Order", schemaType: 1, collectionName: "sb_Orders", projectKey: "target-project",
  readAccessLevel: 1, writeAccessLevel: "User",
  fields: [{ name: "ItemId", type: "String" }, { name: "title", type: "String", readAccessLevel: 1 }, { name: "total", type: "Float" }]
};

test("diffSchemas reports create, update (field names only), unchanged and not-in-file", () => {
  const items = diffSchemas(
    [
      { schemaName: "Order", schemaType: 1, fields: [{ name: "total", type: "Float" }, { name: "title", type: "String" }] },
      { schemaName: "Customer", itemId: "some-other-project-id", schemaType: 1, fields: [{ name: "email", type: "Int" }, { name: "phone", type: "String" }] },
      { schemaName: "Invoice", schemaType: 1, fields: [] }
    ],
    [
      LIVE_ORDER,
      { id: "srv-customer", schemaName: "Customer", schemaType: 1, fields: [{ name: "email", type: "String" }, { name: "legacy", type: "String" }] },
      { id: "srv-legacy", schemaName: "Legacy", schemaType: 1, fields: [] }
    ],
    "public"
  );
  assert.deepEqual(items.map((item) => [item.action, item.name]), [
    ["unchanged", "Order"], ["update", "Customer"], ["create", "Invoice"], ["not-in-file", "Legacy"]
  ]);
  assert.deepEqual(items[1].changes, ["fields.email.type", "fields.phone (new)", "fields.legacy (removed)"]);
  assert.match(items[2].note, /Public access/);
});

test("diffPolicies blocks a policy on an unknown schema and creates one for a schema the file creates", () => {
  const live = new Map([["Order", [{ itemId: "p1", entityName: "", policyName: "OwnerOnly", isAllowPolicy: true, priority: 0 }, { itemId: "p2", policyName: "Old" }]]]);
  const items = diffPolicies(
    [
      { schemaName: "Order", policyName: "OwnerOnly", isAllowPolicy: true, priority: 0 },
      { schemaName: "Order", policyName: "New", isAllowPolicy: true },
      { schemaName: "Invoice", policyName: "Mine" },
      { schemaName: "Ghost", policyName: "X" }
    ],
    live, new Set(["Order"]), new Set(["Order", "Invoice"])
  );
  assert.deepEqual(items.map((item) => [item.action, item.name]), [
    ["unchanged", "Order/OwnerOnly"], ["create", "Order/New"], ["create", "Invoice/Mine"], ["blocked", "Ghost/X"], ["not-in-file", "Order/Old"]
  ]);
});

test("diffSecurity reads the live access level as an ordinal or a name", () => {
  const items = diffSecurity(
    [
      { schemaName: "Order", operation: 0, policyType: 0, accessLevel: 1 },
      { schemaName: "Order", operation: 1, policyType: 0, accessLevel: 2 },
      { schemaName: "Order", operation: 0, policyType: 1, accessLevel: 1, fieldNames: ["title"] },
      { schemaName: "Nope", operation: 0, policyType: 0, accessLevel: 1 }
    ],
    [LIVE_ORDER], new Set(["Order"])
  );
  assert.deepEqual(items.map((item) => item.action), ["unchanged", "update", "unchanged", "blocked"]);
  assert.deepEqual(items[1].changes, ["writeAccessLevel"]);
});

test("exit-code rule: create, update and blocked are changes; unchanged and not-in-file are not", () => {
  const item = (action) => ({ action, area: "data", kind: "schema", name: "x" });
  assert.equal(hasChanges([item("unchanged"), item("not-in-file")]), false);
  for (const action of ["create", "update", "blocked"]) assert.equal(hasChanges([item("unchanged"), item(action)]), true, action);
  assert.deepEqual(summarize([item("create"), item("create"), item("not-in-file")]), { create: 2, update: 0, unchanged: 0, "not-in-file": 1, blocked: 0 });
});

// ------------------------------------------------------------------ read-only context

test("the read-only request context refuses every non-GET request before it is sent", async () => {
  assert.doesNotThrow(() => assertRequestAllowed("POST", "/data/v4/schemas/define"), "outside the context writes are not affected");
  await runReadOnly("blocks plan", async () => {
    assert.doesNotThrow(() => assertRequestAllowed("GET", "/data/v4/schemas"));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.throws(() => assertRequestAllowed(method, "/data/v4/schemas/define"), /read-only/);
    }
    // Through the real request function: refused before config, auth or network are touched.
    await assert.rejects(blocksRequest("/data/v4/schemas/define", { body: { schemaName: "x" } }), (error) => error.code === "read_only_violation");
    await assert.rejects(blocksRequest("/data/v4/schemas/define", { method: "PUT" }), (error) => error.code === "read_only_violation");
  });
});

// ------------------------------------------------------------------ fake server, end to end

async function makeWorkspace() {
  const base = await mkdtemp(join(tmpdir(), "blocks-plan-"));
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
    accounts: { alpha: { projects: { "target-project": { accessToken: "t", expiresAt: new Date(Date.now() + 3e6).toISOString() } } } }
  }, null, 2)}\n`);
}

function testEnv(configDir, extra = {}) {
  return { ...process.env, BLOCKS_CONFIG_DIR: configDir, BLOCKS_SECRET_STORE: "file", BLOCKS_OPEN_BROWSER: "0", BLOCKS_NO_UPDATE_CHECK: "1", ...extra };
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

/** Fake Blocks API for the data readers. Records every request; answers writes too, so a write would be seen, not hidden by a 404. */
async function startFakeServer({ schemas, policies }) {
  const requests = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });

    let status = 200;
    let result;
    if (request.method === "GET" && url.pathname === "/data/v4/schemas") {
      result = { isSuccess: true, data: { items: Number(url.searchParams.get("PageNo")) === 1 ? schemas : [], totalCount: schemas.length } };
    } else if (request.method === "GET" && url.pathname === "/data/v4/data-access/policy/get") {
      result = { isSuccess: true, data: policies[url.searchParams.get("schemaName")] ?? [] };
    } else if (request.method !== "GET") {
      result = { isSuccess: true, data: { itemId: "written" } };
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
    requests,
    url: `http://127.0.0.1:${port}`
  };
}

const LIVE_SCHEMAS = [
  LIVE_ORDER,
  { id: "srv-legacy", schemaName: "Legacy", schemaType: 1, fields: [{ name: "ItemId", type: "String" }] }
];
const LIVE_POLICIES = {
  Order: [{ itemId: "p1", entityName: "", schemaId: "srv-order", policyName: "OwnerOnly", isAllowPolicy: true, priority: 0, operation: 0, policyType: 0 }]
};

async function writeDataFiles(cwd, { orderFields, extraSchema, legacy = true } = {}) {
  const dir = join(cwd, "blocks", "data", "schemas");
  await writeFile(join(dir, "Order.json"), `${JSON.stringify({ schemaName: "Order", schemaType: 1, fields: orderFields ?? [{ name: "title", type: "String" }, { name: "total", type: "Float" }] }, null, 2)}\n`);
  if (legacy) await writeFile(join(dir, "Legacy.json"), `${JSON.stringify({ schemaName: "Legacy", schemaType: 1, fields: [] }, null, 2)}\n`);
  if (extraSchema) await writeFile(join(dir, `${extraSchema.schemaName}.json`), `${JSON.stringify(extraSchema, null, 2)}\n`);
  await writeFile(join(cwd, "blocks", "data", "rules.json"), `${JSON.stringify({
    policies: [{ schemaName: "Order", policyName: "OwnerOnly", isAllowPolicy: true, priority: 0, operation: 0, policyType: 0 }],
    security: [{ schemaName: "Order", operation: 0, policyType: 0, accessLevel: 1 }]
  }, null, 2)}\n`);
}

const ctx = (url) => ["--account", "alpha", "--api-url", url];

function assertOnlyGets(requests) {
  assert.ok(requests.length > 0, "plan read the live project");
  const others = requests.filter((request) => request.method !== "GET");
  assert.deepEqual(others, [], `plan sent a non-GET request: ${JSON.stringify(others)}`);
}

test("plan exits 0 when the project matches the file, and sends only GET requests", async () => {
  const { cwd, configDir } = await makeWorkspace();
  const server = await startFakeServer({ schemas: LIVE_SCHEMAS, policies: LIVE_POLICIES });
  try {
    await writeProjectAuth(configDir, server.url);
    await writeDataFiles(cwd);
    await writeFile(join(cwd, "blocks.project.yaml"), "schemaVersion: 1\ndata: {}\n");

    const result = await run(["plan", "--json", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.changes, false);
    assert.equal(plan.tenant, "target-project");
    assert.deepEqual(plan.summary, { create: 0, update: 0, unchanged: 4, "not-in-file": 0, blocked: 0 });
    assertOnlyGets(server.requests);
    assert.deepEqual([...new Set(server.requests.map((r) => r.path))].sort(), ["/data/v4/data-access/policy/get", "/data/v4/schemas"]);
  } finally { await server.close(); }
});

test("plan exits 2 on changes, lists them by area with + ~ - symbols, and still sends only GET requests", async () => {
  const { cwd, configDir } = await makeWorkspace();
  const server = await startFakeServer({ schemas: LIVE_SCHEMAS, policies: LIVE_POLICIES });
  try {
    await writeProjectAuth(configDir, server.url);
    await writeDataFiles(cwd, {
      legacy: false,
      orderFields: [{ name: "title", type: "Int" }, { name: "total", type: "Float" }],
      extraSchema: { schemaName: "Invoice", schemaType: 1, fields: [{ name: "amount", type: "Float" }] }
    });
    await writeFile(join(cwd, "blocks.project.yaml"), "schemaVersion: 1\ndata:\n  newSchemaAccess: public\n");

    const json = await run(["plan", "--json", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(json.status, 2, json.stderr + json.stdout);
    const plan = JSON.parse(json.stdout);
    assert.equal(plan.changes, true);
    const byName = Object.fromEntries(plan.items.map((item) => [`${item.kind}:${item.name}`, item]));
    assert.equal(byName["schema:Order"].action, "update");
    assert.deepEqual(byName["schema:Order"].changes, ["fields.title.type"]);
    assert.equal(byName["schema:Invoice"].action, "create");
    assert.equal(byName["schema:Legacy"].action, "not-in-file");
    assert.equal(byName["policy:Order/OwnerOnly"].action, "unchanged");

    const text = await run(["plan", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(text.status, 2, text.stderr);
    assert.match(text.stdout, /Area data/);
    assert.match(text.stdout, /\+ create +schema Invoice \(new schema gets Public access\)/);
    assert.match(text.stdout, /~ update +schema Order: fields\.title\.type/);
    assert.match(text.stdout, /- not in file schema Legacy/);
    assert.match(text.stdout, /Summary: 1 to create, 1 to update, 2 unchanged, 1 not in file, 0 blocked\./);

    assertOnlyGets(server.requests);
  } finally { await server.close(); }
});

test("a planted literal secret fails plan with exit 1 before any request, and the value is never printed", async () => {
  const { cwd, configDir } = await makeWorkspace();
  const server = await startFakeServer({ schemas: LIVE_SCHEMAS, policies: LIVE_POLICIES });
  try {
    await writeProjectAuth(configDir, server.url);
    await writeDataFiles(cwd);
    await writeFile(join(cwd, "blocks.project.yaml"), [
      "schemaVersion: 1",
      "data: {}",
      "mail:",
      "  configs:",
      "    - name: outbound",
      `      clientSecret: "${FAKE_SECRET}"   # planted: a literal, not a secretRef`,
      ""
    ].join("\n"));

    for (const args of [["plan", "--json"], ["plan"]]) {
      const result = await run([...args, ...ctx(server.url)], { cwd, env: testEnv(configDir) });
      assert.equal(result.status, 1, result.stdout);
      const output = result.stdout + result.stderr;
      assert.match(output, /project_file_secret|literal secret/);
      assert.match(output, /mail\.configs\[0\]\.clientSecret/);
      assert.ok(!output.includes(FAKE_SECRET), "the planted value must not be printed");
    }
    assert.deepEqual(server.requests, [], "nothing is read from the server when the file is refused");
  } finally { await server.close(); }
});

test("plan exits 1 on an invalid project file (unknown key) without contacting the server", async () => {
  const { cwd, configDir } = await makeWorkspace();
  const server = await startFakeServer({ schemas: LIVE_SCHEMAS, policies: LIVE_POLICIES });
  try {
    await writeProjectAuth(configDir, server.url);
    await writeFile(join(cwd, "blocks.project.yaml"), "schemaVersion: 1\ndata:\n  shemas: blocks/data/schemas\n");
    const result = await run(["plan", "--json", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /project_file_invalid/);
    assert.match(result.stderr, /data\.shemas: unknown key/);
    assert.deepEqual(server.requests, []);
  } finally { await server.close(); }
});

test("plan exits 1 when the live read fails", async () => {
  const { cwd, configDir } = await makeWorkspace();
  const server = await startFakeServer({ schemas: LIVE_SCHEMAS, policies: LIVE_POLICIES });
  try {
    await writeProjectAuth(configDir, server.url);
    await writeDataFiles(cwd);
    await writeFile(join(cwd, "blocks.project.yaml"), "schemaVersion: 1\ndata: {}\n");
    await server.close();
    const result = await run(["plan", "--json", ...ctx(server.url)], { cwd, env: testEnv(configDir) });
    assert.equal(result.status, 1, result.stdout);
  } finally { await server.close().catch(() => {}); }
});

test("a JSON base file with a YAML overlay per environment: tenant from ${env:}, overlay values win, secretRefs listed by name only", async () => {
  const { cwd, configDir } = await makeWorkspace();
  const server = await startFakeServer({ schemas: [LIVE_ORDER], policies: LIVE_POLICIES });
  try {
    await writeProjectAuth(configDir, server.url);
    await writeDataFiles(cwd, { legacy: false, extraSchema: { schemaName: "Invoice", schemaType: 1, fields: [] } });
    await writeFile(join(cwd, "blocks.project.json"), `${JSON.stringify({
      schemaVersion: 1,
      project: { tenantId: "some-dev-tenant", name: "shop" },
      data: { newSchemaAccess: "user" },
      mail: { configs: [{ name: "outbound", clientSecret: { secretRef: "MAIL_SMTP_PASSWORD" } }] }
    }, null, 2)}\n`);
    await writeFile(join(cwd, "blocks.project.prod.yaml"), [
      "project:",
      "  tenantId: \"${env:PLAN_TEST_TENANT}\"",
      "data:",
      "  newSchemaAccess: public",
      ""
    ].join("\n"));

    const env = testEnv(configDir, { PLAN_TEST_TENANT: "target-project", MAIL_SMTP_PASSWORD: FAKE_SECRET });
    const result = await run(["plan", "--env", "prod", "--json", ...ctx(server.url)], { cwd, env });
    assert.equal(result.status, 2, result.stderr + result.stdout);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.env, "prod");
    assert.equal(plan.tenant, "target-project");
    assert.deepEqual(plan.files, { base: "blocks.project.json", overlay: "blocks.project.prod.yaml" });
    assert.deepEqual(plan.notCompared, ["mail"]);
    assert.deepEqual(plan.secretRefs, [{ name: "MAIL_SMTP_PASSWORD", path: "mail.configs[0].clientSecret" }]);
    assert.match(plan.items.find((item) => item.name === "Invoice").note, /Public access/);
    assert.ok(!(result.stdout + result.stderr).includes(FAKE_SECRET), "a secret value never appears in plan output");
    assert.ok(server.requests.every((r) => r.query.ProjectKey === undefined || r.query.ProjectKey === "target-project"));
    assertOnlyGets(server.requests);

    const missing = await run(["plan", "--env", "staging", "--json", ...ctx(server.url)], { cwd, env });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /project_file_not_found/);
  } finally { await server.close(); }
});

test("plan refuses a --project that contradicts the file's tenant", async () => {
  const { cwd, configDir } = await makeWorkspace();
  await writeProjectAuth(configDir, "http://127.0.0.1:9");
  await writeFile(join(cwd, "blocks.project.yaml"), "schemaVersion: 1\nproject:\n  tenantId: target-project\ndata: {}\n");
  const result = await run(["plan", "--project", "other-project", "--json"], { cwd, env: testEnv(configDir) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plan_tenant_mismatch/);
});

test("help and the command catalog describe plan as read-only", async () => {
  const { cwd, configDir } = await makeWorkspace();
  const result = await run(["help", "plan", "--json"], { cwd, env: testEnv(configDir) });
  assert.equal(result.status, 0, result.stderr);
  const entry = JSON.parse(result.stdout);
  assert.equal(entry.name, "plan");
  assert.equal(entry.mutating, false);
  assert.deepEqual(entry.flags, ["env", "file"]);
});
