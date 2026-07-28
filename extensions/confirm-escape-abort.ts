import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export function shouldConfirmEscape(
  data: string,
  isIdle: boolean,
  isShowingAutocomplete: boolean,
) {
  return matchesKey(data, "escape") && !isIdle && !isShowingAutocomplete;
}

class ConfirmEscapeEditor extends CustomEditor {
  private confirmationOpen = false;
  confirmAbort?: () => Promise<void>;
  isAgentIdle?: () => boolean;

  override handleInput(data: string): void {
    if (
      shouldConfirmEscape(
        data,
        this.isAgentIdle?.() ?? true,
        this.isShowingAutocomplete(),
      )
    ) {
      if (this.confirmationOpen || !this.confirmAbort) return;
      this.confirmationOpen = true;
      void this.confirmAbort().finally(() => {
        this.confirmationOpen = false;
      });
      return;
    }

    super.handleInput(data);
  }
}

async function confirmAbort(ctx: ExtensionContext) {
  const confirmed = await ctx.ui.confirm(
    "Abort the current agent run?",
    "Escape will stop the response and any active tool work. The session history is preserved. Choose Yes to abort or No/Escape to keep it running.",
  );
  if (!confirmed) return;

  if (ctx.isIdle()) {
    ctx.ui.notify("The agent finished before the abort was confirmed.", "info");
    return;
  }

  ctx.abort();
  ctx.ui.notify("Current agent run aborted by explicit confirmation.", "warning");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new ConfirmEscapeEditor(tui, theme, keybindings);
      editor.isAgentIdle = () => ctx.isIdle();
      editor.confirmAbort = () => confirmAbort(ctx);
      return editor;
    });
  });
}
