/**
 * zernio-mcp-cloudflare
 *
 * Model Context Protocol (MCP) Server & Gateway for Zernio Social Media API.
 * Reference: https://github.com/mrgoonie/zernio-mcp & https://zernio.com/agents
 *
 * - Modern MCP Standard: Streamable HTTP (spec 2024-11-05 / 2026 baseline), JSON-RPC 2.0.
 * - 100% Cloudflare Workers Free Tier Compatible:
 *   - Pure stateless Worker (fetch handler)
 *   - Zero Durable Objects (no paid add-on required)
 *   - Fast execution (<5ms CPU time)
 *   - Subdomain ready (*.workers.dev)
 */

export interface Env {
  /**
   * Upstream Zernio API Key.
   * If set on the Worker, client agents do not need to provide their own key.
   */
  ZERNIO_API_KEY?: string;

  /**
   * Optional secret token to protect your Cloudflare Worker endpoint.
   * If set, clients must pass `Authorization: Bearer <GATEWAY_TOKEN>` or `x-gateway-token: <GATEWAY_TOKEN>`.
   */
  GATEWAY_TOKEN?: string;

  /**
   * Upstream Zernio MCP Server URL.
   * Defaults to https://mcp.zernio.com/mcp
   */
  UPSTREAM_MCP_URL?: string;
}

const DEFAULT_UPSTREAM = "https://mcp.zernio.com/mcp";
const SERVER_NAME = "zernio-mcp-cloudflare";
const SERVER_VERSION = "1.0.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2026-07-28"];

/**
 * Common CORS headers for web, desktop & CLI agent clients.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, x-api-key, x-gateway-token, Authorization, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, mcp-session-id, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // 2. Health check & info (GET / or GET /health)
    if (request.method === "GET") {
      if (url.pathname === "/" || url.pathname === "/health") {
        return jsonResponse({
          status: "healthy",
          server: SERVER_NAME,
          version: SERVER_VERSION,
          mcpProtocol: "Streamable HTTP (JSON-RPC 2.0)",
          supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
          cloudflareTier: "100% Free Tier (Stateless Worker)",
          hasServerKey: Boolean(env.ZERNIO_API_KEY),
          requiresGatewayToken: Boolean(env.GATEWAY_TOKEN),
          upstream: env.UPSTREAM_MCP_URL || DEFAULT_UPSTREAM,
          endpoints: {
            mcp: `${url.origin}/mcp`,
            root: `${url.origin}/`,
          },
        });
      }
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }

    // 3. Only POST is accepted for MCP requests
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { ...CORS_HEADERS, Allow: "GET, POST, OPTIONS" },
      });
    }

    // 4. Validate Gateway Token if configured by owner
    if (env.GATEWAY_TOKEN) {
      const authHeader = request.headers.get("Authorization");
      const customGatewayHeader = request.headers.get("x-gateway-token");
      const queryToken = url.searchParams.get("token");

      let clientGatewayToken = customGatewayHeader || queryToken;
      if (!clientGatewayToken && authHeader?.startsWith("Bearer ")) {
        const tokenCandidate = authHeader.substring(7).trim();
        // If client passed a token that matches gateway token
        if (tokenCandidate === env.GATEWAY_TOKEN) {
          clientGatewayToken = tokenCandidate;
        }
      }

      if (clientGatewayToken !== env.GATEWAY_TOKEN) {
        return jsonResponse(
          {
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: "Unauthorized: Invalid or missing Gateway token",
            },
            id: null,
          },
          401
        );
      }
    }

    // 5. Resolve Zernio API Key
    // Priority:
    // a) Client header: `x-api-key`
    // b) Client header: `Authorization: Bearer <key>`
    // c) Worker environment secret: `env.ZERNIO_API_KEY`
    const clientXApiKey = request.headers.get("x-api-key");
    const clientAuth = request.headers.get("Authorization");
    const clientBearer = clientAuth?.startsWith("Bearer ")
      ? clientAuth.substring(7).trim()
      : null;

    const resolvedApiKey = clientXApiKey || clientBearer || env.ZERNIO_API_KEY;

    // 6. Parse JSON-RPC Payload
    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(
        {
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: "Parse error: Invalid JSON in request body",
          },
          id: null,
        },
        400
      );
    }

    // 7. Handle Batch or Single request
    if (Array.isArray(payload)) {
      const results = await Promise.all(
        payload.map((reqItem) => handleJsonRpcRequest(reqItem, request, resolvedApiKey, env))
      );
      return jsonResponse(results);
    }

    return await handleJsonRpcRequest(payload, request, resolvedApiKey, env);
  },
};

/**
 * Handle individual JSON-RPC 2.0 message
 */
async function handleJsonRpcRequest(
  rpc: any,
  rawRequest: Request,
  apiKey: string | undefined,
  env: Env
): Promise<Response> {
  const method = rpc?.method;
  const id = rpc?.id ?? null;

  // Notification (no id)
  if (method === "notifications/initialized") {
    if (apiKey) {
      forwardToUpstream(rpc, rawRequest, apiKey, env).catch(() => {});
    }
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Ping handler
  if (method === "ping") {
    return jsonResponse({
      jsonrpc: "2.0",
      id,
      result: {},
    });
  }

  // MCP Initialize Handshake
  if (method === "initialize") {
    const clientProtocol = rpc?.params?.protocolVersion || "2024-11-05";
    return jsonResponse({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: clientProtocol,
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: false, listChanged: true },
          prompts: { listChanged: true },
          logging: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
        instructions:
          "Zernio Social Media MCP Gateway on Cloudflare Workers. 100% Free Tier compatible. Connects AI agents to Zernio API across 18 social media platforms.",
      },
    });
  }

  // For operational methods, verify API key
  if (!apiKey) {
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32600,
          message:
            "Missing Zernio API key. Provide via x-api-key header, Authorization: Bearer <key>, or configure ZERNIO_API_KEY secret on Cloudflare Worker.",
        },
      },
      401
    );
  }

  // Forward request to Upstream Zernio MCP Server
  return await forwardToUpstream(rpc, rawRequest, apiKey, env);
}

/**
 * Forward JSON-RPC call to upstream Zernio MCP Server with streaming support
 */
async function forwardToUpstream(
  rpc: any,
  rawRequest: Request,
  apiKey: string,
  env: Env
): Promise<Response> {
  const upstreamUrl = env.UPSTREAM_MCP_URL || DEFAULT_UPSTREAM;
  const upstreamHeaders = new Headers();

  upstreamHeaders.set("Content-Type", "application/json");
  upstreamHeaders.set("Accept", "application/json, text/event-stream");
  upstreamHeaders.set("Authorization", `Bearer ${apiKey}`);

  // Forward metadata headers if provided by agent client
  const mcpVersion = rawRequest.headers.get("Mcp-Protocol-Version");
  if (mcpVersion) upstreamHeaders.set("Mcp-Protocol-Version", mcpVersion);

  const mcpMethod = rawRequest.headers.get("Mcp-Method");
  if (mcpMethod) upstreamHeaders.set("Mcp-Method", mcpMethod);

  const mcpName = rawRequest.headers.get("Mcp-Name");
  if (mcpName) upstreamHeaders.set("Mcp-Name", mcpName);

  const mcpSessionId = rawRequest.headers.get("mcp-session-id");
  if (mcpSessionId) upstreamHeaders.set("mcp-session-id", mcpSessionId);

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(rpc),
    });

    const contentType = upstreamRes.headers.get("Content-Type") || "";

    // If upstream returns SSE / streamable event stream, stream it directly to client
    if (contentType.includes("text/event-stream")) {
      const responseHeaders = new Headers(CORS_HEADERS);
      responseHeaders.set("Content-Type", "text/event-stream");
      responseHeaders.set("Cache-Control", "no-cache");
      responseHeaders.set("Connection", "keep-alive");

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    }

    // Standard JSON response
    const data = await upstreamRes.json();
    return jsonResponse(data, upstreamRes.status);
  } catch (error: any) {
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id: rpc?.id ?? null,
        error: {
          code: -32000,
          message: `Upstream Zernio MCP error: ${error?.message || "Connection failed"}`,
        },
      },
      502
    );
  }
}

/**
 * Helper to build JSON responses with CORS headers
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
