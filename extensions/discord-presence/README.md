# Discord presence

Discord Rich Presence for interactive Pi sessions. Enabled by default; requires
Discord's desktop client running locally. Non-interactive sessions do not publish
presence. Multiple Pi sessions share one Discord slot (last update wins).

Shows activity, model, language icons for recognized file extensions, and elapsed
session time. File names and project names are not published. Shell activity shows
only allowlisted command names, otherwise `shell`; custom tool names and model
names are still public. Updates coalesce to the latest state at most once every
15 seconds. Idle presence clears after five minutes and resumes with activity.

## Configuration

Global `~/.pi/agent/discord-presence.json`:

```json
{ "enabled": true, "clientId": "1520833162148712580" }
```

Trusted projects may override enablement in `.pi/discord-presence.json`:

```json
{ "enabled": false }
```

`/presence on|off|status` controls the current runtime. Enablement precedence is
runtime toggle > trusted project > global. `PI_DISCORD_CLIENT_ID` overrides the
global client ID; otherwise the extension uses `defaults.json`. The bundled ID
is the upstream project's public Pi application ID, not a credential. Custom
Discord applications must provide their own image assets (including `pi_logo`).

## Checks

With a recent Node.js version that supports native TypeScript stripping:

```sh
node --test extensions/discord-presence/index.test.ts
```

The tests use a local fake Discord IPC server; they do not publish real presence.

## Attribution

Adapted from [gwynnnplaine/pi-discord-presence](https://github.com/gwynnnplaine/pi-discord-presence)
under the MIT license. Much of the activity, configuration, scheduling, and
rendering structure comes from that project. This version replaces its RPC
library adapter with direct Node.js IPC, hides file/project names, and adds idle
clearing and regression tests. The upstream copyright notice is retained in
[LICENSE](LICENSE), alongside attribution for local modifications.
