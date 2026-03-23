const MODELS_URL = "https://models.dev/api.json"
const REFRESH_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

interface ModelsDevModel {
  id: string
  name: string
  tool_call: boolean
  reasoning: boolean
  attachment: boolean
  temperature: boolean
  limit: {
    context: number
    output: number
    input?: number
  }
}

interface ModelsDevProvider {
  id: string
  name: string
  api: string
  npm?: string
  env: string[]
  models: Record<string, ModelsDevModel>
}

interface OpenAIModel {
  id: string
  object: "model"
  created: number
  owned_by: string
}

let cachedModels: OpenAIModel[] | null = null
let lastFetch = 0

async function fetchModels(): Promise<OpenAIModel[]> {
  try {
    const res = await fetch(MODELS_URL, {
      headers: { "User-Agent": "copilot-claude-api/1.0" },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`${res.status}`)

    const data = (await res.json()) as Record<string, ModelsDevProvider>

    // Find the github-copilot provider
    const copilot = Object.values(data).find(
      (p) => p.id === "github-copilot" || p.name?.toLowerCase().includes("copilot"),
    )

    if (!copilot) {
      console.warn("No github-copilot provider found in models.dev")
      return []
    }

    const now = Math.floor(Date.now() / 1000)

    return Object.values(copilot.models).map((m) => ({
      id: m.id,
      object: "model" as const,
      created: now,
      owned_by: "github-copilot",
    }))
  } catch (err) {
    console.error("Failed to fetch models:", err)
    return cachedModels ?? []
  }
}

export async function listModels(): Promise<{ object: "list"; data: OpenAIModel[] }> {
  const now = Date.now()
  if (!cachedModels || now - lastFetch > REFRESH_INTERVAL_MS) {
    cachedModels = await fetchModels()
    lastFetch = now
  }
  return { object: "list", data: cachedModels }
}

export async function getModel(id: string): Promise<OpenAIModel | null> {
  const { data } = await listModels()
  return data.find((m) => m.id === id) ?? null
}

// Kick off initial fetch
fetchModels().then((models) => {
  cachedModels = models
  lastFetch = Date.now()
})
