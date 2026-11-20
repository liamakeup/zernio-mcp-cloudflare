#!/usr/bin/env bash
# Connect Antigravity (agy) to your Cloudflare Zernio MCP Server

# Replace with your deployed Worker URL
WORKER_URL="https://zernio-mcp-cloudflare.<your-subdomain>.workers.dev/mcp"

# If GATEWAY_TOKEN is enabled:
# agy mcp add --header "Authorization: Bearer YOUR_GATEWAY_TOKEN" zernio "$WORKER_URL"

# If public/unauthenticated gateway:
agy mcp add zernio "$WORKER_URL"

# Verify connection:
agy mcp list
