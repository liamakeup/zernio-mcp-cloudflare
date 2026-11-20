#!/usr/bin/env bash
# Connect Claude Code to the Zernio MCP gateway.
# Usage: GATEWAY_TOKEN=... ./clients/claude-code-command.sh
set -euo pipefail
: "${GATEWAY_TOKEN:?set GATEWAY_TOKEN first}"

claude mcp remove zernio >/dev/null 2>&1 || true
claude mcp add --transport http zernio https://api.zerniomcp.workers.dev/mcp \
  -H "x-gateway-token: ${GATEWAY_TOKEN}"
