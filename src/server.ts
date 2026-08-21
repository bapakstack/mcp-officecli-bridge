#!/usr/bin/env node
/**
 * mcp-officecli-bridge — Streamable HTTP bridge for OfficeCLI official MCP (stdio)
 * Designed for Coolify (Tencent Cloud) + Gemini Spark Custom App.
 *
 * Architecture:
 *   Gemini Spark --(Streamable HTTP POST /mcp)--> Express --(stdio)--> `officecli mcp`
 *   Every POST spawns a short-lived `officecli mcp` child and proxies JSON-RPC.
 *   No tools are re-defined — all tools from official MCP are auto-exposed.
 *
 * Why per-request spawn (stateless):
 *   - Simple, no shared state / race conditions
 *   - Coolify container can handle concurrent requests
 *   - Matches SDK pattern: sessionIdGenerator=undefined + enableJsonResponse=true
 */

import express from 'express'
import cors from 'cors'
import { spawn, spawnSync } from 'child_process'
import { randomUUID } from 'crypto'

const PORT = parseInt(process.env.PORT || '3000', 10)
const OFFICECLI_BIN = process.env.OFFICECLI_BIN || 'officecli'
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.REQUEST_TIMEOUT_MS || '25000',
  10,
)
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || ''

const app = express()
app.use(cors({ origin: '*', exposedHeaders: ['mcp-session-id'] }))
// Keep raw body for MCP but also parse JSON
app.use(express.json({ limit: '20mb' }))

// Optional Bearer auth (set MCP_AUTH_TOKEN in Coolify env)
function authGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!MCP_AUTH_TOKEN) return next()
  // Allow health/root without auth
  if (req.path === '/health' || req.path === '/') return next()
  const hdr = req.headers.authorization || ''
  if (hdr === `Bearer ${MCP_AUTH_TOKEN}`) return next()
  res.status(401).json({
    error: 'Unauthorized — set Authorization: Bearer <MCP_AUTH_TOKEN>',
  })
}
app.use(authGuard)

// --- helpers ---
function hasOfficeCli(): boolean {
  try {
    let r = spawnSync(OFFICECLI_BIN, ['--version'], { timeout: 5000 })
    if (r.status === 0) return true
    // Fallback for slim images without libicu — run with Invariant mode
    r = spawnSync(OFFICECLI_BIN, ['--version'], {
      timeout: 5000,
      env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
    })
    return r.status === 0
  } catch {
    return false
  }
}

function log(...args: unknown[]) {
  console.error(`[bridge ${new Date().toISOString()}]`, ...args)
}

// Proxy single JSON-RPC message via stdio child
// Auto-fallback to DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 if libicu is missing at runtime
async function proxyToStdio(body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(OFFICECLI_BIN, ['mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: process.env.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT || '0' },
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGTERM')
        reject(new Error(`Upstream timeout after ${REQUEST_TIMEOUT_MS}ms`))
      }
    }, REQUEST_TIMEOUT_MS)

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      // officecli mcp replies with one JSON line per request.
      // Try to parse complete JSON if we already have it.
      try {
        const parsed = JSON.parse(stdout.trim())
        if (!settled) {
          settled = true
          clearTimeout(timer)
          child.kill('SIGTERM')
          resolve(parsed)
        }
      } catch {
        // incomplete JSON, wait for more data
      }
    })

    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })

    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Notification (no id) legitimately returns empty stdout
      const bodyObj = body as Record<string, unknown> | null
      const isNotification =
        bodyObj &&
        bodyObj.id === undefined &&
        bodyObj.method?.toString().startsWith('notifications/')
      if (isNotification && !stdout.trim()) {
        resolve(null)
        return
      }
      if (stdout.trim()) {
        try {
          resolve(JSON.parse(stdout.trim()))
        } catch (e) {
          reject(
            new Error(
              `Invalid JSON from upstream: ${String(e)} | stdout=${stdout} stderr=${stderr}`,
            ),
          )
        }
      } else {
        reject(
          new Error(
            `Upstream closed with code ${code} without response. stderr=${stderr}`,
          ),
        )
      }
    })

    // Send request as one JSON line
    try {
      child.stdin.write(JSON.stringify(body) + '\n')
      // For notifications we can end quickly; for requests keep stdin open briefly
      // Closing stdin signals EOF to stdio server after single request (stateless)
      // Give a small delay before ending to avoid race on some platforms
      setTimeout(() => {
        try {
          child.stdin.end()
        } catch {}
      }, 50)
    } catch (e) {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(e as Error)
      }
    }
  })
}

// --- routes ---
app.get('/health', (_req, res) => {
  const ok = hasOfficeCli()
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'officecli not found',
    bridge: 'mcp-officecli-bridge',
    upstream: OFFICECLI_BIN,
    time: new Date().toISOString(),
  })
})

app.get('/', (_req, res) => {
  res.type('html').send(`
  <h1>mcp-officecli-bridge ✅</h1>
  <p>Streamable HTTP bridge for <code>officecli mcp</code> (official).</p>
  <ul>
    <li><code>POST /mcp</code> — MCP Streamable HTTP endpoint (for Gemini Spark)</li>
    <li><code>GET /health</code> — health check</li>
  </ul>
  <p>Gemini Spark Custom App → MCP URL: <code>https://YOUR_DOMAIN/mcp</code></p>
  <p>Upstream: <code>${OFFICECLI_BIN} mcp</code> — ${hasOfficeCli() ? 'found' : 'NOT FOUND'}</p>
  `)
})

// Streamable HTTP spec: client POSTs JSON-RPC to /mcp, server returns JSON or SSE
app.post('/mcp', async (req, res) => {
  const reqId = randomUUID().slice(0, 8)
  log(`→ [${reqId}] POST /mcp`, JSON.stringify(req.body).slice(0, 400))

  // Handle batch (array of messages)
  const body = req.body
  const isBatch = Array.isArray(body)

  // Notifications (no id) should return 202 with empty body
  const isNotification =
    !isBatch &&
    body &&
    typeof body === 'object' &&
    (body as Record<string, unknown>).id === undefined &&
    typeof (body as Record<string, unknown>).method === 'string' &&
    ((body as Record<string, unknown>).method as string).startsWith(
      'notifications/',
    )

  if (isNotification) {
    // Fire-and-forget to upstream but don't wait for response
    proxyToStdio(body).catch((e) =>
      log(`notification proxy error [${reqId}]`, e),
    )
    res.status(202).send('')
    return
  }

  try {
    if (isBatch) {
      // Batch: proxy each message sequentially (upstream is per-request, so do in parallel)
      const results = await Promise.all(
        (body as unknown[]).map((msg) =>
          proxyToStdio(msg).catch((e) => ({
            jsonrpc: '2.0',
            id: (msg as Record<string, unknown>)?.id ?? null,
            error: { code: -32603, message: String(e.message || e) },
          })),
        ),
      )
      // Filter nulls (notifications)
      const filtered = results.filter((r) => r !== null)
      res.setHeader('Content-Type', 'application/json')
      res.json(filtered.length === 1 ? filtered[0] : filtered)
      return
    }

    const result = await proxyToStdio(body)
    if (result === null) {
      res.status(202).send('')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    // Required for Streamable HTTP clients
    res.setHeader('Cache-Control', 'no-cache')
    res.json(result)
    log(`← [${reqId}]`, JSON.stringify(result).slice(0, 600))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`✖ [${reqId}]`, msg)
    // Return JSON-RPC error if we can
    const id = (body as Record<string, unknown>)?.id ?? null
    res
      .status(200)
      .json({ jsonrpc: '2.0', id, error: { code: -32603, message: msg } })
  }
})

// Some clients do GET /mcp for SSE stream — return 405 with info (stateless mode doesn't support SSE)
app.get('/mcp', (_req, res) => {
  res.status(405).json({
    error:
      'Method Not Allowed — use POST /mcp with JSON-RPC. SSE streaming not enabled in stateless mode. Set enableJsonResponse=true on client.',
  })
})

app.listen(PORT, '0.0.0.0', () => {
  const hasCli = hasOfficeCli()
  console.error(`\n✅ mcp-officecli-bridge listening on 0.0.0.0:${PORT}`)
  console.error(`   POST /mcp  → Streamable HTTP (Gemini Spark)`)
  console.error(`   GET  /health → health check`)
  console.error(
    `   Upstream: ${OFFICECLI_BIN} ${hasCli ? '✓ found' : '✗ NOT FOUND — build will install it'}`,
  )
  if (!hasCli)
    console.error(
      `   Hint: set OFFICECLI_BIN=/usr/local/bin/officecli or reinstall via Dockerfile`,
    )
})
