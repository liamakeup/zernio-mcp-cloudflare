#!/usr/bin/env bash
# Connect Antigravity (agy) to the Zernio MCP gateway.
# Usage: GATEWAY_TOKEN=... ./clients/agy-mcp-command.sh
set -euo pipefail
: "${GATEWAY_TOKEN:?set GATEWAY_TOKEN first}"

agy mcp remove zernio >/dev/null 2>&1 || true
agy mcp add --header "x-gateway-token: ${GATEWAY_TOKEN}" zernio https://api.zerniomcp.workers.dev/mcp
agy mcp list
