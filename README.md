# zernio-mcp-cloudflare

> **Cloudflare Workers MCP Server & Gateway cho Zernio Unified Social Media API**  
> Tuân thủ chuẩn **Model Context Protocol (MCP)** mới nhất (**Streamable HTTP**, JSON-RPC 2.0) và tương thích **100% Cloudflare Free Tier** (hoàn toàn miễn phí, 0 chi phí duy trì).

- **Production Endpoint**: `https://api.zerniomcp.workers.dev/mcp`
- **Health Check**: `https://api.zerniomcp.workers.dev/health`

---

## 🌟 Tính năng nổi bật

- **Chuẩn MCP mới nhất (Modern Streamable HTTP)**:
  - 1 Endpoint `POST /mcp` (và `POST /`) xử lý JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `server/discover`).
  - Hỗ trợ full stream responses (Server-Sent Events / chunked transfer) cho các agentic AI hiện đại.
  - Loại bỏ kiến trúc WebSocket nặng nề và SSE 2-endpoint cũ (`Last-Event-ID`).
- **100% Cloudflare Free Tier Compatible**:
  - Chạy trên **Stateless Worker (Fetch Handler)** thuần túy.
  - **Không dùng Durable Objects** (không phát sinh phí $5/tháng của Workers Paid).
  - Tận dụng hạn mức **100.000 requests/ngày** miễn phí vĩnh viễn của Cloudflare.
  - CPU execution time siêu thấp (~1-2ms, giới hạn Free Tier là 10ms).
  - Subdomain chuẩn: `api.zerniomcp.workers.dev`.
- **Linh hoạt xác thực**:
  - Hỗ trợ header `x-api-key` (tương thích cấu hình của mrgoonie/zernio-mcp và Claude Desktop / Cursor).
  - Hỗ trợ header chuẩn `Authorization: Bearer <sk_key>`.
  - Hỗ trợ secret `ZERNIO_API_KEY` lưu tại Worker (cho agent headless tự động).
  - Tùy chọn đặt `GATEWAY_TOKEN` bảo vệ endpoint.

---

## 📐 Kiến trúc

```
[Agentic AI Clients]
  (agy, Claude Code, Codex, Cursor, n8n, Python agents)
         │
         ▼  POST https://api.zerniomcp.workers.dev/mcp
┌─────────────────────────────────────────────────────────┐
│ Cloudflare Workers Edge (100% Free Tier)                │
│                                                         │
│  1. CORS & Preflight Check (OPTIONS)                    │
│  2. Xác thực nội bộ Gateway Token (tùy chọn)            │
│  3. Xử lý Handshake & Khám phá công cụ (Discovery)     │
│  4. Nhận x-api-key, Bearer hoặc Secret ZERNIO_API_KEY   │
│  5. Stream JSON-RPC Request/Response                    │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼  Streamable HTTP
┌─────────────────────────────────────────────────────────┐
│ Zernio MCP Server (https://mcp.zernio.com/mcp)          │
│ 496 Tools · 18 Social Media Platforms                   │
└─────────────────────────────────────────────────────────┘
```

---

## 🚀 Triển khai & Cấu hình (Deployment)

### 1. Thiết lập Zernio API Key (Tùy chọn)

Nếu muốn Worker tự động tiêm API key cho mọi agent nội bộ mà không cần truyền key từ client:

```bash
npx wrangler secret put ZERNIO_API_KEY
```

### 2. Deploy lên Cloudflare Workers (Free)

```bash
npm run deploy
```

Endpoint hoạt động:
`https://api.zerniomcp.workers.dev/mcp`

Kiểm tra:
```bash
curl https://api.zerniomcp.workers.dev/health
```

---

## 🔌 Cấu hình kết nối cho các Agentic AI

### 1. Antigravity (`agy`)

```bash
agy mcp add zernio https://api.zerniomcp.workers.dev/mcp
```

### 2. Claude Code

```bash
claude mcp add --transport http zernio https://api.zerniomcp.workers.dev/mcp
```

### 3. OpenAI Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.zernio]
url = "https://api.zerniomcp.workers.dev/mcp"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 120
```

### 4. Cursor / Windsurf (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "zernio": {
      "url": "https://api.zerniomcp.workers.dev/mcp"
    }
  }
}
```

---

## 📄 Giấy phép

Mã nguồn được phát hành theo giấy phép [MIT](LICENSE).
Tác giả: [liamakeup](https://github.com/liamakeup)
