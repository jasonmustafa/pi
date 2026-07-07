# pi

Personal Pi package for extensions and resources.

## Install locally

Clone the repo, then install it from the repo root:

```bash
git clone <repo-url> pi
cd pi
pi install "$PWD"
```

For local development, edit files in the repo and run `/reload` in Pi.

## Extensions

- `web-access`: OpenAI/Codex web search, URL fetching, GitHub repo cloning, and YouTube transcript/frame helpers.
  - HTTP fetches revalidate redirects and pin DNS results to reduce SSRF risk.
  - Cache location defaults to `~/.pi/agent/web-cache`; set `PI_WEB_ACCESS_CACHE_DIR` to override it. For Clank-style deployments, if `CLANK_WORKSPACE_ROOT` is set and no explicit cache dir is configured, the cache defaults to `$CLANK_WORKSPACE_ROOT/.web-cache` so returned local paths remain under the workspace allowlist.
  - The third-party Jina Reader fallback is disabled by default. Set `PI_WEB_ACCESS_ENABLE_JINA_READER=true` to enable it; URLs with userinfo, query strings, or fragments are still not sent to Jina.
