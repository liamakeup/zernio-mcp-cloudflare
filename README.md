# zernio-mcp-cloudflare

Streamable HTTP proxy in front of the [Zernio](https://zernio.com/agents) MCP server, running as a
stateless Cloudflare Worker. One endpoint for every agent (Antigravity, Claude Code, Codex, Cursor,
n8n…), with the Zernio API key kept as a Worker secret instead of in each client's config.

- Endpoint: `https://api.liamakeup.workers.dev/mcp`
- Health: `https://api.liamakeup.workers.dev/health`

## Cloudflare Free plan

- Plain `fetch` Worker: no Durable Objects, KV, D1 or other paid bindings.
- ~2.5 KiB gzipped, ~3 ms startup; the Worker only relays I/O, well under the 10 ms CPU limit.
- Free plan quota: 100,000 requests/day on `*.workers.dev`.

## How requests are authorized

The Worker fails closed:

| Caller sends | Result |
|---|---|
| `x-gateway-token: <GATEWAY_TOKEN>` (or `Authorization: Bearer <GATEWAY_TOKEN>`) | Uses the Worker's `ZERNIO_API_KEY` |
| Gateway token **and** its own key in `x-api-key` | Uses the caller's key |
| Nothing, or a wrong gateway token | `401`, no upstream call |

- Without `GATEWAY_TOKEN` configured, the Worker never spends its own key; callers must bring their
  own key via `x-api-key` or `Authorization: Bearer`.
- Tokens are accepted only in headers, never in the URL, so they stay out of Workers logs.
- Prefer `x-gateway-token` over `Authorization`: some clients treat `Authorization` as an OAuth slot.

## Behaviour

- `POST /mcp` only. Every JSON-RPC request (including `initialize`) is relayed to
  `https://mcp.zernio.com/mcp`, so capabilities, tools and `Mcp-Session-Id` come from upstream.
- Responses stream back unbuffered (`text/event-stream` or JSON).
- Notifications get `202 Accepted` immediately and are relayed in the background (`ctx.waitUntil`).
- Batch requests return `-32600` (JSON-RPC batching was removed from MCP in 2025-06-18).
- Upstream calls that send no response headers within 60 s return `504`; streams already under way are not cut; a rejected Zernio key returns the upstream `401`/`403` with code `-32001`.

## Deploy

```bash
npm install
npx wrangler secret put ZERNIO_API_KEY
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | npx wrangler secret put GATEWAY_TOKEN
npm run deploy
curl https://api.liamakeup.workers.dev/health   # requiresGatewayToken: true
```

## Connect agents

Replace `<GATEWAY_TOKEN>` with the value you stored. Ready-made snippets are in [`clients/`](clients/).

```bash
# Antigravity
agy mcp add --header "x-gateway-token: <GATEWAY_TOKEN>" zernio https://api.liamakeup.workers.dev/mcp

# Claude Code
claude mcp add --transport http zernio https://api.liamakeup.workers.dev/mcp -H "x-gateway-token: <GATEWAY_TOKEN>"
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.zernio]
url = "https://api.liamakeup.workers.dev/mcp"
http_headers = { "x-gateway-token" = "<GATEWAY_TOKEN>" }
```

```json
// Cursor: .cursor/mcp.json (keep this file out of git)
{ "mcpServers": { "zernio": { "url": "https://api.liamakeup.workers.dev/mcp",
  "headers": { "x-gateway-token": "<GATEWAY_TOKEN>" } } } }
```

## License

[MIT](LICENSE)
