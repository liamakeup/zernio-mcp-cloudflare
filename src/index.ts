/**
 * zernio-mcp-cloudflare
 *
 * Streamable HTTP proxy in front of the Zernio MCP server, running as a
 * stateless Cloudflare Worker (Free plan: no Durable Objects, no paid bindings).
 *
 * Auth model (fail closed):
 * - The Worker's own ZERNIO_API_KEY is used only after the caller proves the
 *   GATEWAY_TOKEN (header `x-gateway-token`, or `Authorization: Bearer <token>`).
 * - A caller may instead bring its own Zernio key (`x-api-key`, or a Bearer
 *   value that is not the gateway token). When GATEWAY_TOKEN is set, the
 *   gateway token is still required.
 * - Without GATEWAY_TOKEN the Worker never spends its own key.
 */

export interface Env {
  /** Zernio API key spent on behalf of callers that pass the gateway token. */
  ZERNIO_API_KEY?: string;
  /** Shared secret that callers must present before the Worker key is used. */
  GATEWAY_TOKEN?: string;
  /** Upstream Zernio MCP endpoint. */
  UPSTREAM_MCP_URL?: string;
}

const DEFAULT_UPSTREAM = "https://mcp.zernio.com/mcp";
const MCP_PATH = "/mcp";
const UPSTREAM_TIMEOUT_MS = 60_000;
const SERVER_NAME = "zernio-mcp-cloudflare";
const SERVER_VERSION = "1.1.0";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, x-api-key, x-gateway-token, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

/** Request headers the MCP transport defines and the upstream may rely on. */
const FORWARDED_REQUEST_HEADERS = ["Mcp-Protocol-Version", "Mcp-Method", "Mcp-Name", "Mcp-Session-Id"];
/** Upstream response headers worth returning to the client. */
const FORWARDED_RESPONSE_HEADERS = ["Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version"];

type JsonRpcId = string | number | null;
type AuthResult = { ok: true; zernioKey: string } | { ok: false; message: string };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        status: "healthy",
        server: SERVER_NAME,
        version: SERVER_VERSION,
        transport: "Streamable HTTP (JSON-RPC 2.0)",
        requiresGatewayToken: Boolean(env.GATEWAY_TOKEN),
        hasServerKey: Boolean(env.ZERNIO_API_KEY),
        endpoint: `${url.origin}${MCP_PATH}`,
      });
    }

    if (url.pathname !== MCP_PATH) {
      return json({ error: `Not found. Send MCP requests to POST ${MCP_PATH}` }, 404);
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" },
      });
    }

    const auth = await authorize(request, env);
    if (!auth.ok) {
      return rpcError(null, -32001, auth.message, 401);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return rpcError(null, -32700, "Parse error: request body is not valid JSON", 400);
    }

    // JSON-RPC batching was removed from MCP in the 2025-06-18 revision.
    if (Array.isArray(payload)) {
      return rpcError(null, -32600, "Invalid Request: batch requests are not supported", 400);
    }

    if (!isJsonRpcMessage(payload)) {
      return rpcError(null, -32600, "Invalid Request: expected a JSON-RPC 2.0 object", 400);
    }

    // Notifications and responses carry no id; the transport answers 202 at once.
    if (!("id" in payload) || payload.id === undefined) {
      ctx.waitUntil(
        forwardToUpstream(payload, request, auth.zernioKey, env)
          .then((res) => res.body?.cancel())
          .catch(() => undefined)
      );
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }

    return forwardToUpstream(payload, request, auth.zernioKey, env);
  },
};

/** Decide which Zernio key a request may use, failing closed. */
async function authorize(request: Request, env: Env): Promise<AuthResult> {
  const gatewayHeader = request.headers.get("x-gateway-token")?.trim() || null;
  const bearer = parseBearer(request.headers.get("Authorization"));
  const clientKey = request.headers.get("x-api-key")?.trim() || null;

  let gatewayOk = false;
  if (env.GATEWAY_TOKEN) {
    const candidate = gatewayHeader ?? bearer;
    gatewayOk = candidate !== null && (await safeEqual(candidate, env.GATEWAY_TOKEN));
    if (!gatewayOk) {
      return { ok: false, message: "Unauthorized: missing or invalid gateway token" };
    }
  }

  // The gateway token is never forwarded as a Zernio key, whichever header carried it.
  let ownKey: string | null = clientKey ?? bearer;
  if (ownKey && env.GATEWAY_TOKEN && (await safeEqual(ownKey, env.GATEWAY_TOKEN))) ownKey = null;
  if (ownKey) {
    return { ok: true, zernioKey: ownKey };
  }

  if (gatewayOk && env.ZERNIO_API_KEY) {
    return { ok: true, zernioKey: env.ZERNIO_API_KEY };
  }

  return {
    ok: false,
    message: gatewayOk
      ? "Unauthorized: gateway has no Zernio API key; send one via x-api-key"
      : "Unauthorized: send a Zernio API key via x-api-key or Authorization: Bearer",
  };
}

async function forwardToUpstream(
  rpc: Record<string, unknown>,
  request: Request,
  zernioKey: string,
  env: Env
): Promise<Response> {
  const id = (rpc.id as JsonRpcId | undefined) ?? null;
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${zernioKey}`,
  });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // The timeout bounds the wait for response headers only; once upstream starts
  // answering, the timer is cleared so long SSE tool-call streams are not cut.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(env.UPSTREAM_MCP_URL || DEFAULT_UPSTREAM, {
      method: "POST",
      headers,
      body: JSON.stringify(rpc),
      signal: controller.signal,
    });
  } catch {
    return controller.signal.aborted
      ? rpcError(id, -32000, `Upstream Zernio MCP timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s`, 504)
      : rpcError(id, -32000, "Upstream Zernio MCP is unreachable", 502);
  } finally {
    clearTimeout(timer);
  }

  // Do not relay the upstream OAuth challenge: it names mcp.zernio.com, which
  // clients reject as a resource mismatch for this gateway.
  if (upstream.status === 401 || upstream.status === 403) {
    await upstream.body?.cancel();
    return rpcError(id, -32001, "Zernio rejected the API key", upstream.status);
  }

  const out = new Headers(CORS_HEADERS);
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  if ((upstream.headers.get("Content-Type") || "").includes("text/event-stream")) {
    out.set("Cache-Control", "no-cache");
    out.set("X-Accel-Buffering", "no");
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

function parseBearer(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() || null : null;
}

/** Constant-time comparison; hashing first makes both inputs the same length. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function isJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).jsonrpc === "2.0";
}

function rpcError(id: JsonRpcId, code: number, message: string, status: number): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}
