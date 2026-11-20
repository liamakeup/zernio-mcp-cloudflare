#!/usr/bin/env bash
# Connect Claude Code to your Cloudflare Zernio MCP Server

# Replace with your deployed Worker URL
WORKER_URL="https://zernio-mcp-cloudflare.<your-subdomain>.workers.dev/mcp"

claude mcp add --transport http zernio "$WORKER_URL"
