import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import registerRoundedEditor, { RoundedEditor } from "./index.ts";

const identity = (text: string) => text;
const tui = { terminal: { rows: 24 }, requestRender() {} };
const theme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity, selectedText: identity, description: identity,
    scrollInfo: identity, noMatch: identity,
  },
};
const keybindings = { matches: () => false };

function editor() {
  return new RoundedEditor(tui as never, theme, keybindings as never);
}

test("installs the replacement only in interactive TUI sessions", () => {
  let handler: Function | undefined;
  let installs = 0;
  registerRoundedEditor({ on(event: string, callback: Function) {
    assert.equal(event, "session_start");
    handler = callback;
  } } as never);
  for (const mode of ["rpc", "json", "print", "tui"]) {
    handler!({}, { mode, ui: { setEditorComponent() { installs++; } } });
    assert.equal(installs, mode === "tui" ? 1 : 0);
  }
});

test("rounds the native borders and retains the focused cursor", () => {
  const input = editor();
  input.focused = true;
  input.setText("hello");
  const lines = input.render(20);
  assert.equal(lines[0], "╭" + "─".repeat(18) + "╮");
  assert.equal(lines.at(-1), "╰" + "─".repeat(18) + "╯");
  assert.ok(lines[1].startsWith("│hello"));
  assert.ok(lines[1].endsWith("│"));
  assert.ok(lines[1].includes(CURSOR_MARKER));
});

test("fits narrow, resized, multiline, and wide-character input", () => {
  const input = editor();
  for (const padding of [0, 1, 2, 3, 10]) {
    input.setPaddingX(padding);
    for (const text of ["", "hello", "你好 👋 café", "one\ntwo\nthree", "x".repeat(300)]) {
      input.setText(text);
      for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 80, 12]) {
        for (const line of input.render(width)) assert.ok(visibleWidth(line) <= width);
      }
    }
  }
});

test("uses the active border color on every render", () => {
  const input = editor();
  for (const color of [31, 32]) {
    input.borderColor = (text) => `\x1b[${color}m${text}\x1b[0m`;
    input.invalidate();
    const lines = input.render(20);
    assert.ok(lines[0].startsWith(`\x1b[${color}m╭`));
    assert.ok(lines[1].startsWith(`\x1b[${color}m│`));
    assert.ok(lines.at(-1)!.endsWith(`\x1b[${color}m╯\x1b[0m`));
    assert.ok(lines.every((line) => visibleWidth(line) === 20));
  }
});

test("mouse clicks position the cursor in framed and fallback layouts", () => {
  const input = editor();
  input.focused = true;
  input.setText("hello");
  for (const [width, padding, x, expected] of [[20, 0, 3, 2], [9, 3, 4, 1], [3, 0, 1, 1]]) {
    input.setPaddingX(padding);
    input.render(width);
    input.handleMouse({ type: "click", button: "left", x, y: 1, width, height: 3 } as never);
    assert.equal(input.getCursor().col, expected);
  }
});

test("preserves scroll indicators and falls back at tiny widths", () => {
  const input = editor();
  input.setText(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
  assert.match(input.render(40)[0], /↑/);
  for (const width of [1, 2, 3]) {
    assert.ok(input.render(width).every((line) => visibleWidth(line) <= width));
  }
});

test("keeps slash-command completions outside the frame", async () => {
  const input = editor();
  input.setAutocompleteProvider(new CombinedAutocompleteProvider([
    { name: "reload", description: "Reload extensions" },
    { name: "resume", description: "Resume session" },
  ], process.cwd()));
  input.setText("/re");
  input.handleInput("\t");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(input.isShowingAutocomplete());
  const lines = input.render(40);
  const bottom = lines.findIndex((line) => line.startsWith("╰"));
  assert.ok(bottom > 0 && bottom < lines.length - 1);
  for (const line of lines.slice(bottom + 1)) {
    assert.ok(line.startsWith(" "));
    assert.ok(!line.includes("│"));
    assert.ok(visibleWidth(line) <= 40);
  }
});

test("translates mouse coordinates into the inner native editor", () => {
  const original = CustomEditor.prototype.handleMouse;
  let received: unknown;
  CustomEditor.prototype.handleMouse = (event) => {
    received = event;
    return { handled: true, focus: true };
  };
  try {
    const event = { type: "click", button: "left", x: 4, y: 1, width: 20, height: 3 };
    const result = editor().handleMouse(event as never);
    assert.deepEqual(received, { ...event, x: 3, width: 18 });
    assert.deepEqual(result, { handled: true, focus: true });
    editor().handleMouse({ ...event, width: 3 } as never);
    assert.deepEqual(received, { ...event, width: 8 });
    const padded = editor();
    padded.setPaddingX(3);
    padded.handleMouse({ ...event, width: 9 } as never);
    assert.deepEqual(received, { ...event, width: 9 });
  } finally {
    CustomEditor.prototype.handleMouse = original;
  }
});
