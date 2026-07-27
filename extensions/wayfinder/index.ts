import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI } from "@earendil-works/pi-tui";
import { buildActivityItems } from "./activity.ts";
import { buildAgentPrompt } from "./agent-prompt.ts";
import { loadTrackerCache, saveTrackerCache } from "./cache.ts";
import {
  loadWorkspaceSettings,
  saveWorkspaceSettings,
  settingsPath,
  type WorkspaceSettings,
} from "./config.ts";
import { defaultData } from "./defaults.ts";
import { startRepositoryHeartbeat } from "./heartbeat.ts";
import {
  claimGitHubTicket,
  hydrateGitHubTicket,
  isGitHubTrackerConfigured,
  loadGitHubWayfinderData,
  resolveRepositoryRoot,
} from "./github-loader.ts";
import { loadJiraBoards, loadJiraWayfinderData } from "./jira-loader.ts";
import {
  discoverMarkdownMapFiles,
  loadMarkdownWayfinderData,
} from "./markdown-loader.ts";
import { loadAgentCatalog } from "./model-catalog.ts";
import { renderCockpit } from "./render.ts";
import { constrainAgentTarget, resolveAgentTarget } from "./routing.ts";
import { loadRuns, recordRun, syncRuns } from "./runtime-state.ts";
import {
  initialState,
  ledgerTickets,
  reduceCockpit,
  selectedMap,
  selectedTicket,
  type CockpitAction,
  type CockpitState,
} from "./state.ts";
import type {
  AgentRuntimeId,
  CockpitData,
  RoutingRule,
  WayfinderRun,
} from "./types.ts";
import {
  getSubagentHost,
  type SubagentHostBridge,
} from "../../vendor/davis/extensions/subagents/src/host-bridge.ts";
import type { SubagentSnapshot } from "../../vendor/davis/extensions/subagents/src/domain.ts";

let cockpitOpen = false;

export function filterCachedMaps(maps: CockpitData["maps"]) {
  return maps.filter(
    (map) =>
      map.source?.provider !== "markdown" ||
      !/(^|\/)\.claude\//.test(map.source.id),
  );
}

function backend(runtime: AgentRuntimeId) {
  return runtime === "Pi" ? "pi" : runtime === "Claude" ? "claude" : "codex";
}

function snapshotRun(snapshot: SubagentSnapshot): WayfinderRun {
  return {
    id: snapshot.id,
    mapId: "unlinked",
    ticketId: "—",
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
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.settledAt ?? Date.now(),
    sessionFilePath: snapshot.meta.sessionFilePath,
    nativeSessionId: snapshot.meta.nativeSessionId,
    finalText: snapshot.finalText,
  };
}

export class WayfinderCockpitComponent {
  private state: CockpitState;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly ctx: ExtensionContext;
  private readonly host: SubagentHostBridge | undefined;
  private readonly workspaceKey: string;
  private readonly workspaceRoot: string;
  private data: CockpitData;
  private settings: WorkspaceSettings;
  private unsubscribe?: () => void;
  private pollTimer?: NodeJS.Timeout;
  private refreshLoader?: (trackerId: string) => Promise<{
    trackerData: CockpitData;
    agentCatalog: CockpitData["agentCatalog"];
  }>;
  private disposed = false;

  constructor(options: {
    tui: TUI;
    theme: Theme;
    done: () => void;
    ctx: ExtensionContext;
    data: CockpitData;
    settings: WorkspaceSettings;
    workspaceKey: string;
    workspaceRoot: string;
    host: SubagentHostBridge | undefined;
    initialScreen?: "maps" | "agents";
    refreshData?: (trackerId: string) => Promise<{
      trackerData: CockpitData;
      agentCatalog: CockpitData["agentCatalog"];
    }>;
  }) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.done = options.done;
    this.ctx = options.ctx;
    this.data = options.data;
    this.settings = options.settings;
    this.workspaceKey = options.workspaceKey;
    this.workspaceRoot = options.workspaceRoot;
    this.host = options.host;
    this.state = {
      ...initialState(options.data),
      screen: options.initialScreen ?? "maps",
    };
    void this.connectAgentUpdates();
    this.pollTimer = setInterval(() => {
      void this.refreshPersistedRuns();
    }, 1_500);
    this.pollTimer.unref();
    this.refreshLoader = options.refreshData;
    if (this.refreshLoader) void this.refreshData(this.refreshLoader);
  }

  private async refreshData(
    loader: (trackerId: string) => Promise<{
      trackerData: CockpitData;
      agentCatalog: CockpitData["agentCatalog"];
    }>,
  ) {
    const previousMap = this.data.maps[this.state.mapIndex];
    const previousTicketId = this.state.selectedTicketId;
    const previousActivityId = buildActivityItems(this.data)[this.state.agentIndex]?.id;
    try {
      const { trackerData, agentCatalog } = await loader(this.settings.trackerId);
      if (this.disposed) return;
      this.data = {
        ...trackerData,
        jiraBoards: trackerData.jiraBoards ?? this.data.jiraBoards,
        routes: this.settings.routes.map((route) => ({ ...route })),
        agentCatalog,
        agentDefaults: {
          HITL: { ...this.settings.agentDefaults.HITL },
          AFK: { ...this.settings.agentDefaults.AFK },
        },
        configuredDeliveryProfileId:
          this.settings.deliveryProfileId || undefined,
        configuredTrackerId: this.settings.trackerId,
        configuredJiraBoardId: this.settings.jiraBoardId,
        settingsPath: settingsPath(),
        settingsPersisted: this.data.settingsPersisted,
        runs: this.data.runs,
        trackerRefresh: { state: "current", updatedAt: Date.now() },
      };
      const mapIndex = Math.max(
        0,
        previousMap
          ? this.data.maps.findIndex((map) => map.id === previousMap.id)
          : 0,
      );
      const map = this.data.maps[mapIndex];
      const agentIndex = previousActivityId
        ? Math.max(
            0,
            buildActivityItems(this.data).findIndex(
              (item) => item.id === previousActivityId,
            ),
          )
        : 0;
      this.state = {
        ...this.state,
        mapIndex,
        agentIndex,
        jiraBoardIndex: Math.max(
          0,
          this.data.jiraBoards?.findIndex(
            (board) => board.id === this.settings.jiraBoardId,
          ) ?? 0,
        ),
        selectedTicketId:
          map?.tickets.some((ticket) => ticket.id === previousTicketId)
            ? previousTicketId
            : map
              ? ledgerTickets(map)[0]?.id ?? ""
              : "",
      };
      this.tui.requestRender();
    } catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.data.trackerRefresh = {
        state: "error",
        updatedAt: this.data.trackerRefresh?.updatedAt,
        error: message,
      };
      this.ctx.ui.notify(`Wayfinder refresh failed: ${message}`, "error");
      this.tui.requestRender();
    }
  }

  private dispatch(action: CockpitAction) {
    this.state = reduceCockpit(this.state, action, this.data);
    this.tui.requestRender();
  }

  private async refreshPersistedRuns() {
    if (this.disposed) return;
    try {
      const selectedActivityId = buildActivityItems(this.data)[this.state.agentIndex]?.id;
      const runs = await loadRuns(this.workspaceKey);
      if (this.disposed) return;
      const persistedIds = new Set(runs.map((run) => run.id));
      const ephemeral = (this.data.runs ?? []).filter(
        (run) => run.mapId === "unlinked" && !persistedIds.has(run.id),
      );
      const merged = [...runs, ...ephemeral];
      const previous = (this.data.runs ?? [])
        .map((run) => `${run.id}:${run.status}:${run.updatedAt}`)
        .join("|");
      const next = merged
        .map((run) => `${run.id}:${run.status}:${run.updatedAt}`)
        .join("|");
      if (previous === next) return;
      this.data.runs = merged;
      const activities = buildActivityItems(this.data);
      this.state.agentIndex = selectedActivityId
        ? Math.max(
            0,
            activities.findIndex((item) => item.id === selectedActivityId),
          )
        : Math.min(this.state.agentIndex, Math.max(0, activities.length - 1));
      this.tui.requestRender();
    } catch {
      // The active host update path remains authoritative if another process is mid-write.
    }
  }

  private async connectAgentUpdates() {
    if (!this.host) return;
    await this.refreshRuns();
    const unsubscribe = await this.host.subscribe(() => {
      void this.refreshRuns();
    });
    if (this.disposed) unsubscribe();
    else this.unsubscribe = unsubscribe;
  }

  private async refreshRuns() {
    if (!this.host || this.disposed) return;
    try {
      const selectedActivityId = buildActivityItems(this.data)[this.state.agentIndex]?.id;
      const snapshots = await this.host.list();
      await syncRuns(snapshots);
      if (this.disposed) return;
      const linked = await loadRuns(this.workspaceRoot);
      const linkedIds = new Set(linked.map((run) => run.id));
      const unlinked = snapshots
        .filter((snapshot) => !linkedIds.has(snapshot.id))
        .map(snapshotRun);
      this.data.runs = [...linked, ...unlinked].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      const activities = buildActivityItems(this.data);
      this.state = {
        ...this.state,
        agentIndex: selectedActivityId
          ? Math.max(
              0,
              activities.findIndex((item) => item.id === selectedActivityId),
            )
          : Math.min(this.state.agentIndex, Math.max(0, activities.length - 1)),
      };
      this.tui.requestRender();
    } catch (error) {
      this.ctx.ui.notify(
        `Unable to refresh agent activity: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  private async persistSettings() {
    try {
      await saveWorkspaceSettings(this.workspaceKey, this.settings);
      this.data.settingsPersisted = true;
      this.ctx.ui.notify(`Wayfinder settings saved to ${settingsPath()}`, "info");
      this.tui.requestRender();
    } catch (error) {
      this.ctx.ui.notify(
        `Unable to save Wayfinder settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  private handleSettingsEnter() {
    const screen = this.state.screen;
    const draft = this.state.draftRule ? { ...this.state.draftRule } : undefined;
    const deliveryCursor = this.state.deliveryCursor;
    const trackerIndex = this.state.trackerIndex;
    const jiraBoardIndex = this.state.jiraBoardIndex;
    const ruleIndex = this.state.ruleIndex;
    const agentDefaultIndex = this.state.agentDefaultIndex;

    if (screen === "tracker-settings") {
      const tracker = this.data.trackers[trackerIndex];
      if (
        tracker?.id !== "github" &&
        tracker?.id !== "jira" &&
        tracker?.id !== "markdown"
      ) {
        this.ctx.ui.notify(
          `${tracker?.label ?? "This tracker"} is visualized but its production adapter is not installed yet.`,
          "warning",
        );
        return;
      }
    }

    this.dispatch({ type: "enter" });

    if (screen === "delivery-settings") {
      const profile = this.data.deliveryProfiles[deliveryCursor];
      if (!profile) return;
      this.settings.deliveryProfileId = profile.id;
      this.data.configuredDeliveryProfileId = profile.id;
      void this.persistSettings();
      return;
    }

    if (screen === "tracker-settings") {
      const tracker = this.data.trackers[trackerIndex];
      if (!tracker) return;
      const board = tracker.id === "jira"
        ? this.data.jiraBoards?.[jiraBoardIndex]
        : undefined;
      if (tracker.id === "jira" && !board) {
        this.ctx.ui.notify(
          "Select an available Jira board before applying Jira.",
          "warning",
        );
        return;
      }
      this.settings.trackerId = tracker.id;
      this.data.configuredTrackerId = tracker.id;
      if (board) {
        this.settings.jiraBoardId = board.id;
        this.data.configuredJiraBoardId = board.id;
      }
      this.data.maps = [];
      this.data.trackerRefresh = { state: "loading" };
      this.state = { ...initialState(this.data), screen: "maps" };
      void this.persistSettings();
      if (this.refreshLoader) void this.refreshData(this.refreshLoader);
      return;
    }

    if (screen === "rule-editor" && draft) {
      const route: RoutingRule = { ...draft };
      this.settings.routes[ruleIndex] = route;
      this.data.routes[ruleIndex] = route;
      void this.persistSettings();
      return;
    }

    if (screen === "agent-editor" && draft) {
      const mode = agentDefaultIndex === 0 ? "HITL" : "AFK";
      this.settings.agentDefaults[mode] = {
        runtime: draft.runtime,
        model: draft.model,
        effort: draft.effort,
        profile: draft.profile,
      };
      this.data.agentDefaults = {
        HITL: { ...this.settings.agentDefaults.HITL },
        AFK: { ...this.settings.agentDefaults.AFK },
      };
      void this.persistSettings();
    }
  }

  private selectedRun() {
    if (this.state.screen === "agents") {
      return buildActivityItems(this.data)[this.state.agentIndex]?.run;
    }
    const map = selectedMap(this.state, this.data);
    const ticket = selectedTicket(this.state, this.data);
    return this.data.runs?.find(
      (run) => run.mapId === map.id && run.ticketId === ticket.id,
    );
  }

  private async hydrateSelectedTicket() {
    const map = selectedMap(this.state, this.data);
    const ticket = selectedTicket(this.state, this.data);
    if (
      !map ||
      !ticket ||
      ticket.hydrated ||
      ticket.hydrating ||
      ticket.trackerState === "migrated"
    ) {
      return;
    }
    ticket.hydrating = true;
    this.tui.requestRender();
    try {
      Object.assign(
        ticket,
        await hydrateGitHubTicket(this.workspaceRoot, map.repository, ticket),
      );
      if (this.disposed) return;
      void saveTrackerCache(this.workspaceRoot, this.data).catch(() => {});
      this.tui.requestRender();
    } catch (error) {
      ticket.hydrating = false;
      if (this.disposed) return;
      this.ctx.ui.notify(
        `Unable to load ${ticket.id} details: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      this.tui.requestRender();
    }
  }

  private openSelectedActivity() {
    const item = buildActivityItems(this.data)[this.state.agentIndex];
    if (!item) return;
    if (item.run) {
      void this.jumpToSelectedRun();
      return;
    }
    if (!item.ticket || !item.map) return;
    const mapIndex = this.data.maps.findIndex((map) => map.id === item.map!.id);
    if (mapIndex < 0) return;
    this.state = {
      ...this.state,
      screen: "ticket",
      mapIndex,
      selectedTicketId: item.ticket.id,
      scrollOffset: 0,
    };
    this.tui.requestRender();
    void this.hydrateSelectedTicket();
  }

  private async startSelectedTicket() {
    const map = selectedMap(this.state, this.data);
    const ticket = selectedTicket(this.state, this.data);
    const existing = this.selectedRun();
    if (existing?.status === "running") {
      this.ctx.ui.notify("This ticket already has a running agent.", "warning");
      return;
    }
    if (map.source?.provider !== "github" && map.mirror) {
      this.ctx.ui.notify(
        `This GitHub map is a stale mirror. Load the canonical ${map.source?.provider ?? "external"} adapter before starting agents or mutating tickets.`,
        "error",
      );
      return;
    }
    if (ticket.trackerState === "migrated") {
      this.ctx.ui.notify(
        `${ticket.id} moved to ${ticket.source?.id ?? "another tracker"}; the GitHub mirror is read-only.`,
        "error",
      );
      return;
    }
    if (ticket.trackerState === "resolved") {
      this.ctx.ui.notify(`${ticket.id} is already resolved.`, "info");
      return;
    }
    if (ticket.blockedBy.length > 0) {
      this.ctx.ui.notify(
        `${ticket.id} is blocked by ${ticket.blockedBy.join(", ")}.`,
        "warning",
      );
      return;
    }
    if (!this.host) {
      this.ctx.ui.notify(
        "The agent runtime is unavailable. Reload Pi and verify the subagents extension is enabled.",
        "error",
      );
      return;
    }

    const target = constrainAgentTarget(
      resolveAgentTarget(ticket, this.settings),
      this.data.agentCatalog,
    );
    const workingDirectory = ticket.workspace?.path ?? this.workspaceRoot;
    const confirmed = await this.ctx.ui.confirm(
      `Start ${ticket.mode} agent for ${ticket.id}?`,
      [
        ticket.title,
        `${target.runtime} · ${target.model} · ${target.effort} · ${target.profile}`,
        `Working directory: ${workingDirectory}`,
        ticket.trackerState === "open"
          ? ticket.source?.provider === "github"
            ? "This will claim the GitHub ticket before the agent starts."
            : "The canonical tracker remains unchanged; only the local agent association is recorded."
          : "The ticket is already claimed or resolved.",
      ].join("\n"),
    );
    if (!confirmed) return;

    try {
      if (ticket.trackerState === "open") {
        if (ticket.source?.provider === "github") {
          await claimGitHubTicket(this.workspaceRoot, ticket.id);
        }
        ticket.trackerState = "claimed";
      }
      const snapshot = await this.host.spawn(this.ctx, {
        backend: backend(target.runtime),
        title: `${ticket.id} ${ticket.title}`,
        prompt: buildAgentPrompt(map, ticket),
        cwd: workingDirectory,
        model: target.model,
        reasoningEffort: target.effort,
        profile: target.profile,
      });
      const run = await recordRun(map.id, ticket.id, snapshot);
      this.data.runs = [
        run,
        ...(this.data.runs ?? []).filter((candidate) => candidate.id !== run.id),
      ];
      const agentIndex = Math.max(
        0,
        buildActivityItems(this.data).findIndex(
          (item) => item.run?.id === run.id,
        ),
      );
      this.state = { ...this.state, screen: "agents", agentIndex };
      this.tui.requestRender();
      if (ticket.mode === "HITL") {
        await this.host.takeover(this.ctx, snapshot.id);
      } else {
        this.ctx.ui.notify(
          `Started ${snapshot.id}. Open Agent activity with g.`,
          "info",
        );
      }
    } catch (error) {
      this.ctx.ui.notify(
        `Unable to start agent: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  private async jumpToSelectedRun() {
    const run = this.selectedRun();
    if (!run) {
      this.ctx.ui.notify("No agent session is linked to this selection.", "info");
      return;
    }
    const live = this.host
      ? (await this.host.list()).find((snapshot) => snapshot.id === run.id)
      : undefined;
    if (live && this.host) {
      await this.host.takeover(this.ctx, run.id);
      return;
    }
    if (run.backend === "Pi" && run.sessionFilePath) {
      if (!("switchSession" in this.ctx)) {
        this.ctx.ui.notify(
          "Open /wayfinder to switch into an archived Pi session; shortcuts can only attach to active agents.",
          "info",
        );
        return;
      }
      const confirmed = await this.ctx.ui.confirm(
        "Switch to archived Pi session?",
        `This leaves the current session and opens ${run.sessionFilePath}`,
      );
      if (!confirmed) return;
      this.done();
      await (this.ctx as ExtensionCommandContext).switchSession(run.sessionFilePath);
      return;
    }
    this.ctx.ui.notify(
      run.sessionFilePath
        ? `The archived ${run.backend} transcript is at ${run.sessionFilePath}. Start a continuation from the ticket to resume it.`
        : "This agent is no longer attached to the active runtime.",
      "info",
    );
  }

  private async cancelSelectedRun() {
    const run = this.selectedRun();
    if (!run || run.status !== "running" || !this.host) {
      this.ctx.ui.notify("No running agent is linked to this selection.", "info");
      return;
    }
    const confirmed = await this.ctx.ui.confirm(
      `Cancel ${run.id}?`,
      run.title,
    );
    if (!confirmed) return;
    await this.host.abort(run.id);
  }

  handleInput(data: string) {
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.done();
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.state.screen === "maps") this.done();
      else this.dispatch({ type: "back" });
      return;
    }

    const waitingForFirstLoad =
      this.state.screen === "maps" &&
      this.data.trackerRefresh?.state === "loading" &&
      this.data.trackerRefresh.updatedAt === undefined;
    if (
      waitingForFirstLoad &&
      (matchesKey(data, "up") ||
        matchesKey(data, "down") ||
        matchesKey(data, "enter"))
    ) {
      return;
    }

    if (this.state.screen === "ticket") {
      if (matchesKey(data, "r")) {
        void this.hydrateSelectedTicket();
        return;
      }
      if (matchesKey(data, "n")) {
        void this.startSelectedTicket();
        return;
      }
      if (matchesKey(data, "j")) {
        void this.jumpToSelectedRun();
        return;
      }
      if (matchesKey(data, "x")) {
        void this.cancelSelectedRun();
        return;
      }
    }

    if (this.state.screen === "agents") {
      if (matchesKey(data, "enter")) {
        this.openSelectedActivity();
        return;
      }
      if (matchesKey(data, "x")) {
        void this.cancelSelectedRun();
        return;
      }
    }

    if (this.state.screen === "attention") {
      if (matchesKey(data, "a")) {
        this.dispatch({ type: "decide-discovery", decision: "accepted" });
        return;
      }
      if (matchesKey(data, "f")) {
        this.dispatch({ type: "decide-discovery", decision: "fog" });
        return;
      }
      if (matchesKey(data, "d")) {
        this.dispatch({ type: "decide-discovery", decision: "dismissed" });
        return;
      }
    }

    const numberKey = matchesKey(data, "1")
      ? 1
      : matchesKey(data, "2")
        ? 2
        : matchesKey(data, "3")
          ? 3
          : undefined;
    if (this.state.screen === "map" && numberKey !== undefined) {
      this.dispatch({ type: "set-variant", variant: numberKey });
      return;
    }

    if (
      matchesKey(data, "c") &&
      (this.state.screen === "map" || this.state.screen === "ticket")
    ) {
      this.dispatch({ type: "show-context" });
      return;
    }
    if (matchesKey(data, "g")) {
      this.dispatch({ type: "show-agents" });
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.dispatch({ type: "page-up" });
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.dispatch({ type: "page-down" });
      return;
    }
    if (matchesKey(data, "a")) {
      this.dispatch({ type: "show-attention" });
      return;
    }
    if (matchesKey(data, "s")) {
      this.dispatch({ type: "show-settings" });
      return;
    }
    if (matchesKey(data, "m")) {
      this.dispatch({ type: "show-maps" });
      return;
    }
    if (matchesKey(data, "up")) {
      this.dispatch({ type: "up" });
      return;
    }
    if (matchesKey(data, "down")) {
      this.dispatch({ type: "down" });
      return;
    }
    if (matchesKey(data, "left")) {
      this.dispatch({ type: "left" });
      return;
    }
    if (matchesKey(data, "right")) {
      this.dispatch({ type: "right" });
      return;
    }
    if (matchesKey(data, "enter")) {
      const shouldHydrateTicket = this.state.screen === "map";
      if (
        this.state.screen === "delivery-settings" ||
        this.state.screen === "tracker-settings" ||
        this.state.screen === "rule-editor" ||
        this.state.screen === "agent-editor"
      ) {
        this.handleSettingsEnter();
      } else {
        this.dispatch({ type: "enter" });
        if (shouldHydrateTicket) void this.hydrateSelectedTicket();
      }
    }
  }

  render(width: number) {
    const terminalRows = this.tui.terminal.rows || 36;
    const bodyHeight = Math.max(8, Math.min(25, terminalRows - 10));
    return renderCockpit(this.state, this.data, this.theme, width, bodyHeight);
  }

  invalidate() {}

  dispose() {
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubscribe?.();
  }
}

export async function showWayfinderCockpit(
  ctx: ExtensionContext,
  initialScreen: "maps" | "agents" = "maps",
) {
  if (cockpitOpen) return;
  if (ctx.mode !== "tui") {
    ctx.ui.notify("The Wayfinder cockpit requires interactive TUI mode.", "warning");
    return;
  }

  cockpitOpen = true;
  try {
    let repositoryRoot: string;
    let settings: WorkspaceSettings;
    let workspaceKey: string;
    let persisted: boolean;
    let activeTrackerId: WorkspaceSettings["trackerId"];
    let data: CockpitData;
    try {
      repositoryRoot = await resolveRepositoryRoot(ctx.cwd);
      const loadedSettings = await loadWorkspaceSettings(
        repositoryRoot,
        defaultData.routes,
      );
      settings = loadedSettings.settings;
      workspaceKey = loadedSettings.key;
      repositoryRoot = workspaceKey;
      persisted = loadedSettings.persisted;
      activeTrackerId = settings.trackerId;
      if (
        activeTrackerId === "github" &&
        !(await isGitHubTrackerConfigured(repositoryRoot)) &&
        (await discoverMarkdownMapFiles(repositoryRoot)).length > 0
      ) {
        activeTrackerId = "markdown";
      }
      settings = { ...settings, trackerId: activeTrackerId };
      const [cached, runs] = await Promise.all([
        loadTrackerCache(workspaceKey),
        loadRuns(workspaceKey),
      ]);
      const cachedMaps = filterCachedMaps(cached?.maps ?? []);
      const cachedMatchesTracker = Boolean(
        cachedMaps.length &&
          cachedMaps.every((map) => map.source?.provider === activeTrackerId) &&
          (activeTrackerId !== "jira" ||
            cached?.configuredJiraBoardId === settings.jiraBoardId),
      );
      data = {
        ...defaultData,
        ...(cachedMatchesTracker && cached
          ? {
              maps: cachedMaps,
              trackers: cached.trackers,
              jiraBoards: cached.jiraBoards,
            }
          : { maps: [] }),
        routes: settings.routes.map((route) => ({ ...route })),
        agentDefaults: {
          HITL: { ...settings.agentDefaults.HITL },
          AFK: { ...settings.agentDefaults.AFK },
        },
        configuredDeliveryProfileId: settings.deliveryProfileId || undefined,
        configuredTrackerId: activeTrackerId,
        configuredJiraBoardId: settings.jiraBoardId,
        settingsPath: settingsPath(),
        settingsPersisted: persisted,
        runs,
        trackerRefresh: cachedMatchesTracker && cached
          ? { state: "refreshing", updatedAt: cached.savedAt }
          : { state: "loading" },
      };
    } catch (error) {
      ctx.ui.notify(
        `Unable to open Wayfinder: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }

    const host = getSubagentHost();
    const refreshData = async (trackerId: string) => {
      const trackerPromise =
        trackerId === "markdown"
          ? loadMarkdownWayfinderData(repositoryRoot, defaultData)
          : trackerId === "github"
            ? loadGitHubWayfinderData(repositoryRoot, defaultData)
            : trackerId === "jira"
              ? loadJiraWayfinderData(
                  repositoryRoot,
                  defaultData,
                  undefined,
                  settings.jiraBoardId,
                )
              : undefined;
      if (!trackerPromise) {
        throw new Error(`The ${trackerId} Wayfinder adapter is not installed.`);
      }
      const [trackerData, agentCatalog, availableJiraBoards] = await Promise.all([
        trackerPromise,
        loadAgentCatalog(ctx),
        trackerId === "jira"
          ? Promise.resolve(undefined)
          : loadJiraBoards(repositoryRoot).catch(() => undefined),
      ]);
      if (availableJiraBoards) trackerData.jiraBoards = availableJiraBoards;
      trackerData.configuredJiraBoardId = settings.jiraBoardId;
      void saveTrackerCache(repositoryRoot, trackerData).catch((error) => {
        ctx.ui.notify(
          `Wayfinder cache could not be saved: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      });
      return { trackerData, agentCatalog };
    };

    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new WayfinderCockpitComponent({
          tui,
          theme,
          done,
          ctx,
          data,
          settings,
          workspaceKey,
          workspaceRoot: workspaceKey,
          host,
          initialScreen,
          refreshData,
        }),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: 120,
          minWidth: 50,
          maxHeight: "94%",
          margin: 1,
        },
      },
    );
  } finally {
    cockpitOpen = false;
  }
}

export default function wayfinderCockpit(pi: ExtensionAPI) {
  let unsubscribeRuntime: (() => void) | undefined;
  let stopHeartbeat: (() => Promise<void>) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    unsubscribeRuntime?.();
    unsubscribeRuntime = undefined;
    await stopHeartbeat?.();
    stopHeartbeat = undefined;
    try {
      const repositoryRoot = await resolveRepositoryRoot(ctx.cwd);
      const loadedSettings = await loadWorkspaceSettings(
        repositoryRoot,
        defaultData.routes,
      );
      stopHeartbeat = await startRepositoryHeartbeat(loadedSettings.key);
    } catch {
      // Wayfinder remains dormant outside a repository until the command is invoked.
    }
    const host = getSubagentHost();
    if (!host) return;
    const persistSnapshots = async () => {
      try {
        await syncRuns(await host.list());
      } catch (error) {
        ctx.ui.notify(
          `Wayfinder could not persist agent activity: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    };
    await persistSnapshots();
    unsubscribeRuntime = await host.subscribe(() => {
      void persistSnapshots();
    });
  });
  pi.on("session_shutdown", async () => {
    unsubscribeRuntime?.();
    unsubscribeRuntime = undefined;
    await stopHeartbeat?.();
    stopHeartbeat = undefined;
  });

  pi.registerCommand("wayfinder", {
    description: "Open the repository Wayfinder cockpit",
    handler: async (_args, ctx) => showWayfinderCockpit(ctx),
  });

  pi.registerShortcut("alt+w", {
    description: "Open Wayfinder",
    handler: (ctx) => showWayfinderCockpit(ctx),
  });

  pi.registerShortcut("alt+a", {
    description: "Open Wayfinder agent activity",
    handler: (ctx) => showWayfinderCockpit(ctx, "agents"),
  });
}
