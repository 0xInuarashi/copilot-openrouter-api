import { Hono } from "hono"
import { cors } from "hono/cors"
import type { AuthData } from "./auth"
import { listModels, getModel } from "./models"
import { proxyToGitHubCopilot } from "./proxy"

let requestCounter = 0

function ts(): string {
  return new Date().toISOString()
}

function apiKeyMiddleware(auth: AuthData) {
  return async (c: any, next: any) => {
    const authHeader = c.req.header("Authorization")
    if (!authHeader) {
      return c.json(
        {
          error: {
            message: "Missing Authorization header. Use: Authorization: Bearer <your-api-key>",
            type: "invalid_request_error",
            code: "missing_api_key",
          },
        },
        401,
      )
    }

    const token = authHeader.replace(/^Bearer\s+/i, "")
    if (token !== auth.apiKey) {
      return c.json(
        {
          error: {
            message: "Invalid API key.",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        },
        401,
      )
    }

    await next()
  }
}

function createAPIRoutes(auth: AuthData): Hono {
  const api = new Hono()

  // GET /models — public, no auth required
  api.get("/models", async (c) => {
    const models = await listModels()
    return c.json(models)
  })

  // GET /models/:id — public, no auth required
  api.get("/models/:id", async (c) => {
    const id = c.req.param("id")
    const model = await getModel(id)
    if (!model) {
      return c.json(
        {
          error: {
            message: `Model '${id}' not found.`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        404,
      )
    }
    return c.json(model)
  })

  // POST /chat/completions — auth required
  api.post("/chat/completions", apiKeyMiddleware(auth), async (c) => {
    return proxyToGitHubCopilot(c.req.raw, "chat/completions", auth)
  })

  // POST /responses — auth required
  api.post("/responses", apiKeyMiddleware(auth), async (c) => {
    return proxyToGitHubCopilot(c.req.raw, "responses", auth)
  })

  return api
}

export function createServer(auth: AuthData): Hono {
  const app = new Hono()

  // CORS - allow everything (local proxy)
  app.use("*", cors())

  // Global request/response logging middleware
  app.use("*", async (c, next) => {
    const id = ++requestCounter
    const method = c.req.method
    const url = new URL(c.req.url)
    const path = url.pathname
    const start = performance.now()

    // Log incoming request
    const headers = Object.fromEntries(c.req.raw.headers.entries())
    // Redact auth tokens in logs
    if (headers["authorization"]) {
      const val = headers["authorization"]
      headers["authorization"] = val.length > 20
        ? val.slice(0, 15) + "..." + val.slice(-4)
        : "***"
    }

    console.log(`\n[${ts()}] ──────────────────────────────────────`)
    console.log(`[${ts()}] #${id} ► INCOMING REQUEST`)
    console.log(`[${ts()}] #${id}   ${method} ${path}`)
    console.log(`[${ts()}] #${id}   Headers: ${JSON.stringify(headers)}`)

    await next()

    // Log outgoing response back to user
    const elapsed = (performance.now() - start).toFixed(1)
    console.log(`[${ts()}] #${id} ◄ RESPONSE TO CLIENT`)
    console.log(`[${ts()}] #${id}   Status: ${c.res.status}`)
    console.log(`[${ts()}] #${id}   Content-Type: ${c.res.headers.get("content-type") ?? "n/a"}`)
    console.log(`[${ts()}] #${id}   Duration: ${elapsed}ms`)
    console.log(`[${ts()}] ──────────────────────────────────────`)
  })

  // Health check
  app.get("/", (c) => {
    return c.json({
      status: "ok",
      service: "copilot-claude-api",
      version: "1.0.0",
      endpoints: ["/v1/models", "/v1/chat/completions", "/v1/responses", "/api/v1/models", "/api/v1/chat/completions", "/api/v1/responses"],
    })
  })

  // Mount API routes at both /v1 and /api/v1
  const api = createAPIRoutes(auth)
  app.route("/v1", api)
  app.route("/api/v1", api)

  return app
}
