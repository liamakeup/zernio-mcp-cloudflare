#!/usr/bin/env bash
# Connect Claude Code to your Cloudflare Zernio MCP Server

WORKER_URL="https://api.zerniomcp.workers.dev/mcp"

claude mcp add --transport http zernio "$WORKER_URL"
