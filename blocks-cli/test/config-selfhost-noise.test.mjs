// I14-WP13: normaliser noise found by the plan/apply cycle on blocks-selfhost.
import assert from "node:assert/strict";
import test from "node:test";

import { toPortableSchema } from "../dist/lib/data-files.js";
import { diffSchemas } from "../dist/lib/project-plan.js";
import { diffIam } from "../dist/lib/iam-config.js";

test("a permission's resource compares case-insensitively (the server stores it lower-cased)", () => {
  const live = { permissions: [{ name: "wp13.read", resource: "test::wp13::read", resourceGroup: "wp13", type: 1 }], rolePermissions: new Map(), roles: [] };
  const plan = diffIam({ permissions: [{ name: "wp13.read", resource: "Test::Wp13::Read", resourceGroup: "wp13", type: 1 }], roles: [] }, live);
  assert.equal(plan.items.find((item) => item.kind === "permission").action, "unchanged");
});

test("the server's access-policy fields on a stored schema are not reported as removed", () => {
  const systemNames = ["ItemId", "Create", "Read", "Update", "Delete", "Roles", "UserIds", "Permissions", "Roles", "UserIds", "Permissions"];
  const live = [{ schemaName: "Order", collectionName: "Orders", schemaType: 1, fields: [{ name: "title", type: "String" }, ...systemNames.map((name) => ({ name, type: "String" }))] }];
  const local = [{ schemaName: "Order", collectionName: "Orders", schemaType: 1, fields: [{ name: "title", type: "String" }] }];
  assert.equal(diffSchemas(local, live, "user")[0].action, "unchanged");
  assert.deepEqual(toPortableSchema(live[0]).fields.map((field) => field.name), ["title"]);
});
