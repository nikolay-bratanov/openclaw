import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigPath } from "../config/paths.js";
import { sleep } from "../utils/sleep.js";
import { ignoreMissingPath } from "./errno.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { writeGitReleaseLauncher, type GitReleaseTrial } from "./git-release-launcher.js";
import { GIT_RELEASE_TRIAL, gitReleaseSlot } from "./git-release-paths.js";
import { readPackageVersion } from "./package-json.js";
import { collectPackageReleases, listPackageReleases } from "./package-release-retention.js";
import {
  PACKAGE_RELEASES_DIR,
  packageReleaseGlobalRoot,
  readPackageReleaseSlotSync,
} from "./package-release-slot-path.js";
import {
  capturePackageReleaseSlot,
  createPackageReleaseLink,
  createPackageReleasePrefix,
  packageReleaseLinkTarget,
  switchPackageReleaseLink,
} from "./package-release-slot.js";
import { readBuiltGatewayBuildId } from "./update-git-runtime.js";

/**
 * A new release directory. The worktree is built at `buildDir`, outside
 * `node_modules` (Node refuses to strip types there), then moved to `releaseRoot`.
 */
export async function createGitReleaseDirs(prefix: string) {
  const releasePrefix = await createPackageReleasePrefix(prefix, "git");
  const globalRoot = packageReleaseGlobalRoot(releasePrefix);
  await fs.mkdir(globalRoot, { recursive: true });
  return {
    releasePrefix,
    buildDir: path.join(releasePrefix, "build"),
    releaseRoot: path.join(globalRoot, "openclaw"),
  };
}

/**
 * Select `releaseRoot` with one rename. With `trial`, the launcher switches back
 * after two failed starts and the Gateway clears the record once it is ready.
 */
export async function publishGitRelease(params: {
  prefix: string;
  releaseRoot: string;
  trial: boolean;
  /** Leave the link to the next service start, which selects the release on trial. */
  pending?: boolean;
  assertCurrent?: () => void;
}): Promise<{ previous: string | null; target: string }> {
  const slot = gitReleaseSlot(params.prefix);
  const target = packageReleaseLinkTarget(slot, params.releaseRoot);
  const trialFile = path.join(params.prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);
  await writeGitReleaseLauncher(params.prefix);
  const existing = await fs.lstat(slot).catch(ignoreMissingPath);
  let previous: string | null = null;
  if (existing) {
    const capture = await capturePackageReleaseSlot(slot);
    if (capture.kind !== "link") {
      throw new Error(`${slot} is not a release link; the installation was left unchanged.`);
    }
    previous = capture.target;
    // A stale trial must not switch the next release back.
    await fs.rm(trialFile, { force: true });
    if (!params.pending) {
      await switchPackageReleaseLink({
        slot,
        expected: { identity: capture.identity, target: capture.target },
        target,
        assertCurrent: () => params.assertCurrent?.(),
      });
    }
  } else {
    await createPackageReleaseLink({
      slot,
      target,
      assertCurrent: () => params.assertCurrent?.(),
    });
  }
  if (params.trial && previous) {
    const buildId = await readBuiltGatewayBuildId(params.releaseRoot);
    await writeGitReleaseTrial(trialFile, {
      target,
      previous,
      version: (await readPackageVersion(params.releaseRoot)) ?? "unknown",
      ...(buildId ? { buildId } : {}),
      // The update admits only a service whose config selection matches this process.
      config: resolveConfigPath(process.env),
      ...(params.pending ? { pending: true } : {}),
      createdAt: Date.now(),
      attempts: 0,
    });
  }
  return { previous, target };
}

async function writeGitReleaseTrial(trialFile: string, record: GitReleaseTrial): Promise<void> {
  const temporary = `${trialFile}.${process.pid}`;
  await fs.writeFile(temporary, JSON.stringify(record));
  await fs.rename(temporary, trialFile);
}

// Release ids are `<label>-<Date.now() base 36>-<hex>` (createPackageReleasePrefix).
function releaseCreatedAt(id: string): number | undefined {
  const stamp = /-([0-9a-z]+)-[0-9a-f]{8}$/u.exec(id)?.[1];
  return stamp ? Number.parseInt(stamp, 36) : undefined;
}

export type GitReleaseRollback = {
  target: string;
  previous: string;
  version: string;
  previousVersion: string | null;
};

/**
 * Plan a switch back to the release created just before the selected one. A release
 * created later is one a failed trial already left, never a rollback target.
 */
export async function planGitReleaseRollback(prefix: string): Promise<GitReleaseRollback | null> {
  const slot = gitReleaseSlot(prefix);
  const capture = await capturePackageReleaseSlot(slot);
  if (capture.kind !== "link") {
    throw new Error(`${slot} is not a release link; the installation was left unchanged.`);
  }
  const releases = await listPackageReleases(slot);
  const selected = releases.find((release) => release.selected);
  const selectedAt = selected ? releaseCreatedAt(selected.id) : undefined;
  if (selectedAt === undefined) {
    return null;
  }
  let previous: (typeof releases)[number] | undefined;
  let previousAt = -1;
  for (const release of releases) {
    const createdAt = releaseCreatedAt(release.id);
    if (
      !release.selected &&
      createdAt !== undefined &&
      createdAt < selectedAt &&
      createdAt > previousAt
    ) {
      previous = release;
      previousAt = createdAt;
    }
  }
  if (!previous) {
    return null;
  }
  return {
    target: capture.target,
    // The shape publishGitRelease writes. A release's recorded path is its real path, and
    // a link relative to that from a prefix reached through a symlink resolves elsewhere.
    previous: packageReleaseLinkTarget(
      slot,
      path.join(
        packageReleaseGlobalRoot(path.join(prefix, PACKAGE_RELEASES_DIR, previous.id)),
        path.basename(slot),
      ),
    ),
    version: capture.release.version ?? "unknown",
    previousVersion: previous.version,
  };
}

/**
 * Record the selected release as failed, so the launcher switches back at the next
 * Gateway start and restores the state this release's startup upgrade replaced
 * (`<file>.pre-<generation>` since the link selected it). Writes made since are lost.
 * Accepted edge case: when those files were already pruned, the earlier release
 * refuses the newer schema at start and `openclaw update` moves forward again.
 */
export async function requestGitReleaseRollback(
  prefix: string,
  rollback: GitReleaseRollback,
): Promise<void> {
  const slot = gitReleaseSlot(prefix);
  const trialFile = path.join(prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);
  if (await fs.lstat(trialFile).catch(ignoreMissingPath)) {
    throw new Error(
      "An update is still on trial. Start the Gateway once so the trial settles, then roll back.",
    );
  }
  const link = await fs.lstat(slot);
  if ((await fs.readlink(slot)) !== rollback.target) {
    throw new Error(`${slot} changed while planning the rollback; nothing was changed.`);
  }
  const releaseRoot = path.resolve(path.dirname(slot), rollback.target);
  const buildId = await readBuiltGatewayBuildId(releaseRoot);
  await writeGitReleaseTrial(trialFile, {
    target: rollback.target,
    previous: rollback.previous,
    version: rollback.version,
    ...(buildId ? { buildId } : {}),
    config: resolveConfigPath(process.env),
    // The startup upgrade preserves files after the switch that selected this release.
    createdAt: link.ctimeMs,
    attempts: 2,
    requested: true,
  });
}

/** A ready Gateway ends the trial of the release it runs. */
export async function settleGitReleaseTrial(runningRoot: string | null): Promise<void> {
  const slot = runningRoot ? readPackageReleaseSlotSync(runningRoot) : null;
  if (!slot) {
    return;
  }
  const trialFile = path.join(slot.prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);
  const raw = await fs.readFile(trialFile, "utf8").catch(ignoreMissingPath);
  // SAFETY: writeGitReleaseTrial and the launcher are the only writers of the trial record.
  const trial = raw ? (JSON.parse(raw) as GitReleaseTrial) : null;
  const linked = (target: string) => path.resolve(path.dirname(slot.slot), target);
  if (trial && linked(trial.target) === linked(slot.target)) {
    await fs.rm(trialFile, { force: true });
  }
}

/**
 * Remove releases the link does not name that are past the 24 hour minimum age
 * and unleased (#198835's rule), then let Git forget their worktrees.
 */
export async function collectGitReleases(params: {
  prefix: string;
  keep: readonly string[];
  prune: () => Promise<unknown>;
}): Promise<{ removed: string[]; warnings: string[] }> {
  const collected = await collectPackageReleases({
    slot: gitReleaseSlot(params.prefix),
    prefix: params.prefix,
    keep: params.keep,
  });
  if (collected.removed.length > 0) {
    await params.prune();
  }
  return collected;
}

/**
 * The serving Gateway restarts itself once its maintenance tick (30 s) sees the link
 * move. Wait for a new Gateway owner before verifying; after 35 s, ask it to restart
 * (SIGUSR2), which also covers a plugin-only restart where the link did not move.
 */
export async function waitForGitReleaseSuccessor(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  const ownerPid = () => {
    try {
      return readGatewayOwnerLease({ env, current: true })?.pid;
    } catch {
      return undefined;
    }
  };
  const servingPid = ownerPid();
  for (let waited = servingPid ? 0 : 90; waited < 90; waited++) {
    if (waited === 35) {
      try {
        process.kill(servingPid!, "SIGUSR2");
      } catch {
        // A Gateway that already exited has a successor coming.
      }
    }
    await sleep(1_000, signal);
    if (ownerPid() !== servingPid) {
      return;
    }
  }
}
