/**
 * Takeover UI for subagents (ported from v1, rendering from the synchronous
 * SubagentReadModel instead of live pi sessions):
 * - SubagentDashboard: centered modal listing all subagents.
 * - TakeoverView: bounded interactive modal for one subagent with an input line
 *   to steer/continue it.
 */

import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type {
  Component,
  Focusable,
  SelectItem,
  SettingItem,
  TUI,
} from "@earendil-works/pi-tui";
import {
  Container,
  Input,
  SelectList,
  SettingsList,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_SUBAGENT_CONFIG,
  loadSubagentConfig,
  saveSubagentConfig,
  subagentConfigPath,
  type SubagentConfig,
} from "../config.ts";
import {
  BACKEND_NAMES,
  formatElapsed,
  REASONING_EFFORTS,
  SUBAGENT_PROFILES,
  type BackendName,
  type ReasoningEffort,
  type SubagentProfile,
  type SubagentSnapshot,
} from "../domain.ts";
import {
  listCursorModels,
  type CursorModelOption,
} from "../backends/cursor.ts";
import { formatContextUtilization } from "../format.ts";
import type { SubagentReadModel } from "../manager.ts";
import { buildTranscriptLines } from "./transcript.ts";

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(snap: SubagentSnapshot, theme: Theme): string {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "■");
    case "done":
      return theme.fg("success", "■");
    case "error":
      return theme.fg("error", "■");
  }
}

function statusWord(snap: SubagentSnapshot, theme: Theme): string {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "error":
      return theme.fg("error", "failed");
  }
}

// --- Entry points --------------------------------------------------------------

export const SUBAGENT_MODAL_OPTIONS = {
  anchor: "center",
  width: 112,
  minWidth: 58,
  maxHeight: "88%",
  margin: 1,
} as const;

function modalHeight(tui: TUI) {
  const rows = tui.terminal.rows || 30;
  return Math.max(12, Math.min(34, Math.floor(rows * 0.84)));
}

export interface TakeoverOptions {
  readonly badge?: string;
}

export async function openSubagentTakeover(
  ctx: ExtensionContext,
  view: SubagentReadModel,
  id: string,
  options?: TakeoverOptions,
) {
  if (!view.get(id)) return;
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new TakeoverView(tui, theme, keybindings, id, view, done, options),
    {
      overlay: true,
      overlayOptions: SUBAGENT_MODAL_OPTIONS,
    },
  );
}

export async function openSubagentPicker(
  ctx: ExtensionContext,
  view: SubagentReadModel,
) {
  const selection: DashboardSelection = { index: 0 };

  while (true) {
    if (view.size() === 0) {
      ctx.ui.notify("No subagents", "info");
      return;
    }

    const picked = await ctx.ui.custom<string | "settings" | null>(
      (tui, theme, keybindings, done) =>
        new SubagentDashboard(tui, theme, keybindings, view, selection, done),
      {
        overlay: true,
        overlayOptions: SUBAGENT_MODAL_OPTIONS,
      },
    );

    if (!picked) return;
    if (picked === "settings") {
      await openSubagentSettings(ctx);
      continue;
    }
    if (!view.get(picked)) continue;

    await openSubagentTakeover(ctx, view, picked);
    // After leaving the takeover view, fall back to the dashboard.
  }
}

// --- Settings -------------------------------------------------------------------

const COMMON_MODELS: Record<BackendName, CursorModelOption[]> = {
  pi: [
    { id: "inherit", label: "Inherit parent model" },
    { id: "openai-codex/gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "openai-codex/gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "opencode/claude-fable-5", label: "Claude Fable 5" },
  ],
  claude: [
    { id: "native", label: "Claude Code default" },
    { id: "fable", label: "Latest Fable" },
    { id: "sonnet", label: "Latest Sonnet" },
    { id: "opus", label: "Latest Opus" },
  ],
  codex: [
    { id: "native", label: "Codex default" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  ],
  cursor: [{ id: "auto", label: "Cursor Auto" }],
};

class ConfirmationList implements Component {
  private readonly list: SelectList;

  constructor(theme: Theme, done: (selectedValue?: string) => void) {
    this.list = new SelectList(
      [
        { value: "cancel", label: "Cancel", description: "Keep current settings" },
        { value: "reset", label: "Reset all settings", description: "Restore checked-in defaults and presets" },
      ],
      2,
      {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    );
    this.list.onSelect = (item) => done(item.value === "reset" ? "reset" : undefined);
    this.list.onCancel = () => done(undefined);
  }

  render(width: number) {
    return ["Confirm reset", "", ...this.list.render(width), "", "  Enter confirm · Esc back"];
  }

  handleInput(data: string) {
    this.list.handleInput(data);
  }

  invalidate() {
    this.list.invalidate();
  }
}

class SearchableModelList implements Component {
  private readonly input = new Input();
  private readonly list: SelectList;

  constructor(
    models: CursorModelOption[],
    currentValue: string,
    theme: Theme,
    done: (selectedValue?: string) => void,
  ) {
    const items: SelectItem[] = models.map((model) => ({
      value: model.id,
      label: model.id,
      description: model.label,
    }));
    this.list = new SelectList(items, 12, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    const currentIndex = items.findIndex((item) => item.value === currentValue);
    if (currentIndex >= 0) this.list.setSelectedIndex(currentIndex);
    this.list.onSelect = (item) => done(item.value);
    this.list.onCancel = () => done(undefined);
  }

  render(width: number) {
    return [
      ...this.input.render(width),
      "",
      ...this.list.render(width),
      "",
      "  Type to filter by model id · ↑↓ select · Enter apply · Esc back",
    ];
  }

  handleInput(data: string) {
    if (/^[\x20-\x7e]$/.test(data) || data === "\x7f" || data === "\b") {
      this.input.handleInput(data);
      this.list.setFilter(this.input.getValue());
      return;
    }
    this.list.handleInput(data);
  }

  invalidate() {
    this.input.invalidate();
    this.list.invalidate();
  }
}

function uniqueModels(models: CursorModelOption[], current?: string) {
  const result = [...models];
  if (current && !result.some((model) => model.id === current)) {
    result.unshift({ id: current, label: "Configured model (currently unavailable)" });
  }
  return result;
}

function displayModel(backend: BackendName, model: string | undefined) {
  return model ?? (backend === "pi" ? "inherit" : "native");
}

function storedModel(value: string) {
  return value === "inherit" || value === "native" ? undefined : value;
}

export function updateSubagentSetting(
  config: SubagentConfig,
  id: string,
  value: string,
): SubagentConfig {
  const next = structuredClone(config);
  if (id === "defaultHarness" && BACKEND_NAMES.includes(value as BackendName)) {
    return { ...next, defaultHarness: value as BackendName };
  }
  const [scope, name, field] = id.split(":");
  if (scope === "default" && BACKEND_NAMES.includes(name as BackendName)) {
    const backend = name as BackendName;
    const profile = SUBAGENT_PROFILES.includes(value as SubagentProfile)
      ? value as SubagentProfile
      : undefined;
    const safeProfile =
      backend !== "cursor" || profile === "scout" || profile === "researcher"
        ? profile
        : undefined;
    const effort = REASONING_EFFORTS.includes(value as ReasoningEffort)
      ? value as ReasoningEffort
      : undefined;
    next.defaults[backend] = {
      ...next.defaults[backend],
      ...(field === "model" ? { model: storedModel(value) } : {}),
      ...(field === "effort" && (value === "inherit" || effort)
        ? { reasoningEffort: value === "inherit" ? undefined : effort }
        : {}),
      ...(field === "profile" && safeProfile ? { profile: safeProfile } : {}),
    };
  }
  if (scope === "preset" && next.presets[name]) {
    const preset = next.presets[name];
    const profile = SUBAGENT_PROFILES.includes(value as SubagentProfile)
      ? value as SubagentProfile
      : undefined;
    const safeProfile =
      preset.harness !== "cursor" || profile === "scout" || profile === "researcher"
        ? profile
        : undefined;
    next.presets[name] = {
      ...preset,
      ...(field === "model" ? { model: storedModel(value) } : {}),
      ...(field === "profile" && safeProfile ? { profile: safeProfile } : {}),
    };
  }
  return next;
}

function settingItems(
  config: SubagentConfig,
  cursorModels: CursorModelOption[],
  theme: Theme,
): SettingItem[] {
  const baseCatalog = (backend: BackendName) =>
    backend === "cursor" && cursorModels.length > 0
      ? cursorModels
      : COMMON_MODELS[backend];
  const modelCatalog = (backend: BackendName, current?: string) =>
    uniqueModels(baseCatalog(backend), current);
  const modelSubmenu = (backend: BackendName) =>
    (currentValue: string, done: (selectedValue?: string) => void) =>
      new SearchableModelList(
        modelCatalog(backend, storedModel(currentValue)),
        currentValue,
        theme,
        done,
      );

  const items: SettingItem[] = [
    {
      id: "defaultHarness",
      label: "Default harness",
      currentValue: config.defaultHarness,
      values: [...BACKEND_NAMES],
      description: "Used when subagent_spawn omits both harness and preset.",
    },
  ];
  for (const backend of BACKEND_NAMES) {
    const defaults = config.defaults[backend];
    const available =
      defaults.model === "auto" ||
      baseCatalog(backend).some(
        (model) => model.id === displayModel(backend, defaults.model),
      );
    items.push(
      {
        id: `default:${backend}:model`,
        label: `${backend} model`,
        currentValue: displayModel(backend, defaults.model),
        submenu: modelSubmenu(backend),
        description: available
          ? `Default model for future ${backend} children.`
          : "Configured model is not in the current catalog; spawning will report a clear error.",
      },
      ...(backend === "cursor"
        ? []
        : [{
            id: `default:${backend}:effort`,
            label: `${backend} effort`,
            currentValue: defaults.reasoningEffort ?? "inherit",
            values: ["inherit", ...REASONING_EFFORTS],
            description: "Shared reasoning scale; the harness maps it to native settings.",
          } satisfies SettingItem]),
      {
        id: `default:${backend}:profile`,
        label: `${backend} profile`,
        currentValue: defaults.profile ?? "scout",
        values: backend === "cursor"
          ? ["scout", "researcher"]
          : [...SUBAGENT_PROFILES],
        description: backend === "cursor"
          ? "Cursor is restricted to read-only scout/researcher profiles."
          : "Default safety profile for future children.",
      },
    );
  }
  for (const [name, preset] of Object.entries(config.presets)) {
    items.push(
      {
        id: `preset:${name}:model`,
        label: `Preset ${name}`,
        currentValue: displayModel(preset.harness, preset.model),
        submenu: modelSubmenu(preset.harness),
        description: `${preset.harness} preset model. Explicit spawn options override it.`,
      },
      {
        id: `preset:${name}:profile`,
        label: `Preset ${name} profile`,
        currentValue: preset.profile ?? "scout",
        values: preset.harness === "cursor"
          ? ["scout", "researcher"]
          : [...SUBAGENT_PROFILES],
      },
    );
  }
  items.push({
    id: "reset",
    label: "Reset all defaults",
    currentValue: "requires confirmation",
    submenu: (_current, done) => new ConfirmationList(theme, done),
    description: "Restore the checked-in personal defaults and presets.",
  });
  return items;
}

export async function openSubagentSettings(ctx: ExtensionContext) {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("Subagent settings require TUI mode.", "error");
    return;
  }
  let config = await loadSubagentConfig();
  const cursorModels = await listCursorModels({ refresh: true }).catch(() => []);
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let saveQueue: Promise<void> = Promise.resolve();
    const persist = () => {
      const snapshot = structuredClone(config);
      saveQueue = saveQueue
        .then(() => saveSubagentConfig(snapshot))
        .catch((error) => ctx.ui.notify(String(error), "error"));
      return saveQueue;
    };
    const container = new Container();
    container.addChild(
      new Text(
        `${theme.fg("accent", theme.bold("Subagent Settings"))}\n${theme.fg("dim", subagentConfigPath())}`,
        1,
        1,
      ),
    );
    const list = new SettingsList(
      settingItems(config, cursorModels, theme),
      16,
      getSettingsListTheme(),
      (id, value) => {
        if (id === "reset" && value === "reset") {
          config = structuredClone(DEFAULT_SUBAGENT_CONFIG);
          void persist().then(() => {
            ctx.ui.notify("Subagent settings reset.", "info");
            done();
          });
          return;
        }
        config = updateSubagentSetting(config, id, value);
        void persist();
      },
      () => done(),
      { enableSearch: true },
    );
    container.addChild(list);
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: SUBAGENT_MODAL_OPTIONS,
  });
}

// --- Dashboard modal ------------------------------------------------------------

export interface DashboardSelection {
  id?: string;
  index: number;
}

export function reconcileDashboardSelection(
  selection: DashboardSelection,
  subs: ReadonlyArray<Pick<SubagentSnapshot, "id">>,
) {
  const stableIndex = selection.id
    ? subs.findIndex((snap) => snap.id === selection.id)
    : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, subs.length - 1));
  selection.id = subs[selection.index]?.id;
}

class SubagentDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private view: SubagentReadModel;
  private selection: DashboardSelection;
  private done: (value: string | "settings" | null) => void;

  private closed = false;
  private ticker: ReturnType<typeof setInterval>;
  private unsubChange: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: SubagentReadModel,
    selection: DashboardSelection,
    done: (value: string | "settings" | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.selection = selection;
    this.done = done;
    // Elapsed times, token counts, and statuses tick along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.unsubChange = view.subscribe(() => this.tui.requestRender());
  }

  private subs(): ReadonlyArray<SubagentSnapshot> {
    return this.view.list();
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubChange();
    return true;
  }

  private close(result: string | "settings" | null) {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const snap = subs[this.selection.index];
      if (snap) this.close(snap.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (subs.length > 0) {
        this.selection.index =
          (this.selection.index - 1 + subs.length) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (subs.length > 0) {
        this.selection.index = (this.selection.index + 1) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "x") {
      const snap = subs[this.selection.index];
      if (snap && snap.status === "running") this.view.requestAbort(snap.id);
      return;
    }
    if (data === "s") {
      this.close("settings");
      return;
    }
  }

  private pad(text: string, width: number): string {
    const truncated = truncateToWidth(text, width);
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }

  private borderSegment(width: number, title: string): string {
    const theme = this.theme;
    const label = title
      ? ` ${truncateToWidth(title, Math.max(0, width - 3))} `
      : "";
    const labelWidth = visibleWidth(label);
    return (
      theme.fg("border", "─") +
      (label ? theme.fg("text", label) : "") +
      theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
    );
  }

  render(width: number): string[] {
    const theme = this.theme;
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    // Keep the dashboard bounded like Pi's other centered overlays instead of
    // replacing the whole terminal. Four rows are reserved for modal chrome.
    const bodyHeight = Math.max(6, modalHeight(this.tui) - 4);
    const innerWidth = width - 2;

    const lines: string[] = [];

    // Header: title left, count right
    const headerLeft = theme.fg("accent", theme.bold("Subagents"));
    const headerRight = theme.fg(
      "muted",
      `${subs.length} agent${subs.length === 1 ? "" : "s"}`,
    );
    const headerPad = Math.max(
      1,
      width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4,
    );
    lines.push(
      truncateToWidth(
        `  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `,
        width,
      ),
    );

    // Top border with panel title
    const settled = subs.filter((s) => s.status !== "running").length;
    lines.push(
      theme.fg("border", "╭") +
        this.borderSegment(innerWidth, `agents · ${settled}/${subs.length}`) +
        theme.fg("border", "╮"),
    );

    // Rows
    const divider = theme.fg("border", "│");
    const rowLines = this.renderRows(subs, innerWidth, bodyHeight);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(divider + this.pad(rowLines[i] ?? "", innerWidth) + divider);
    }

    // Bottom border
    lines.push(
      theme.fg("border", "╰") +
        theme.fg("border", "─".repeat(innerWidth)) +
        theme.fg("border", "╯"),
    );

    // Hints
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} take over · x abort · s settings · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
        ),
        width,
      ),
    );

    return lines;
  }

  private renderRows(
    subs: ReadonlyArray<SubagentSnapshot>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    // Scroll window around selection
    let start = 0;
    if (subs.length > height) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(height / 2)),
        subs.length - height,
      );
    }
    const visible = subs.slice(start, start + height);

    for (let i = 0; i < visible.length; i++) {
      const snap = visible[i];
      const index = start + i;
      const isSelected = index === this.selection.index;

      // Left: marker, status square, title, dim id
      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const title = isSelected
        ? theme.fg("accent", snap.title)
        : theme.fg("text", snap.title);
      const left = ` ${marker} ${statusGlyph(snap, theme)} ${title} ${theme.fg("dim", snap.id)}`;

      // Right: backend · model · context utilization · elapsed · status
      const utilization = formatContextUtilization(snap.usage);
      const dot = theme.fg("dim", " · ");
      const rightParts = [
        theme.fg("muted", snap.backend),
        theme.fg("muted", `${snap.profile} · ${snap.meta.modelLabel ?? "?"}`),
        ...(utilization ? [theme.fg("muted", utilization)] : []),
        theme.fg("muted", formatElapsed(snap)),
        statusWord(snap, theme),
      ];
      const right = `${rightParts.join(dot)} `;

      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, width - rightWidth - 2);
      const leftTruncated = truncateToWidth(left, leftMax);
      const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
      out.push(truncateToWidth(leftTruncated + " ".repeat(gap) + right, width));
    }

    if (start > 0) {
      out[0] = truncateToWidth(theme.fg("dim", `   ... ${start} more`), width);
    }
    if (start + height < subs.length) {
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `   ... ${subs.length - start - height} more`),
        width,
      );
    }
    return out;
  }

  invalidate(): void {}
}

// --- Takeover view ------------------------------------------------------------

const TRANSCRIPT_SCROLL_STEP = 6;

class TakeoverView implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private id: string;
  private view: SubagentReadModel;
  private done: (value: null) => void;
  private options?: TakeoverOptions;

  private input = new Input();
  /** Scroll offset in lines from the bottom of the transcript. 0 = pinned to bottom. */
  private scrollOffset = 0;
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private ticker: ReturnType<typeof setInterval>;
  private closed = false;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    id: string,
    view: SubagentReadModel,
    done: (value: null) => void,
    options?: TakeoverOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.id = id;
    this.view = view;
    this.done = done;
    this.options = options;
    this.unsubscribe = view.subscribeTo(id, () => this.scheduleRender());
    // Elapsed time in the header ticks along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.input.onSubmit = (value: string) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.view.requestSend(this.id, text);
      this.scrollOffset = 0;
      this.tui.requestRender();
    };
  }

  private snap(): SubagentSnapshot | undefined {
    return this.view.get(this.id);
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // Streaming can emit an event per token. Limit terminal repaints so this
    // view cannot starve input handling or make the child look frozen.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    return true;
  }

  private close() {
    if (this.cleanup()) this.done(null);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.clear")) {
      const snap = this.snap();
      if (snap?.status === "running") this.view.requestAbort(this.id);
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scrollOffset += TRANSCRIPT_SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - TRANSCRIPT_SCROLL_STEP,
      );
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - this.viewportHeight(),
      );
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    // Header, input, hints, and borders consume seven rows inside the modal.
    return Math.max(6, modalHeight(this.tui) - 7);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
    const lines: string[] = [];
    const snap = this.snap();

    if (!snap) {
      lines.push(border);
      lines.push(theme.fg("dim", `${this.id} is no longer tracked`));
      lines.push(border);
      return lines;
    }

    lines.push(border);
    const utilization = formatContextUtilization(snap.usage);
    const header =
      `${statusGlyph(snap, theme)} ` +
      theme.fg("accent", theme.bold(`${snap.id} · ${snap.title}`)) +
      theme.fg("muted", ` · ${snap.status} · ${formatElapsed(snap)}`) +
      (this.options?.badge
        ? theme.fg("muted", ` · ${this.options.badge}`)
        : "") +
      theme.fg("dim", ` · ${snap.backend}/${snap.profile}: ${snap.meta.modelLabel ?? "?"}`) +
      (utilization ? theme.fg("dim", ` · ${utilization}`) : "");
    lines.push(truncateToWidth(header, width));
    lines.push(border);

    // Fixed-height transcript viewport. Error and scroll status consume rows
    // inside the viewport so streaming/scrolling never changes overlay height.
    const transcript = buildTranscriptLines(snap, width, theme);
    const viewport = this.viewportHeight();
    const errorRows = snap.errorText ? 1 : 0;
    const scrollRows = this.scrollOffset > 0 ? 1 : 0;
    const transcriptCapacity = Math.max(1, viewport - errorRows - scrollRows);
    const maxOffset = Math.max(0, transcript.length - transcriptCapacity);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const body: string[] = [];
    if (snap.errorText) {
      body.push(
        truncateToWidth(theme.fg("error", `error: ${snap.errorText}`), width),
      );
    }

    const capacity = Math.max(
      1,
      viewport - body.length - (this.scrollOffset > 0 ? 1 : 0),
    );
    const end = transcript.length - this.scrollOffset;
    const visible = transcript.slice(Math.max(0, end - capacity), end);
    if (visible.length === 0) body.push(theme.fg("dim", "(no output yet)"));
    else body.push(...visible);

    if (this.scrollOffset > 0) {
      body.push(
        truncateToWidth(
          theme.fg("dim", `... ${this.scrollOffset} lines below · ↓/pgdn`),
          width,
        ),
      );
    }
    while (body.length < viewport) body.push("");
    lines.push(...body.slice(0, viewport));

    lines.push(border);
    lines.push(...this.input.render(width));
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `${configuredKeys(this.keybindings, "tui.input.submit")} send · ${configuredKeys(this.keybindings, "app.interrupt")} back · ${configuredKeys(this.keybindings, "app.clear")} abort run · ${configuredKeys(this.keybindings, "tui.editor.cursorUp")}/${configuredKeys(this.keybindings, "tui.editor.cursorDown")} scroll · ${configuredKeys(this.keybindings, "tui.editor.pageUp")}/${configuredKeys(this.keybindings, "tui.editor.pageDown")} page`,
        ),
        width,
      ),
    );
    lines.push(border);
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
