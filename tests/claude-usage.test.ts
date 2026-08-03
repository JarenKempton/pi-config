import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeClaudeUsageResponse,
  refreshClaudeUsageFromQuery,
} from "../extensions/accounting/claude-usage.ts";

function usage(rateLimits: unknown, available = true) {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: available,
    rate_limits: rateLimits,
  } as any;
}

test("Claude SDK usage normalizes stable cache windows", () => {
  assert.deepEqual(
    normalizeClaudeUsageResponse(
      usage({
        five_hour: {
          utilization: 57,
          resets_at: "2026-08-03T23:00:00Z",
        },
        seven_day: {
          utilization: 12,
          resets_at: "2026-08-08T23:00:00Z",
        },
        model_scoped: [{ display_name: "Fable", utilization: 23 }],
      }),
    ),
    {
      five_hour: {
        used_percentage: 57,
        resets_at: "2026-08-03T23:00:00Z",
      },
      seven_day: {
        used_percentage: 12,
        resets_at: "2026-08-08T23:00:00Z",
      },
    },
  );
  assert.equal(normalizeClaudeUsageResponse(usage(null, false)), undefined);
});

test("Claude SDK usage refresh atomically updates a private cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-usage-"));
  const path = join(root, "private", "claude-rate-limits.json");
  const result = await refreshClaudeUsageFromQuery(
    {
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        return usage({
          five_hour: { utilization: 61, resets_at: "2026-08-03T23:00:00Z" },
          seven_day: { utilization: 14, resets_at: "2026-08-08T23:00:00Z" },
        });
      },
    },
    path,
  );

  assert.equal(result.ok, true);
  const cached = JSON.parse(await readFile(path, "utf8"));
  assert.equal(cached.rate_limits.five_hour.used_percentage, 61);
  assert.equal(cached.rate_limits.seven_day.used_percentage, 14);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
});

test("invalid experimental responses retain the previous cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-usage-invalid-"));
  const path = join(root, "claude-rate-limits.json");
  await writeFile(path, "previous\n", "utf8");

  const result = await refreshClaudeUsageFromQuery(
    {
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        return usage({ five_hour: { unexpected: 99 } });
      },
    },
    path,
  );

  assert.equal(result.ok, false);
  assert.equal(await readFile(path, "utf8"), "previous\n");
});
