import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { wayfinderDirectory } from "./config.ts";
import type { CockpitData, TrackerProfile, WayfinderMap } from "./types.ts";

interface TrackerCacheDocument {
  version: 1;
  repositoryRoot: string;
  savedAt: number;
  maps: WayfinderMap[];
  trackers: TrackerProfile[];
}

function cachePath(repositoryRoot: string) {
  const key = createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 24);
  return path.join(wayfinderDirectory(), "cache", `${key}.json`);
}

export async function loadTrackerCache(
  repositoryRoot: string,
): Promise<TrackerCacheDocument | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(cachePath(repositoryRoot), "utf8"),
    ) as Partial<TrackerCacheDocument>;
    if (
      parsed.version !== 1 ||
      parsed.repositoryRoot !== repositoryRoot ||
      !Array.isArray(parsed.maps) ||
      !Array.isArray(parsed.trackers)
    ) {
      return undefined;
    }
    return parsed as TrackerCacheDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function saveTrackerCache(
  repositoryRoot: string,
  data: Pick<CockpitData, "maps" | "trackers">,
) {
  const target = cachePath(repositoryRoot);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const document: TrackerCacheDocument = {
    version: 1,
    repositoryRoot,
    savedAt: Date.now(),
    maps: data.maps,
    trackers: data.trackers,
  };
  await writeFile(temporary, `${JSON.stringify(document)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}
