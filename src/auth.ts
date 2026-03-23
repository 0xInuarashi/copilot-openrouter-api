import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { randomBytes } from "node:crypto"

const CLIENT_ID = "Ov23li8tweQw6odWQebz"
const SCOPE = "read:user"
const POLL_SAFETY_MARGIN_MS = 3000
const VERSION = "1.0.0"

function configDir(): string {
  const dir = join(homedir(), ".config", "copilot-claude-api")
  mkdirSync(dir, { recursive: true })
  return dir
}

function authPath(): string {
  return join(configDir(), "auth.json")
}

export interface AuthData {
  token: string
  domain: string
  apiKey: string
}

function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

export function loadAuth(): AuthData | null {
  // Env vars take priority (for serverless / container deployments)
  const envToken = process.env.COPILOT_TOKEN
  const envApiKey = process.env.COPILOT_API_KEY
  if (envToken && envApiKey) {
    return {
      token: envToken,
      domain: process.env.COPILOT_DOMAIN ?? "github.com",
      apiKey: envApiKey,
    }
  }

  // Fall back to auth.json file
  const p = authPath()
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, "utf-8"))
    if (data.token && data.apiKey) return data as AuthData
    return null
  } catch {
    return null
  }
}

function saveAuth(data: AuthData): void {
  const p = authPath()
  writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export function getBaseURL(auth: AuthData): string {
  if (auth.domain === "github.com") {
    return "https://api.githubcopilot.com"
  }
  return `https://copilot-api.${auth.domain}`
}

function getUrls(domain: string) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function login(enterpriseUrl?: string): Promise<void> {
  let domain = "github.com"

  if (enterpriseUrl) {
    domain = normalizeDomain(enterpriseUrl)
    console.log(`\nUsing GitHub Enterprise: ${domain}`)
  } else {
    console.log(`\nUsing GitHub.com`)
  }

  const urls = getUrls(domain)

  // Step 1: Request device code
  console.log("\nRequesting device code...")

  const deviceRes = await fetch(urls.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": `copilot-claude-api/${VERSION}`,
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: SCOPE,
    }),
  })

  if (!deviceRes.ok) {
    const text = await deviceRes.text()
    console.error(`Failed to initiate device authorization: ${deviceRes.status} ${text}`)
    process.exit(1)
  }

  const deviceData = (await deviceRes.json()) as {
    verification_uri: string
    user_code: string
    device_code: string
    interval: number
  }

  // Step 2: Show user instructions
  console.log(`\n${"=".repeat(50)}`)
  console.log(`  Open:  ${deviceData.verification_uri}`)
  console.log(`  Code:  ${deviceData.user_code}`)
  console.log(`${"=".repeat(50)}`)
  console.log(`\nWaiting for authorization...`)

  // Step 3: Poll for access token
  let interval = deviceData.interval

  while (true) {
    await sleep(interval * 1000 + POLL_SAFETY_MARGIN_MS)

    const tokenRes = await fetch(urls.accessTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": `copilot-claude-api/${VERSION}`,
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceData.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    if (!tokenRes.ok) {
      console.error(`Token request failed: ${tokenRes.status}`)
      process.exit(1)
    }

    const data = (await tokenRes.json()) as {
      access_token?: string
      error?: string
      interval?: number
    }

    if (data.access_token) {
      // Generate a local API key for protecting the proxy
      const apiKey = `sk-copilot-${randomBytes(24).toString("hex")}`

      saveAuth({
        token: data.access_token,
        domain,
        apiKey,
      })

      console.log(`\nAuthenticated successfully!`)
      console.log(`\nToken stored in: ${authPath()}`)
      console.log(`\nYour local API key (use this with OpenAI SDK):`)
      console.log(`\n  ${apiKey}`)
      console.log(`\nExample usage:`)
      console.log(`  export OPENAI_API_KEY="${apiKey}"`)
      console.log(`  export OPENAI_BASE_URL="http://localhost:8080/v1"`)
      console.log(`\nStart the server with: bun run serve`)
      return
    }

    if (data.error === "authorization_pending") {
      continue
    }

    if (data.error === "slow_down") {
      // RFC 8628: add 5 seconds to current interval
      interval = (data.interval ?? interval + 5)
      continue
    }

    if (data.error) {
      console.error(`Authorization failed: ${data.error}`)
      process.exit(1)
    }
  }
}
