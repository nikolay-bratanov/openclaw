import fs from "node:fs/promises";
import path from "node:path";
import { gitReleaseSlot, resolveGitReleasePrefix } from "../../infra/git-release-paths.js";
import { planGitReleaseRollback, requestGitReleaseRollback } from "../../infra/git-release.js";
import { readPackageReleaseSlotSync } from "../../infra/package-release-slot-path.js";
import { defaultRuntime, writeRuntimeJson } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { runDaemonRestart } from "../daemon-cli/lifecycle.js";

/** Switch back to the previous release; the release launcher restores state at the next start. */
export async function updateRollbackCommand(options: {
  dryRun?: boolean;
  json?: boolean;
  restart?: boolean;
}): Promise<void> {
  const prefix = resolveGitReleasePrefix();
  const slot = gitReleaseSlot(prefix);
  if (!readPackageReleaseSlotSync(slot)) {
    throw new Error(
      "openclaw update rollback works on installs that run from releases (Git installs). For an npm, pnpm, or Bun install, reinstall the earlier version with its package manager, for example `npm install -g openclaw@<version>`.",
    );
  }
  const rollback = await planGitReleaseRollback(prefix);
  if (!rollback) {
    throw new Error("No earlier release is retained, so there is nothing to roll back to.");
  }
  const from = rollback.version;
  const to = rollback.previousVersion ?? "unknown";
  const report = (status: string, message: string) => {
    if (options.json) {
      writeRuntimeJson(defaultRuntime, { status, from, to, previous: rollback.previous });
    } else {
      defaultRuntime.log(message);
    }
  };
  if (options.dryRun) {
    report("planned", `Rollback would switch ${from} back to ${to} (${rollback.previous}).`);
    return;
  }
  await requestGitReleaseRollback(prefix, rollback);
  if (options.restart === false) {
    report(
      "pending",
      `Rollback to ${to} is set. The next Gateway start switches back and restores state.`,
    );
    return;
  }
  await runDaemonRestart({ json: options.json });
  const selected = await fs.readlink(slot);
  if (
    path.resolve(path.dirname(slot), selected) ===
    path.resolve(path.dirname(slot), rollback.previous)
  ) {
    report("rolled-back", `Rolled back from ${from} to ${to}.`);
    return;
  }
  report(
    "pending",
    `Rollback to ${to} is set, but the Gateway did not start through its release launcher. Stop it, then start it with ${formatCliCommand("openclaw gateway start")} to finish.`,
  );
}
