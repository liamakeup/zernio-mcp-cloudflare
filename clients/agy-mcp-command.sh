#!/usr/bin/env bash
# Connect Antigravity (agy) to your Cloudflare Zernio MCP Server

WORKER_URL="https://api.zernio-mcp.workers.dev/mcp"

# If public or server-configured ZERNIO_API_KEY:
agy mcp add zernio "$WORKER_URL"

# If client passes x-api-key:
# agy mcp add --header "x-api-key: YOUR_ZERNIO_API_KEY" zernio "$WORKER_URL"

# If GATEWAY_TOKEN is enabled:
# agy mcp add --header "Authorization: Bearer YOUR_GATEWAY_TOKEN" zernio "$WORKER_URL"

# Verify connection:
agy mcp list
