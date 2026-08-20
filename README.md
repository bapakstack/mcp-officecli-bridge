# mcp-officecli-bridge

Streamable HTTP bridge for **OfficeCLI official MCP** (`officecli mcp` stdio) — supaya bisa dipakai **Gemini Spark Custom App** dan di-host di **Coolify (Tencent Cloud)**.

> Tidak re-implement tools OfficeCLI. Semua tools (`create, view, get, query, add, set, remove, move, swap, batch, dump, merge, validate, …`) otomatis ke-expose dari upstream.

```
Gemini Spark --POST /mcp (Streamable HTTP)-->  Express (src/server.ts)  --stdio-->  officecli mcp
```

## Deploy di Coolify (2 menit)

1. Coolify → **+ New Service → Application** → pilih repo `mcp_office_cli`
2. **Build Pack:** `Dockerfile` — **Port:** `3000`
3. (Opsional) Set domain: `mcp.yourdomain.com`
4. Deploy → cek `https://mcp.yourdomain.com/health` → `{"status":"ok"}`
5. Gemini Spark → **Custom App → MCP URL** = `https://mcp.yourdomain.com/mcp`

## Local test

```bash
npm install
npm run build
# butuh officecli terinstall (winget/brew/npm) untuk test lokal, atau pakai Docker
npm start
# test
curl http://localhost:3000/health
curl -X POST http://localhost:3000/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

## Inspector

```bash
npx @modelcontextprotocol/inspector
# URL: http://localhost:3000/mcp  (Streamable HTTP)
```

## Env

| Var                  | Default     | Deskripsi                                                        |
| -------------------- | ----------- | ---------------------------------------------------------------- |
| `PORT`               | `3000`      | Port HTTP                                                        |
| `OFFICECLI_BIN`      | `officecli` | Path binary officecli                                            |
| `REQUEST_TIMEOUT_MS` | `25000`     | Timeout proxy ke upstream                                        |
| `MCP_AUTH_TOKEN`     | -           | Jika diisi, butuh `Authorization: Bearer <token>` (todo: wiring) |
