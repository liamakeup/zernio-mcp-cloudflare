import { describe, expect, it } from "bun:test";
import worker, {
  extractJsonRpcFromSse,
  interpolateStepReferences,
  MAX_BATCH_CALLS,
  parseUpstreamServers,
  resolveToolTarget,
  type Env,
} from "../src/index";

const TEST_ENV: Env = {
  GATEWAY_TOKEN: "test-gateway-secret-token",
  ZERNIO_API_KEY: "test-zernio-api-key",
  UPSTREAM_MCP_URL: "https://mcp.zernio.test/mcp",
  UPSTREAM_SERVERS: JSON.stringify([
    {
      id: "crm",
      name: "Beauty CRM MCP",
      url: "https://crm.example.test/mcp",
      token: "crm-secret-token",
    },
  ]),
};

function createCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

describe("liamakeup-mcp-portal (Multi-Server MCP Portal + Batch Execution)", () => {
  it("returns portal health with multi-server metadata on GET /health", async () => {
    const req = new Request("https://api.liamakeup.workers.dev/health");
    const res = await worker.fetch(req, TEST_ENV, createCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("healthy");
    expect(body.server).toBe("liamakeup-mcp-portal");
    expect(body.version).toBe("2.0.0");
    expect(body.compactEndpoint).toBe("https://api.liamakeup.workers.dev/mcp?mode=compact");
    const servers = body.servers as Array<{ id: string; prefix: string | null; default: boolean }>;
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({ id: "zernio", prefix: null, default: true });
    expect(servers[1]).toMatchObject({ id: "crm", prefix: "crm__", default: false });
  });

  it("enforces fail-closed gateway authentication on POST /mcp", async () => {
    const req = new Request("https://api.liamakeup.workers.dev/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const res = await worker.fetch(req, TEST_ENV, createCtx());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32001);
  });

  it("aggregates tools across primary (unprefixed) and secondary (prefixed) servers + portal meta-tools", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://mcp.zernio.test/mcp") {
        const sse =
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"zernio_overview","description":"Overview"},{"name":"search_tools","description":"Search"},{"name":"call_tool","description":"Call"},{"name":"accounts_list","description":"List social accounts"}]}}\n\n';
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "sess-123" },
        });
      }
      if (url === "https://crm.example.test/mcp") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [{ name: "get_booking", description: "Get customer booking" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      const req = new Request("https://api.liamakeup.workers.dev/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gateway-token": TEST_ENV.GATEWAY_TOKEN!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

      const res = await worker.fetch(req, TEST_ENV, createCtx());
      expect(res.status).toBe(200);
      expect(res.headers.get("Mcp-Session-Id")).toBe("sess-123");
      const body = (await res.json()) as { result: { tools: Array<{ name: string; description: string }> } };
      const names = body.result.tools.map((t) => t.name);
      expect(names).toContain("accounts_list");
      expect(names).toContain("crm__get_booking");
      expect(names).toContain("portal_list_servers");
      expect(names).toContain("portal_batch_call");

      // Also verify ?mode=compact filters down to compact discovery + batch tools
      const compactReq = new Request("https://api.liamakeup.workers.dev/mcp?mode=compact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gateway-token": TEST_ENV.GATEWAY_TOKEN!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      const compactRes = await worker.fetch(compactReq, TEST_ENV, createCtx());
      const compactBody = (await compactRes.json()) as { result: { tools: Array<{ name: string }> } };
      const compactNames = compactBody.result.tools.map((t) => t.name);
      expect(compactNames).toEqual([
        "zernio_overview",
        "search_tools",
        "call_tool",
        "portal_list_servers",
        "portal_batch_call",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("executes portal_batch_call in both parallel and sequential modes with $steps interpolation", async () => {
    const originalFetch = globalThis.fetch;
    const seenHeaders: Record<string, string> = {};

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seenHeaders[url] = headers.get("Authorization") || "";
      const rpc = JSON.parse(String(init?.body)) as {
        id: unknown;
        params: { name: string; arguments: Record<string, unknown> };
      };

      if (url === "https://mcp.zernio.test/mcp" && rpc.params.name === "accounts_list") {
        return new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ accounts: [{ id: "acc_fb_99", platform: "facebook" }] }) }],
            },
          })}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }

      if (url === "https://crm.example.test/mcp" && rpc.params.name === "sync_account") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    syncedAccountId: rpc.params.arguments.accountId,
                    platform: rpc.params.arguments.platform,
                    status: "synced",
                  }),
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      const req = new Request("https://api.liamakeup.workers.dev/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gateway-token": TEST_ENV.GATEWAY_TOKEN!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "portal_batch_call",
            arguments: {
              mode: "sequential",
              stopOnError: true,
              calls: [
                {
                  id: "get_fb",
                  tool: "accounts_list",
                  arguments: { platform: "facebook" },
                },
                {
                  id: "sync_to_crm",
                  tool: "crm__sync_account",
                  arguments: {
                    accountId: "{{$steps.0.accounts.0.id}}",
                    platform: "{{$steps.0.accounts.0.platform}}",
                  },
                },
              ],
            },
          },
        }),
      });

      const res = await worker.fetch(req, TEST_ENV, createCtx());
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: {
          structuredContent: {
            mode: string;
            succeeded: number;
            failed: number;
            results: Array<{ id: string; server: string; ok: boolean; output: Record<string, unknown> }>;
          };
        };
      };

      const batch = body.result.structuredContent;
      expect(batch.mode).toBe("sequential");
      expect(batch.succeeded).toBe(2);
      expect(batch.failed).toBe(0);
      expect(batch.results[0].server).toBe("zernio");
      expect(batch.results[1].server).toBe("crm");
      expect(batch.results[1].output).toEqual({
        syncedAccountId: "acc_fb_99",
        platform: "facebook",
        status: "synced",
      });

      // Verify each upstream received its own secret token and NOT the gateway token
      expect(seenHeaders["https://mcp.zernio.test/mcp"]).toBe("Bearer test-zernio-api-key");
      expect(seenHeaders["https://crm.example.test/mcp"]).toBe("Bearer crm-secret-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects batches exceeding MAX_BATCH_CALLS or recursive portal_batch_call", async () => {
    const tooManyCalls = Array.from({ length: MAX_BATCH_CALLS + 1 }, (_, i) => ({
      tool: `tool_${i}`,
    }));
    const req = new Request("https://api.liamakeup.workers.dev/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-gateway-token": TEST_ENV.GATEWAY_TOKEN!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "portal_batch_call",
          arguments: { calls: tooManyCalls },
        },
      }),
    });

    const res = await worker.fetch(req, TEST_ENV, createCtx());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("exceeds maximum batch size");
  });

  it("correctly resolves tool prefixes and SSE payloads via unit helpers", () => {
    const servers = parseUpstreamServers(TEST_ENV, "z-key");
    expect(resolveToolTarget("accounts_list", servers)).toEqual({
      server: servers[0],
      upstreamToolName: "accounts_list",
    });
    expect(resolveToolTarget("zernio__accounts_list", servers)).toEqual({
      server: servers[0],
      upstreamToolName: "accounts_list",
    });
    expect(resolveToolTarget("crm__create_lead", servers)).toEqual({
      server: servers[1],
      upstreamToolName: "create_lead",
    });

    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n';
    expect(extractJsonRpcFromSse(sse, 7)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });

    const interpolated = interpolateStepReferences(
      { id: "{{$steps.0.user.id}}", msg: "Hello {{$steps.0.user.name}}!" },
      [{ user: { id: 42, name: "Lia" } }]
    );
    expect(interpolated).toEqual({ id: 42, msg: "Hello Lia!" });
  });
});
