# pi

Personal Pi package for extensions and resources.

## Bootstrap

Clone this repo to the expected local path, then install it as a Pi package:

```bash
git clone <repo-url> ~/Projects/pi
pi install ~/Projects/pi
```

## Extensions

- `rounded-editor`: Frames the native input editor with rounded corners
  (`╭╮╰╯`) and vertical sides, keeping the active theme, shortcuts, scroll
  indicators, completion menu, and mouse cursor placement. Run `/reload` after
  adding it; this package already discovers `extensions/*/index.ts`.
  For full UI alternatives in the [Pi theme catalog](https://pi.dev/packages?type=theme),
  see [pi-open-tui](https://github.com/OldSuns/pi-open-tui) (rounded editor,
  header, and footer) and [pi-zentui](https://github.com/lmilojevicc/pi-zentui)
  (modular UI components). This extension only changes the editor frame;
  don't enable multiple editor replacements together.

- `discord-presence`: Discord Rich Presence for interactive Pi sessions. Shows
  live activity like editing a file, running commands, browsing, thinking, and
  idle status without broadcasting file names or project directory names. Idle
  presence clears automatically after 5 minutes so Pi does not keep taking over
  your Discord status.
  Configure with `~/.pi/agent/discord-presence.json`, project-level
  `.pi/discord-presence.json`, `PI_DISCORD_CLIENT_ID`, or `/presence on|off|status`.
