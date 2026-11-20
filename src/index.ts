/**
 * liamakeup-mcp-portal (zernio-mcp-cloudflare v2.0)
 *
 * Multi-Server MCP Portal + Multi-Tool Batch Executor running as a stateless
 * Cloudflare Worker on the Free plan (no Durable Objects, no paid bindings).
 *
 * Capabilities:
 * 1. Multi-Server MCP Aggregation:
 *    - Primary server `zernio` (https://mcp.zernio.com/mcp) keeps unprefixed tool
 *      names for 100% backward compatibility (and also accepts `zernio__<tool>`).
 *    - Additional upstream MCP servers configured via `UPSTREAM_SERVERS` JSON are
 *      namespaced as `<serverId>__<toolName>` in `tools/list` and routed automatically.
 * 2. Multi-Tool Batch & Sequential Chain Execution (`portal_batch_call`):
 *    - Execute up to 10 MCP tool calls in a single step across one or multiple servers.
 *    - Supports `parallel` (concurrent via Promise.allSettled) and `sequential`
 *      (ordered with `{{$steps.0.field}}` output interpolation and `stopOnError`).
 * 3. Compact Mode (`?mode=compact` or header `x-portal-mode: compact`):
 *    - Returns only discovery & batch execution meta-tools (`zernio_overview`,
 *      `search_tools`, `call_tool`, `portal_list_servers`, `portal_batch_call`)
 *      to reduce initial tool-schema token usage by ~90%.
 * 4. Fail-Closed Gateway Authentication:
 *    - Requires `GATEWAY_TOKEN` via `x-gateway-token` or `Authorization: Bearer <token>`.
 *    - Never forwards `GATEWAY_TOKEN` to upstream servers.
 */

export interface Env {
  /** Zernio API key spent on behalf of callers that pass the gateway token. */
  ZERNIO_API_KEY?: string;
  /** Shared secret that callers must present before the Worker key is used. */
  GATEWAY_TOKEN?: string;
  /** Primary upstream Zernio MCP endpoint. */
  UPSTREAM_MCP_URL?: string;
  /**
   * Optional JSON array of additional upstream MCP servers:
   * `[{"id":"crm","name":"CRM MCP","url":"https://...","token":"...","headers":{}}]`
   */
  UPSTREAM_SERVERS?: string;
}

export interface UpstreamServerConfig {
  id: string;
  name: string;
  url: string;
  token?: string;
  headers?: Record<string, string>;
  unprefixed: boolean;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BatchCallItem {
  id?: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

const DEFAULT_UPSTREAM = "https://mcp.zernio.com/mcp";
const MCP_PATH = "/mcp";
const UPSTREAM_TIMEOUT_MS = 60_000;
const SERVER_NAME = "liamakeup-mcp-portal";
const SERVER_VERSION = "2.0.0";
export const MAX_BATCH_CALLS = 10;
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const COMPACT_TOOL_NAMES = new Set([
  "zernio_overview",
  "search_tools",
  "call_tool",
  "portal_list_servers",
  "portal_batch_call",
]);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, x-api-key, x-gateway-token, x-portal-mode, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

/** Request headers the MCP transport defines and the upstream may rely on. */
const FORWARDED_REQUEST_HEADERS = ["Mcp-Protocol-Version", "Mcp-Method", "Mcp-Name", "Mcp-Session-Id"];
/** Upstream response headers worth returning to the client. */
const FORWARDED_RESPONSE_HEADERS = ["Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version"];

type JsonRpcId = string | number | null;
type AuthResult = { ok: true; zernioKey: string } | { ok: false; message: string };

export const PORTAL_META_TOOLS: McpToolDefinition[] = [
  {
    name: "portal_list_servers",
    description:
      "List all MCP servers connected to this Cloudflare MCP Portal, including their server ID, display name, tool prefix, and default routing status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "portal_batch_call",
    description:
      "Execute multiple MCP tool calls in a single step (Code Mode / Batch Execution) across any connected MCP server in this portal. Supports 'parallel' mode (concurrent execution) and 'sequential' mode (ordered execution with step output interpolation via {{$steps.0.field}}). Max 10 calls per batch.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["parallel", "sequential"],
          default: "parallel",
          description:
            "Execution mode: 'parallel' runs all calls concurrently; 'sequential' runs calls in order and allows referencing previous step JSON outputs via {{$steps.0.path}}.",
        },
        stopOnError: {
          type: "boolean",
          default: false,
          description: "In 'sequential' mode, stop executing remaining calls if a call fails.",
        },
        calls: {
          type: "array",
          description: "List of tool calls to execute (1 to 10 calls).",
          minItems: 1,
          maxItems: MAX_BATCH_CALLS,
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Optional label for this step.",
              },
              tool: {
                type: "string",
                description: "Tool name to invoke (e.g. 'accounts_list' or '<serverId>__<toolName>').",
              },
              arguments: {
                type: "object",
                description: "Arguments object for the tool.",
              },
            },
            required: ["tool"],
            additionalProperties: false,
          },
        },
      },
      required: ["calls"],
      additionalProperties: false,
    },
  },
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      const servers = parseUpstreamServers(env, env.ZERNIO_API_KEY || "");
      return json({
        status: "healthy",
        server: SERVER_NAME,
        version: SERVER_VERSION,
        transport: "Streamable HTTP (JSON-RPC 2.0)",
        requiresGatewayToken: Boolean(env.GATEWAY_TOKEN),
        hasServerKey: Boolean(env.ZERNIO_API_KEY),
        endpoint: `${url.origin}${MCP_PATH}`,
        compactEndpoint: `${url.origin}${MCP_PATH}?mode=compact`,
        features: {
          multiServer: true,
          batchExecution: true,
          compactMode: true,
          maxBatchCalls: MAX_BATCH_CALLS,
        },
        servers: servers.map((s) => ({
          id: s.id,
          name: s.name,
          prefix: s.unprefixed ? null : `${s.id}__`,
          default: s.unprefixed,
        })),
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

    const servers = parseUpstreamServers(env, auth.zernioKey);
    const primaryServer = servers[0];

    // Notifications and responses carry no id; the transport answers 202 at once.
    if (!("id" in payload) || payload.id === undefined) {
      ctx.waitUntil(
        forwardToServer(payload, request, primaryServer)
          .then((res) => res.body?.cancel())
          .catch(() => undefined)
      );
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }

    const id = (payload.id as JsonRpcId | undefined) ?? null;
    const method = typeof payload.method === "string" ? payload.method : "";
    const compactMode = isCompactMode(url, request);

    if (method === "tools/list") {
      return handleToolsList(payload, id, request, servers, compactMode);
    }

    if (method === "tools/call") {
      return handleToolsCall(payload, id, request, servers);
    }

    return forwardToServer(payload, request, primaryServer);
  },
};

function isCompactMode(url: URL, request: Request): boolean {
  const queryMode = (url.searchParams.get("mode") || url.searchParams.get("codemode") || "").trim().toLowerCase();
  const headerMode = (request.headers.get("x-portal-mode") || "").trim().toLowerCase();
  const mode = queryMode || headerMode;
  return mode === "compact" || mode === "search_and_execute" || mode === "code";
}

/** Parse primary Zernio server + any additional servers from UPSTREAM_SERVERS JSON. */
export function parseUpstreamServers(env: Env, zernioKey: string): UpstreamServerConfig[] {
  const servers: UpstreamServerConfig[] = [
    {
      id: "zernio",
      name: "Zernio Social Media MCP",
      url: env.UPSTREAM_MCP_URL || DEFAULT_UPSTREAM,
      token: zernioKey,
      unprefixed: true,
    },
  ];

  const raw = env.UPSTREAM_SERVERS?.trim();
  if (!raw) return servers;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return servers;
    const seen = new Set<string>(["zernio", "portal"]);

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (entry.enabled === false) continue;

      const id = typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
      const url = typeof entry.url === "string" ? entry.url.trim() : "";
      if (!id || !SERVER_ID_PATTERN.test(id) || seen.has(id)) continue;
      if (!isValidHttpUrl(url)) continue;

      seen.add(id);
      const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id;
      const token = typeof entry.token === "string" && entry.token.trim() ? entry.token.trim() : undefined;
      const headers: Record<string, string> = {};
      if (entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)) {
        for (const [k, v] of Object.entries(entry.headers as Record<string, unknown>)) {
          if (typeof v === "string" && k.trim()) headers[k.trim()] = v;
        }
      }

      servers.push({
        id,
        name,
        url,
        token,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        unprefixed: false,
      });
    }
  } catch {
    // Ignore malformed UPSTREAM_SERVERS JSON so primary Zernio server stays available.
  }

  return servers;
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Handle `tools/list` across all registered servers and inject portal meta-tools. */
async function handleToolsList(
  rpc: Record<string, unknown>,
  id: JsonRpcId,
  request: Request,
  servers: UpstreamServerConfig[],
  compactMode: boolean
): Promise<Response> {
  const results = await Promise.allSettled(
    servers.map((server) => fetchServerJsonRpc(server, rpc, request))
  );

  // If the primary server failed, return its error so auth/upstream errors surface accurately.
  const primaryResult = results[0];
  if (primaryResult.status === "rejected") {
    return rpcError(id, -32000, primaryResult.reason instanceof Error ? primaryResult.reason.message : "Upstream unreachable", 502);
  }
  if (!primaryResult.value.ok) {
    return primaryResult.value.errorResponse;
  }

  const primaryMsg = primaryResult.value.message;
  if (primaryMsg.error) {
    return json({ jsonrpc: "2.0", id, error: primaryMsg.error }, 200);
  }

  const primaryResultObj = (primaryMsg.result as Record<string, unknown> | undefined) ?? {};
  const aggregatedTools: McpToolDefinition[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    const settled = results[i];
    if (settled.status !== "fulfilled" || !settled.value.ok) continue;
    const msg = settled.value.message;
    const resultObj = (msg.result as { tools?: unknown[] } | undefined) ?? {};
    if (!Array.isArray(resultObj.tools)) continue;

    for (const rawTool of resultObj.tools) {
      if (!rawTool || typeof rawTool !== "object") continue;
      const tool = rawTool as McpToolDefinition;
      if (typeof tool.name !== "string" || !tool.name.trim()) continue;

      const exposedName = server.unprefixed ? tool.name : `${server.id}__${tool.name}`;
      if (seenNames.has(exposedName)) continue;
      seenNames.add(exposedName);

      aggregatedTools.push({
        ...tool,
        name: exposedName,
        description: server.unprefixed
          ? tool.description
          : `[${server.name}] ${tool.description || ""}`.trim(),
      });
    }
  }

  for (const metaTool of PORTAL_META_TOOLS) {
    if (!seenNames.has(metaTool.name)) {
      seenNames.add(metaTool.name);
      aggregatedTools.push(metaTool);
    }
  }

  const finalTools = compactMode
    ? aggregatedTools.filter((t) => COMPACT_TOOL_NAMES.has(t.name))
    : aggregatedTools;

  const responsePayload: Record<string, unknown> = {
    jsonrpc: "2.0",
    id,
    result: {
      ...primaryResultObj,
      tools: finalTools,
    },
  };

  return jsonWithUpstreamHeaders(responsePayload, primaryResult.value.headers);
}

/** Route `tools/call` to portal meta-tools, or to the matching upstream server. */
async function handleToolsCall(
  rpc: Record<string, unknown>,
  id: JsonRpcId,
  request: Request,
  servers: UpstreamServerConfig[]
): Promise<Response> {
  const params = (rpc.params as Record<string, unknown> | undefined) ?? {};
  const rawName = typeof params.name === "string" ? params.name.trim() : "";
  const rawArgs =
    params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};

  if (!rawName) {
    return rpcError(id, -32602, "Invalid params: missing tool name", 400);
  }

  if (rawName === "portal_list_servers") {
    return json({
      jsonrpc: "2.0",
      id,
      result: buildToolResult({
        portal: SERVER_NAME,
        version: SERVER_VERSION,
        serverCount: servers.length,
        servers: servers.map((s) => ({
          id: s.id,
          name: s.name,
          prefix: s.unprefixed ? null : `${s.id}__`,
          default: s.unprefixed,
        })),
      }),
    });
  }

  if (rawName === "portal_batch_call") {
    return handleBatchCall(id, rawArgs, request, servers);
  }

  // If the client used Zernio's lazy `call_tool` to invoke a portal meta-tool or a secondary server tool:
  if (rawName === "call_tool" && typeof rawArgs.name === "string") {
    const innerName = rawArgs.name.trim();
    const innerArgs =
      rawArgs.arguments && typeof rawArgs.arguments === "object" && !Array.isArray(rawArgs.arguments)
        ? (rawArgs.arguments as Record<string, unknown>)
        : {};

    if (innerName === "portal_list_servers" || innerName === "portal_batch_call") {
      return handleToolsCall(
        { ...rpc, params: { name: innerName, arguments: innerArgs } },
        id,
        request,
        servers
      );
    }

    const resolvedInner = resolveToolTarget(innerName, servers);
    if (!resolvedInner.server.unprefixed) {
      return forwardToServer(
        {
          ...rpc,
          params: {
            ...params,
            name: resolvedInner.upstreamToolName,
            arguments: innerArgs,
          },
        },
        request,
        resolvedInner.server
      );
    }
  }

  const { server, upstreamToolName } = resolveToolTarget(rawName, servers);
  const forwardedRpc: Record<string, unknown> = {
    ...rpc,
    params: {
      ...params,
      name: upstreamToolName,
      arguments: rawArgs,
    },
  };

  return forwardToServer(forwardedRpc, request, server);
}

/** Resolve `<serverId>__<toolName>` or unprefixed tool name to the target server and upstream tool name. */
export function resolveToolTarget(
  toolName: string,
  servers: UpstreamServerConfig[]
): { server: UpstreamServerConfig; upstreamToolName: string } {
  const sepIndex = toolName.indexOf("__");
  if (sepIndex > 0) {
    const prefix = toolName.slice(0, sepIndex).toLowerCase();
    const rest = toolName.slice(sepIndex + 2);
    if (rest) {
      const matched = servers.find((s) => s.id === prefix);
      if (matched) {
        return { server: matched, upstreamToolName: rest };
      }
    }
  }
  return { server: servers[0], upstreamToolName: toolName };
}

/** Execute `portal_batch_call` in either `parallel` or `sequential` mode. */
async function handleBatchCall(
  id: JsonRpcId,
  args: Record<string, unknown>,
  request: Request,
  servers: UpstreamServerConfig[]
): Promise<Response> {
  const mode = args.mode === "sequential" ? "sequential" : "parallel";
  const stopOnError = Boolean(args.stopOnError);
  const rawCalls = args.calls;

  if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
    return rpcError(id, -32602, "Invalid params: 'calls' must be a non-empty array", 400);
  }

  if (rawCalls.length > MAX_BATCH_CALLS) {
    return rpcError(
      id,
      -32602,
      `Invalid params: 'calls' exceeds maximum batch size of ${MAX_BATCH_CALLS} (received ${rawCalls.length})`,
      400
    );
  }

  const calls: BatchCallItem[] = [];
  for (let i = 0; i < rawCalls.length; i++) {
    const item = rawCalls[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return rpcError(id, -32602, `Invalid params: calls[${i}] must be an object`, 400);
    }
    const entry = item as Record<string, unknown>;
    const tool = typeof entry.tool === "string" ? entry.tool.trim() : "";
    if (!tool) {
      return rpcError(id, -32602, `Invalid params: calls[${i}].tool must be a non-empty string`, 400);
    }
    if (tool === "portal_batch_call") {
      return rpcError(id, -32602, `Invalid params: calls[${i}] cannot recursively invoke 'portal_batch_call'`, 400);
    }
    const stepId = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `step_${i}`;
    const stepArgs =
      entry.arguments && typeof entry.arguments === "object" && !Array.isArray(entry.arguments)
        ? (entry.arguments as Record<string, unknown>)
        : {};
    calls.push({ id: stepId, tool, arguments: stepArgs });
  }

  const startedAt = Date.now();
  interface StepExecutionResult {
    index: number;
    id: string;
    tool: string;
    server: string;
    ok: boolean;
    durationMs: number;
    output?: unknown;
    error?: string;
  }

  const executeOne = async (call: BatchCallItem, index: number, resolvedArgs: Record<string, unknown>): Promise<StepExecutionResult> => {
    const stepStart = Date.now();

    if (call.tool === "portal_list_servers") {
      return {
        index,
        id: call.id || `step_${index}`,
        tool: call.tool,
        server: "portal",
        ok: true,
        durationMs: Date.now() - stepStart,
        output: {
          portal: SERVER_NAME,
          servers: servers.map((s) => ({ id: s.id, name: s.name, prefix: s.unprefixed ? null : `${s.id}__` })),
        },
      };
    }

    const { server, upstreamToolName } = resolveToolTarget(call.tool, servers);
    const rpcReq: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: `batch_${index + 1}`,
      method: "tools/call",
      params: {
        name: upstreamToolName,
        arguments: resolvedArgs,
      },
    };

    try {
      const res = await fetchServerJsonRpc(server, rpcReq, request);
      if (!res.ok) {
        return {
          index,
          id: call.id || `step_${index}`,
          tool: call.tool,
          server: server.id,
          ok: false,
          durationMs: Date.now() - stepStart,
          error: res.errorMessage,
        };
      }

      const msg = res.message;
      if (msg.error && typeof msg.error === "object") {
        const errObj = msg.error as { message?: unknown };
        return {
          index,
          id: call.id || `step_${index}`,
          tool: call.tool,
          server: server.id,
          ok: false,
          durationMs: Date.now() - stepStart,
          error: typeof errObj.message === "string" ? errObj.message : "Upstream tool call error",
        };
      }

      const toolResult = (msg.result as Record<string, unknown> | undefined) ?? {};
      const isError = Boolean(toolResult.isError);
      const extracted = extractToolOutput(toolResult);

      return {
        index,
        id: call.id || `step_${index}`,
        tool: call.tool,
        server: server.id,
        ok: !isError,
        durationMs: Date.now() - stepStart,
        output: extracted,
        ...(isError ? { error: typeof extracted === "string" ? extracted : JSON.stringify(extracted) } : {}),
      };
    } catch (err) {
      return {
        index,
        id: call.id || `step_${index}`,
        tool: call.tool,
        server: server.id,
        ok: false,
        durationMs: Date.now() - stepStart,
        error: err instanceof Error ? err.message : "Unexpected batch execution error",
      };
    }
  };

  const results: StepExecutionResult[] = [];

  if (mode === "parallel") {
    const settled = await Promise.all(
      calls.map((call, idx) => executeOne(call, idx, call.arguments ?? {}))
    );
    results.push(...settled);
  } else {
    const stepOutputs: unknown[] = [];
    for (let idx = 0; idx < calls.length; idx++) {
      const call = calls[idx];
      const interpolatedArgs = interpolateStepReferences(call.arguments ?? {}, stepOutputs) as Record<string, unknown>;
      const stepRes = await executeOne(call, idx, interpolatedArgs);
      results.push(stepRes);
      stepOutputs.push(stepRes.output);
      if (!stepRes.ok && stopOnError) {
        break;
      }
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  return json({
    jsonrpc: "2.0",
    id,
    result: buildToolResult(
      {
        mode,
        totalRequested: calls.length,
        executed: results.length,
        succeeded,
        failed,
        totalDurationMs: Date.now() - startedAt,
        results,
      },
      failed > 0 && succeeded === 0
    ),
  });
}

/**
 * Replace `{{$steps.<index>.<path>}}` placeholders in sequential batch arguments
 * using outputs from previous steps.
 */
export function interpolateStepReferences(value: unknown, stepOutputs: readonly unknown[]): unknown {
  if (typeof value === "string") {
    const exactMatch = value.match(/^\{\{\$steps\.(\d+)(?:\.([a-zA-Z0-9_.-]+))?\}\}$/);
    if (exactMatch) {
      const stepIdx = Number(exactMatch[1]);
      const path = exactMatch[2] || "";
      const resolved = resolvePath(stepOutputs[stepIdx], path);
      return resolved !== undefined ? resolved : value;
    }

    return value.replace(/\{\{\$steps\.(\d+)(?:\.([a-zA-Z0-9_.-]+))?\}\}/g, (full, idxStr, pathStr) => {
      const stepIdx = Number(idxStr);
      const resolved = resolvePath(stepOutputs[stepIdx], pathStr || "");
      if (resolved === undefined || resolved === null) return full;
      return typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateStepReferences(item, stepOutputs));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateStepReferences(v, stepOutputs);
    }
    return out;
  }

  return value;
}

function resolvePath(root: unknown, path: string): unknown {
  if (!path) return root;
  const parts = path.split(".");
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Extract parsed JSON or text from an MCP tool result (`content` / `structuredContent`). */
function extractToolOutput(toolResult: Record<string, unknown>): unknown {
  if (toolResult.structuredContent !== undefined) {
    return toolResult.structuredContent;
  }

  const content = toolResult.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string")
      .map((c) => (c as { text: string }).text);
    const joined = texts.join("\n").trim();
    if (joined) {
      try {
        const parsed = JSON.parse(joined);
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          typeof (parsed as { result?: unknown }).result === "string"
        ) {
          try {
            return JSON.parse((parsed as { result: string }).result);
          } catch {
            return parsed;
          }
        }
        return parsed;
      } catch {
        return joined;
      }
    }
  }

  return toolResult;
}

function buildToolResult(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

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

function buildUpstreamHeaders(server: UpstreamServerConfig, request: Request): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  });
  if (server.token) {
    headers.set("Authorization", `Bearer ${server.token}`);
  }
  if (server.headers) {
    for (const [k, v] of Object.entries(server.headers)) {
      headers.set(k, v);
    }
  }
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/** Forward a single JSON-RPC request to a specific upstream server and stream the response back. */
async function forwardToServer(
  rpc: Record<string, unknown>,
  request: Request,
  server: UpstreamServerConfig
): Promise<Response> {
  const id = (rpc.id as JsonRpcId | undefined) ?? null;
  const headers = buildUpstreamHeaders(server, request);

  // The timeout bounds the wait for response headers only; once upstream starts
  // answering, the timer is cleared so long SSE tool-call streams are not cut.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify(rpc),
      signal: controller.signal,
    });
  } catch {
    return controller.signal.aborted
      ? rpcError(id, -32000, `Upstream MCP (${server.id}) timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s`, 504)
      : rpcError(id, -32000, `Upstream MCP (${server.id}) is unreachable`, 502);
  } finally {
    clearTimeout(timer);
  }

  // Do not relay the upstream OAuth challenge: it names mcp.zernio.com, which
  // clients reject as a resource mismatch for this gateway.
  if (upstream.status === 401 || upstream.status === 403) {
    await upstream.body?.cancel();
    return rpcError(id, -32001, `Upstream MCP (${server.id}) rejected the API key`, upstream.status);
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

type ParsedUpstreamResult =
  | { ok: true; message: Record<string, unknown>; headers: Headers }
  | { ok: false; errorMessage: string; errorResponse: Response };

/**
 * Send a JSON-RPC request to an upstream MCP server and decode its response
 * whether the server replies with `application/json` or `text/event-stream` (SSE).
 */
async function fetchServerJsonRpc(
  server: UpstreamServerConfig,
  rpc: Record<string, unknown>,
  request: Request
): Promise<ParsedUpstreamResult> {
  const id = (rpc.id as JsonRpcId | undefined) ?? null;
  const headers = buildUpstreamHeaders(server, request);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify(rpc),
      signal: controller.signal,
    });
  } catch {
    const msg = controller.signal.aborted
      ? `Upstream MCP (${server.id}) timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s`
      : `Upstream MCP (${server.id}) is unreachable`;
    return {
      ok: false,
      errorMessage: msg,
      errorResponse: rpcError(id, -32000, msg, controller.signal.aborted ? 504 : 502),
    };
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status === 401 || upstream.status === 403) {
    await upstream.body?.cancel();
    const msg = `Upstream MCP (${server.id}) rejected the API key`;
    return {
      ok: false,
      errorMessage: msg,
      errorResponse: rpcError(id, -32001, msg, upstream.status),
    };
  }

  if (!upstream.ok) {
    const text = (await upstream.text().catch(() => "")).slice(0, 300);
    const msg = `Upstream MCP (${server.id}) returned HTTP ${upstream.status}${text ? `: ${text}` : ""}`;
    return {
      ok: false,
      errorMessage: msg,
      errorResponse: rpcError(id, -32000, msg, upstream.status >= 500 ? 502 : upstream.status),
    };
  }

  const contentType = upstream.headers.get("Content-Type") || "";
  const rawBody = await upstream.text();

  if (contentType.includes("text/event-stream")) {
    const parsedSse = extractJsonRpcFromSse(rawBody, id);
    if (!parsedSse) {
      const msg = `Upstream MCP (${server.id}) SSE stream ended without a valid JSON-RPC message`;
      return {
        ok: false,
        errorMessage: msg,
        errorResponse: rpcError(id, -32000, msg, 502),
      };
    }
    return { ok: true, message: parsedSse, headers: upstream.headers };
  }

  try {
    const parsedJson = JSON.parse(rawBody);
    if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
      return { ok: true, message: parsedJson as Record<string, unknown>, headers: upstream.headers };
    }
  } catch {
    // Fall through to error below
  }

  const msg = `Upstream MCP (${server.id}) returned invalid JSON`;
  return {
    ok: false,
    errorMessage: msg,
    errorResponse: rpcError(id, -32000, msg, 502),
  };
}

/** Extract the matching JSON-RPC message from an SSE body (`data: {...}`). */
export function extractJsonRpcFromSse(rawSse: string, expectedId: JsonRpcId): Record<string, unknown> | null {
  const events = rawSse.split(/\r?\n\r?\n/);
  let lastValid: Record<string, unknown> | null = null;

  for (const event of events) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (!payload) continue;

    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        lastValid = obj;
        if (expectedId === null || obj.id === expectedId || String(obj.id) === String(expectedId)) {
          return obj;
        }
      }
    } catch {
      continue;
    }
  }

  return lastValid;
}

function parseBearer(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() || null : null;
}

/** Constant-time comparison; hashing first makes both inputs the same 32-byte length. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(ha, hb);
  }
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = va.length ^ vb.length;
  for (let i = 0; i < va.length; i++) {
    diff |= va[i] ^ (vb[i] ?? 0);
  }
  return diff === 0;
}

function isJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).jsonrpc === "2.0";
}

function rpcError(id: JsonRpcId, code: number, message: string, status: number): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function jsonWithUpstreamHeaders(body: unknown, upstreamHeaders: Headers, status = 200): Response {
  const out = new Headers(CORS_HEADERS);
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    if (name.toLowerCase() === "content-type") continue;
    const value = upstreamHeaders.get(name);
    if (value) out.set(name, value);
  }
  out.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: out });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}
