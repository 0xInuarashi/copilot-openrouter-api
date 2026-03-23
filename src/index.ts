import { login, loadAuth } from "./auth"
import { createServer } from "./server"

const args = process.argv.slice(2)
const command = args[0]

function printUsage(): void {
  console.log(`
copilot-claude-api — OpenAI-compatible proxy for GitHub Copilot

Usage:
  bun run login  [--enterprise <url>]   Authenticate via GitHub device flow
  bun run serve  [--port <number>]      Start the proxy server (default: 8080)

Examples:
  bun run login
  bun run login -- --enterprise https://github.example.com
  bun run serve
  bun run serve -- --port 3000
`)
}

function parseFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1]
  }
  return undefined
}

async function main(): Promise<void> {
  switch (command) {
    case "login": {
      const enterpriseUrl = parseFlag("--enterprise")
      await login(enterpriseUrl)
      break
    }

    case "serve": {
      const auth = loadAuth()
      if (!auth) {
        console.error("Not authenticated. Run `bun run login` first, or set COPILOT_TOKEN and COPILOT_API_KEY env vars.")
        process.exit(1)
      }

      const portStr = parseFlag("--port")
      const port = portStr ? parseInt(portStr, 10) : 8080
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${portStr}`)
        process.exit(1)
      }

      const app = createServer(auth)

      console.log(`\ncopilot-claude-api server running on http://localhost:${port}`)
      console.log(`\nUse with OpenAI SDK:`)
      console.log(`  export OPENAI_API_KEY="${auth.apiKey}"`)
      console.log(`  export OPENAI_BASE_URL="http://localhost:${port}/v1"`)
      console.log(`\nUse with OpenRouter SDK:`)
      console.log(`  export OPENROUTER_API_KEY="${auth.apiKey}"`)
      console.log(`  export OPENROUTER_BASE_URL="http://localhost:${port}/api/v1"`)
      console.log(`\nEndpoints:`)
      console.log(`  GET  /v1/models          (also /api/v1/models)`)
      console.log(`  POST /v1/chat/completions (also /api/v1/chat/completions)`)
      console.log(`  POST /v1/responses        (also /api/v1/responses)`)
      console.log(`\nPress Ctrl+C to stop.\n`)

      Bun.serve({
        port,
        fetch: app.fetch,
      })
      break
    }

    default:
      printUsage()
      if (command) {
        console.error(`Unknown command: ${command}`)
        process.exit(1)
      }
      break
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
