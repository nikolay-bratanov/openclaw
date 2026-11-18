import { resolveGatewayService } from "../../daemon/service.js";
import { waitForGitReleaseSuccessor } from "../../infra/git-release.js";
import { readPackageReleaseSlotSync } from "../../infra/package-release-slot-path.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { formatCliCommand } from "../command-format.js";
import type { UpdateCommandOptions } from "./shared.js";
import { recordOwedUpdateStep } from "./update-command-owed.js";
import { recordServiceReconciliationWarning } from "./update-command-result.js";
import {
  gatewayServiceCommandUsesRoot,
  readGatewayServiceStateForUpdate,
} from "./update-command-service-plan.js";

/** The parts of a service restart that Git release service handling reads. */
type GitReleaseServiceActivation = {
  result: UpdateRunResult;
  serviceEnv: NodeJS.ProcessEnv;
  timeoutMs?: number;
  opts: Pick<UpdateCommandOptions, "run">;
};

/**
 * Whether the service definition starts the updated root. The definition alone answers this:
 * a Windows task's process can still run the previous command right after its definition
 * moved, which fails the full ownership inspection.
 */
export async function serviceDefinitionUsesRoot(
  activation: GitReleaseServiceActivation,
): Promise<boolean | null> {
  const { command } = await readGatewayServiceStateForUpdate(
    resolveGatewayService(),
    activation.serviceEnv,
    activation.timeoutMs,
  );
  return await gatewayServiceCommandUsesRoot({ root: activation.result.root, command });
}

/**
 * A first Git release update leaves a service that still starts the checkout alone: its
 * definition moves to the release launcher only with a restart, so the next update owes it.
 */
export async function recordGitReleaseServiceOwedWithoutRestart(
  activation: GitReleaseServiceActivation,
  serviceUsesUpdatedRoot: () => Promise<boolean | null>,
): Promise<void> {
  const { result, serviceEnv } = activation;
  if (
    result.mode !== "git" ||
    !readPackageReleaseSlotSync(result.root ?? "") ||
    (await serviceUsesUpdatedRoot()) !== false
  ) {
    return;
  }
  const warning = `Gateway service still starts the checkout, so its next start runs the previous build. Run \`${formatCliCommand("openclaw gateway install --force", serviceEnv)}\` to start it from the release link.`;
  recordServiceReconciliationWarning(result, serviceEnv, warning);
  recordOwedUpdateStep(activation.opts.run, { id: "service-definition", reason: warning });
}

/**
 * A Git release's Gateway notices its link moved and restarts into the new release itself.
 * A native restart from inside its service job (update.run) would end this updater.
 * Returns false, without waiting, for every other install.
 */
export async function waitForGitReleaseRestart(
  activation: GitReleaseServiceActivation,
  recordRestarting: () => void,
): Promise<boolean> {
  const { result } = activation;
  if (result.mode !== "git" || !readPackageReleaseSlotSync(result.root ?? "")) {
    return false;
  }
  recordRestarting();
  await waitForGitReleaseSuccessor(activation.serviceEnv, activation.opts.run?.deadline?.signal);
  return true;
}
