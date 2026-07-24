import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { wayfinderDirectory } from "./config.ts";

interface HeartbeatDocument {
  version: 1;
  repositoryRoot: string;
  pid: number;
  updatedAt: number;
}

const STALE_AFTER_MS = 15_000;

function heartbeatPath(repositoryRoot: string, pid: number) {
  const repositoryKey = createHash("sha256")
    .update(repositoryRoot)
    .digest("hex")
    .slice(0, 24);
  return path.join(
    wayfinderDirectory(),
    "heartbeats",
    repositoryKey,
    `${pid}.json`,
  );
}

async function writeHeartbeat(repositoryRoot: string) {
  const target = heartbeatPath(repositoryRoot, process.pid);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${Date.now()}.tmp`;
  const document: HeartbeatDocument = {
    version: 1,
    repositoryRoot,
    pid: process.pid,
    updatedAt: Date.now(),
  };
  await writeFile(temporary, `${JSON.stringify(document)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

export async function activeOwnerPids(repositoryRoot: string) {
  const active = new Set<number>([process.pid]);
  const directory = path.dirname(heartbeatPath(repositoryRoot, process.pid));
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return active;
  }
  const now = Date.now();
  await Promise.all(
    names.map(async (name) => {
      try {
        const file = path.join(directory, name);
        const document = JSON.parse(
          await readFile(file, "utf8"),
        ) as HeartbeatDocument;
        if (
          document.version === 1 &&
          document.repositoryRoot === repositoryRoot &&
          Number.isInteger(document.pid) &&
          now - document.updatedAt <= STALE_AFTER_MS
        ) {
          active.add(document.pid);
        } else if (now - document.updatedAt > STALE_AFTER_MS) {
          await rm(file, { force: true });
        }
      } catch {
        // A partial or foreign file is ignored; atomic writers replace valid heartbeats.
      }
    }),
  );
  return active;
}

export async function startRepositoryHeartbeat(repositoryRoot: string) {
  await writeHeartbeat(repositoryRoot);
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.catch(() => {}).then(() => writeHeartbeat(repositoryRoot));
    void pending.catch(() => {});
  }, 5_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending.catch(() => {});
    await rm(heartbeatPath(repositoryRoot, process.pid), { force: true });
  };
}
