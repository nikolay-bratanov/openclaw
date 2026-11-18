import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

/** Copy-and-swap work directories: `.upgrade-<generation>-<pid>-<startedAt>`. */
export const STATE_UPGRADE_WORK_PREFIX = ".upgrade-";

/**
 * Upgrades running in the state directory. A copy-and-swap upgrade holds no live
 * database, so its work directory's mtime is its heartbeat. A directory left by a
 * crashed attempt names a dead pid; callers match the pid against the process they wait on.
 */
export function readStateUpgradeActivity(
  env: NodeJS.ProcessEnv,
): Array<{ pid: number; heartbeatAt: number }> {
  const stateDir = resolveStateDir(env);
  const activity: Array<{ pid: number; heartbeatAt: number }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(stateDir);
  } catch {
    return activity;
  }
  for (const entry of entries) {
    // Generations can contain dashes; the pid and start time are the last two fields.
    const pid = entry.startsWith(STATE_UPGRADE_WORK_PREFIX)
      ? /-(\d+)-\d+$/u.exec(entry)?.[1]
      : undefined;
    const stat = pid
      ? fs.statSync(path.join(stateDir, entry), { throwIfNoEntry: false })
      : undefined;
    if (pid && stat?.isDirectory()) {
      activity.push({ pid: Number(pid), heartbeatAt: stat.mtimeMs });
    }
  }
  return activity;
}
