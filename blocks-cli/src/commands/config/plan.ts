import { stringFlag } from "../../lib/args.js";
import { computeDataPlan, displayPath } from "../../lib/data-plan.js";
import { CliActionableError } from "../../lib/errors.js";
import { loadProjectFile, RESERVED_AREAS } from "../../lib/project-file.js";
import {
  hasChanges,
  renderPlanLines,
  renderSummary,
  summarize,
  type PlanItem
} from "../../lib/project-plan.js";
import { runReadOnly } from "../../lib/read-only-requests.js";
import { parseCommand, selectedProject } from "../../lib/workspace.js";

/**
 * `blocks plan`: compare the project file with the live project and print the difference
 * (decision 0007 §4; build step 1 covers the data area only). Read-only: it runs inside
 * `runReadOnly`, so any non-GET request throws before it is sent, and it writes nothing.
 *
 * Exit codes (as `terraform plan -detailed-exitcode`): 0 no changes, 2 changes, 1 error.
 */
export async function plan(argv: string[]): Promise<void> {
  await runReadOnly("blocks plan", () => planReadOnly(argv));
}

async function planReadOnly(argv: string[]): Promise<void> {
  const { flags } = parseCommand(argv);
  const loaded = await loadProjectFile({
    env: stringFlag(flags, "env") || undefined,
    file: stringFlag(flags, "file") || undefined
  });
  const { document } = loaded;

  const notCompared = RESERVED_AREAS.filter((area) => document[area] !== undefined);
  const items: PlanItem[] = [];
  let tenant: string | undefined;
  const notes: string[] = [];

  if (document.data) {
    const fileTenant = document.project?.tenantId;
    const flagTenant = stringFlag(flags, "project");
    if (fileTenant && flagTenant && fileTenant !== flagTenant) {
      throw new CliActionableError(
        `The project file names tenant '${fileTenant}', but --project is '${flagTenant}'.`,
        "plan_tenant_mismatch",
        "Drop --project, or change project.tenantId in the file (or its overlay)."
      );
    }
    tenant = fileTenant || await selectedProject(flags);
    items.push(...(await computeDataPlan(loaded, flags, tenant, notes)).items);
  } else {
    notes.push("The file manages no area that plan compares yet (data); nothing was read from the server.");
  }

  const summary = summarize(items);
  const changes = hasChanges(items);
  const result = {
    changes,
    env: loaded.env ?? null,
    files: {
      base: displayPath(loaded.baseFile),
      ...(loaded.overlayFile ? { overlay: displayPath(loaded.overlayFile) } : {})
    },
    items,
    notCompared,
    notes,
    schemaVersion: document.schemaVersion,
    // Names and paths only: plan never reads a secret value.
    secretRefs: loaded.secretRefs,
    summary,
    tenant: tenant ?? null
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const files = [result.files.base, ...(loaded.overlayFile ? [displayPath(loaded.overlayFile)] : [])].join(" + ");
    console.log(`blocks plan: ${files} (schemaVersion ${document.schemaVersion})${tenant ? `, tenant ${tenant}` : ""}`);
    if (document.data) {
      console.log("Area data");
      for (const line of renderPlanLines(items)) console.log(line);
      if (items.length === 0) console.log("  (no schemas or rules in the file or the project)");
    }
    if (notCompared.length) console.log(`Not compared yet (plan covers data only): ${notCompared.join(", ")}`);
    if (loaded.secretRefs.length) {
      console.log(`Secret references: ${[...new Set(loaded.secretRefs.map((ref) => ref.name))].join(", ")} (names only; values are resolved in memory by apply, never by plan)`);
    }
    for (const note of notes) console.log(note);
    console.log(renderSummary(summary));
    console.log(changes ? "Changes found (exit code 2)." : "No changes (exit code 0).");
  }

  process.exitCode = changes ? 2 : 0;
}
