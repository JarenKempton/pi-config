export const MODEL_INFO_CHANNEL = "dashboard:model-info";
export const GIT_INFO_CHANNEL = "dashboard:git-info";
export const ACCOUNTING_INFO_CHANNEL = "dashboard:accounting-info";
export const SUBAGENT_INFO_CHANNEL = "dashboard:subagent-info";
export const REFRESH_CHANNEL = "dashboard:refresh";

export interface ModelInfoState {
  provider: string;
  modelId: string;
  modelName: string;
  thinking: string;
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
  cost: number;
  tokensPerSecond: number | null;
  generating: boolean;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  isDraft: boolean;
}

export interface GitInfoState {
  isRepository: boolean;
  branch: string | null;
  changedFiles: number;
  pullRequest: PullRequestInfo | null;
}

export interface DashboardQuotaWindow {
  provider: "Codex" | "Claude";
  id: string;
  label: string;
  usedPercent: number;
  windowDurationMins?: number;
  stale: boolean;
}

export interface AccountingInfoState {
  todayCost: number | null;
  todayRateKnown: boolean;
  quotaWindows: DashboardQuotaWindow[];
  updatedAt: number | null;
}

export interface SubagentInfoState {
  count: number;
  costUsd: number;
  costKnown: boolean;
}

export function emptyModelInfoState(): ModelInfoState {
  return {
    provider: "",
    modelId: "no-model",
    modelName: "No model",
    thinking: "off",
    contextTokens: null,
    contextWindow: 0,
    contextPercent: null,
    cost: 0,
    tokensPerSecond: null,
    generating: false,
  };
}

export function emptyGitInfoState(): GitInfoState {
  return {
    isRepository: false,
    branch: null,
    changedFiles: 0,
    pullRequest: null,
  };
}

export function emptyAccountingInfoState(): AccountingInfoState {
  return {
    todayCost: null,
    todayRateKnown: true,
    quotaWindows: [],
    updatedAt: null,
  };
}

export function emptySubagentInfoState(): SubagentInfoState {
  return { count: 0, costUsd: 0, costKnown: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableNumber(value: unknown) {
  return value === null || typeof value === "number";
}

export function isModelInfoState(value: unknown): value is ModelInfoState {
  if (!isRecord(value)) return false;

  return (
    typeof value.provider === "string" &&
    typeof value.modelId === "string" &&
    typeof value.modelName === "string" &&
    typeof value.thinking === "string" &&
    isNullableNumber(value.contextTokens) &&
    typeof value.contextWindow === "number" &&
    isNullableNumber(value.contextPercent) &&
    typeof value.cost === "number" &&
    isNullableNumber(value.tokensPerSecond) &&
    typeof value.generating === "boolean"
  );
}

function isPullRequestInfo(value: unknown): value is PullRequestInfo {
  if (!isRecord(value)) return false;

  return (
    typeof value.number === "number" &&
    typeof value.url === "string" &&
    typeof value.isDraft === "boolean"
  );
}

export function isGitInfoState(value: unknown): value is GitInfoState {
  if (!isRecord(value)) return false;

  return (
    typeof value.isRepository === "boolean" &&
    (value.branch === null || typeof value.branch === "string") &&
    typeof value.changedFiles === "number" &&
    (value.pullRequest === null || isPullRequestInfo(value.pullRequest))
  );
}

function isDashboardQuotaWindow(value: unknown): value is DashboardQuotaWindow {
  if (!isRecord(value)) return false;
  return (
    (value.provider === "Codex" || value.provider === "Claude") &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.usedPercent === "number" &&
    (value.windowDurationMins === undefined ||
      typeof value.windowDurationMins === "number") &&
    typeof value.stale === "boolean"
  );
}

export function isAccountingInfoState(value: unknown): value is AccountingInfoState {
  if (!isRecord(value)) return false;
  return (
    (value.todayCost === null || typeof value.todayCost === "number") &&
    typeof value.todayRateKnown === "boolean" &&
    Array.isArray(value.quotaWindows) &&
    value.quotaWindows.every(isDashboardQuotaWindow) &&
    (value.updatedAt === null || typeof value.updatedAt === "number")
  );
}

export function isSubagentInfoState(value: unknown): value is SubagentInfoState {
  if (!isRecord(value)) return false;
  return (
    typeof value.count === "number" &&
    typeof value.costUsd === "number" &&
    typeof value.costKnown === "boolean"
  );
}
