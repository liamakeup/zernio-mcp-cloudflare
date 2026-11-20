# zernio-mcp-cloudflare

> **Cloudflare Workers MCP Server & Gateway cho Zernio Unified Social Media API**  
> Tuân thủ chuẩn **Model Context Protocol (MCP)** mới nhất (**Streamable HTTP**, JSON-RPC 2.0) và tương thích **100% Cloudflare Free Tier** (hoàn toàn miễn phí, 0 chi phí duy trì).

---

## 🌟 Tính năng nổi bật

- **Chuẩn MCP mới nhất (Modern Streamable HTTP)**:
  - 1 Endpoint `POST /mcp` duy nhất xử lý JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `server/discover`).
  - Hỗ trợ full stream responses (Server-Sent Events / chunked transfer) cho các agentic AI hiện đại.
  - Loại bỏ kiến trúc WebSocket nặng nề hoặc SSE 2-endpoint cũ (`Last-Event-ID`).
- **100% Cloudflare Free Tier Compatible**:
  - Chạy trên **Stateless Worker (Fetch Handler)** thuần túy.
  - **Không dùng Durable Objects** (không phát sinh phí $5/tháng của Workers Paid).
  - Tận dụng hạn mức **100.000 requests/ngày** miễn phí vĩnh viễn của Cloudflare.
  - CPU execution time siêu thấp (~1-2ms, giới hạn Free Tier là 10ms).
  - Chạy trực tiếp trên subdomain miễn phí `*.workers.dev` (không cần mua hay trỏ tên miền riêng).
- **Hub kết nối tập trung cho nhiều Agentic AI**:
  - Antigravity (`agy`)
  - Claude Code
  - OpenAI Codex
  - Cursor / Windsurf / VS Code
  - n8n / LangChain / AutoGen / Custom Python & Node.js bots
- **Bảo mật & Quản lý Secret tập trung**:
  - Lưu `ZERNIO_API_KEY` mã hóa trên Cloudflare Worker Secrets.
  - Tùy chọn bảo vệ gateway bằng `GATEWAY_TOKEN` nội bộ.

---

## 📐 Kiến trúc

```
[Agentic AI Clients]
  (agy, Claude Code, Codex, Cursor, n8n, Python agents)
         │
         ▼  POST /mcp (Streamable HTTP, JSON-RPC 2.0)
┌─────────────────────────────────────────────────────────┐
│ Cloudflare Workers Edge (100% Free Tier)                │
│                                                         │
│  1. CORS & Preflight Check (OPTIONS)                    │
│  2. Xác thực nội bộ Gateway Token (tùy chọn)            │
│  3. Xử lý Handshake & Khám phá công cụ (Discovery)     │
│  4. Gắn ZERNIO_API_KEY an toàn từ Cloudflare Secrets     │
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

## 🚀 Hướng dẫn triển khai (Deployment)

### 1. Cài đặt môi trường

```bash
git clone https://github.com/liamakeup/zernio-mcp-cloudflare.git
cd zernio-mcp-cloudflare
npm install
```

### 2. Thiết lập Zernio API Key

Lấy Zernio API Key từ [zernio.com](https://zernio.com/agents) hoặc dashboard tài khoản của bạn, sau đó thiết lập secret trên Cloudflare:

```bash
# Thiết lập Zernio API Key (bảo mật, không lưu trong file code):
npx wrangler secret put ZERNIO_API_KEY

# (Tùy chọn) Đặt token bảo vệ endpoint Worker của bạn:
npx wrangler secret put GATEWAY_TOKEN
```

### 3. Deploy lên Cloudflare Workers (Free)

```bash
npx wrangler deploy
```

Sau khi deploy thành công, bạn sẽ nhận được endpoint:
`https://zernio-mcp-cloudflare.<subdomain>.workers.dev/mcp`

Kiểm tra trạng thái server:
```bash
curl https://zernio-mcp-cloudflare.<subdomain>.workers.dev/health
```

---

## 🔌 Cấu hình kết nối cho các Agentic AI

### 1. Antigravity (`agy`)

Chạy lệnh thêm MCP server trực tiếp:

```bash
# Nếu không đặt GATEWAY_TOKEN:
agy mcp add zernio https://zernio-mcp-cloudflare.<subdomain>.workers.dev/mcp

# Nếu có đặt GATEWAY_TOKEN:
agy mcp add --header "Authorization: Bearer YOUR_GATEWAY_TOKEN" zernio https://zernio-mcp-cloudflare.<subdomain>.workers.dev/mcp

# Kiểm tra danh sách:
agy mcp list
```

### 2. Claude Code

```bash
claude mcp add --transport http zernio https://zernio-mcp-cloudflare.<subdomain>.workers.dev/mcp
```

### 3. OpenAI Codex

Thêm vào file `~/.codex/config.toml`:

```toml
[mcp_servers.zernio]
url = "https://zernio-mcp-cloudflare.<subdomain>.workers.dev/mcp"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 120

# Nếu có GATEWAY_TOKEN:
# headers = { "Authorization" = "Bearer YOUR_GATEWAY_TOKEN" }
```

### 4. Cursor / Windsurf

Thêm vào `.cursor/mcp.json` trong dự án hoặc thư mục cá nhân:

```json
{
  "mcpServers": {
    "zernio": {
      "url": "https://zernio-mcp-cloudflare.<subdomain>.workers.dev/mcp"
    }
  }
}
```

### 5. Python / Node.js Agents & n8n

Sử dụng endpoint `https://zernio-mcp-cloudflare.<subdomain>.workers.dev/mcp` với HTTP POST và header `Content-Type: application/json`.

---

## 🛠️ Danh mục công cụ Zernio hỗ trợ

Gateway này mở khóa toàn bộ **496 công cụ** của Zernio trên **18 nền tảng mạng xã hội**:
- **accounts_***: Quản lý tài khoản mạng xã hội kết nối (Facebook, Instagram, X/Twitter, TikTok, LinkedIn, YouTube, Pinterest, v.v.).
- **posts_***: Tạo bài viết, lên lịch đăng (`scheduledFor`), chỉnh sửa, xóa, retry post thất bại.
- **media_***: Upload và kiểm tra trạng thái ảnh/video trước khi đăng.
- **comments_***: Đọc, trả lời bình luận tự động trên các nền tảng mạng xã hội.
- **messages_***: Đọc và phản hồi tin nhắn hộp thư đến (Social Inbox DMs).
- **analytics_***: Lấy báo cáo tương tác, reach, follower stats, thời điểm vàng để đăng bài (`analytics_get_best_time_to_post`).

---

## 📄 Giấy phép

Mã nguồn được phát hành theo giấy phép [MIT](LICENSE).
Tác giả: [liamakeup](https://github.com/liamakeup)
