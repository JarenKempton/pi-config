import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SubagentSnapshot } from "../../vendor/davis/extensions/subagents/src/domain.ts";
import { activeOwnerPids } from "./heartbeat.ts";
import type { WayfinderRun } from "./types.ts";

interface RuntimeDocument {
  version: 1;
  runs: WayfinderRun[];
}

const STATE_DIRECTORY = path.join(
  process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  "wayfinder",
);
const STATE_PATH = path.join(STATE_DIRECTORY, "state.json");
const LOCK_PATH = `${STATE_PATH}.lock`;

async function readDocument(): Promise<RuntimeDocument> {
  try {
    const value = JSON.parse(await readFile(STATE_PATH, "utf8")) as RuntimeDocument;
    if (value.version !== 1 || !Array.isArray(value.runs)) {
      throw new Error("Unsupported Wayfinder runtime-state schema");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, runs: [] };
    }
    throw error;
  }
}

async function withStateLock<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 2_000;
  let handle;
  while (!handle) {
    try {
      handle = await open(LOCK_PATH, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(LOCK_PATH)).mtimeMs > 10_000) {
          await rm(LOCK_PATH, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the Wayfinder state lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(LOCK_PATH, { force: true });
  }
}

async function writeDocument(document: RuntimeDocument) {
  await mkdir(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, STATE_PATH);
}

export async function loadRuns(workspaceRoot: string) {
  const document = await readDocument();
  const activeOwners = await activeOwnerPids(workspaceRoot);
  return document.runs
    .filter((run) => {
      const relative = path.relative(workspaceRoot, run.cwd);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    })
    .map((run) =>
      run.status === "running" &&
      run.ownerPid !== undefined &&
      !activeOwners.has(run.ownerPid)
        ? {
            ...run,
            status: "error" as const,
            finalText:
              run.finalText ||
              "The owning Pi process stopped reporting; this run may have been interrupted.",
          }
        : run,
    );
}

export async function recordRun(
  mapId: string,
  ticketId: string,
  snapshot: SubagentSnapshot,
): Promise<WayfinderRun> {
  return withStateLock(async () => {
    const document = await readDocument();
    const now = Date.now();
    const existing = document.runs.find((run) => run.id === snapshot.id);
    const run: WayfinderRun = {
      id: snapshot.id,
      mapId,
      ticketId,
      title: snapshot.title,
      backend:
        snapshot.backend === "pi"
          ? "Pi"
          : snapshot.backend === "claude"
            ? "Claude"
            : "Codex",
      model: snapshot.meta.modelLabel,
      profile: snapshot.profile === "unrestricted" ? "worker" : snapshot.profile,
      cwd: snapshot.cwd,
      status: snapshot.status,
      createdAt: existing?.createdAt ?? snapshot.createdAt,
      updatedAt: snapshot.settledAt ?? now,
      ownerPid: process.pid,
      sessionFilePath: snapshot.meta.sessionFilePath,
      nativeSessionId: snapshot.meta.nativeSessionId,
      finalText: snapshot.finalText || existing?.finalText,
    };
    document.runs = [
      run,
      ...document.runs.filter((item) => item.id !== run.id),
    ].slice(0, 500);
    await writeDocument(document);
    return run;
  });
}

export async function syncRuns(snapshots: ReadonlyArray<SubagentSnapshot>) {
  return withStateLock(async () => {
    const document = await readDocument();
    let changed = false;
    for (const snapshot of snapshots) {
      const run = document.runs.find((item) => item.id === snapshot.id);
      if (!run) continue;
      run.status = snapshot.status;
      run.updatedAt = snapshot.settledAt ?? Date.now();
      run.model = snapshot.meta.modelLabel ?? run.model;
      run.sessionFilePath = snapshot.meta.sessionFilePath ?? run.sessionFilePath;
      run.nativeSessionId = snapshot.meta.nativeSessionId ?? run.nativeSessionId;
      run.finalText = snapshot.finalText || run.finalText;
      changed = true;
    }
    if (changed) await writeDocument(document);
    return document.runs;
  });
}

export function statePath() {
  return STATE_PATH;
}
