# pi

Personal Pi package for extensions and resources.

## Bootstrap

Clone this repo to the expected local path, then install it as a Pi package:

```bash
git clone <repo-url> ~/Projects/pi
pi install ~/Projects/pi
```

## Extensions

- `web-access`: OpenAI/Codex web search, URL fetching, GitHub repo cloning, and
  YouTube transcript/frame helpers.
- `discord-presence`: Discord Rich Presence for interactive Pi sessions. Shows
  live activity like editing a file, running commands, browsing, thinking, and
  idle status without broadcasting file names or project directory names. Idle
  presence clears automatically after 5 minutes so Pi does not keep taking over
  your Discord status.
  Configure with `~/.pi/agent/discord-presence.json`, project-level
  `.pi/discord-presence.json`, `PI_DISCORD_CLIENT_ID`, or `/presence on|off|status`.
