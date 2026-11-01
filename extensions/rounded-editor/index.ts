import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

/** Keep Pi's editor, shortcuts, scroll indicators, and completion menu intact. */
export class RoundedEditor extends CustomEditor {
  private bottomBorder = "";

  protected renderBottomBorder(width: number, hiddenLineCount: number): string {
    this.bottomBorder = super.renderBottomBorder(width, hiddenLineCount);
    return this.bottomBorder;
  }

  private canFrame(width: number): boolean {
    // Leave at least two native content columns, even with horizontal padding.
    return width >= Math.max(8, this.getPaddingX() * 2 + 4);
  }

  private fallbackWidth(width: number): number {
    return Math.max(width, 8, this.getPaddingX() * 2 + 2);
  }

  render(width: number): string[] {
    // Native wrapping needs at least two content columns for wide graphemes.
    // If the frame/padding would squeeze them out, clip a safe native layout.
    if (!this.canFrame(width)) {
      return super.render(this.fallbackWidth(width))
        .map((line) => truncateToWidth(line, width, ""));
    }

    const lines = super.render(width - 2);
    const bottom = lines.lastIndexOf(this.bottomBorder);
    const border = (text: string) => this.borderColor(text);

    return lines.map((line, row) => {
      if (row === 0) return border("╭") + line + border("╮");
      if (row === bottom) return border("╰") + line + border("╯");
      if (row < bottom) return border("│") + line + border("│");
      // Completions belong below the frame, aligned with the input text.
      return " " + line + " ";
    });
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.canFrame(event.width)) {
      return super.handleMouse({ ...event, width: this.fallbackWidth(event.width) });
    }
    return super.handleMouse({ ...event, x: event.x - 1, width: event.width - 2 });
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new RoundedEditor(tui, theme, keybindings),
    );
  });
}
