import type { AuthData } from "./auth"
import { getBaseURL } from "./auth"

const VERSION = "1.0.0"

function ts(): string {
  return new Date().toISOString()
}

function hasImageContent(body: any): boolean {
  try {
    // Chat Completions API: messages[].content[].type === "image_url"
    if (body?.messages) {
      return body.messages.some(
        (msg: any) =>
          Array.isArray(msg.content) &&
          msg.content.some((part: any) => part.type === "image_url"),
      )
    }
    // Responses API: input[].content[].type === "input_image"
    if (body?.input) {
      return body.input.some(
        (item: any) =>
          Array.isArray(item?.content) &&
          item.content.some((part: any) => part.type === "input_image"),
      )
    }
  } catch {}
  return false
}

function isAgentInitiated(body: any): boolean {
  try {
    if (body?.messages) {
      const last = body.messages[body.messages.length - 1]
      return last?.role !== "user"
    }
    if (body?.input) {
      const last = body.input[body.input.length - 1]
      return last?.role !== "user"
    }
  } catch {}
  return false
}

// Copilot sometimes returns multiple choices where one has the text content
// and another has the tool_calls. Merge them into a single choice so that
// standard OpenAI SDK agentic loops (which only read choices[0]) work correctly.
function normalizeChatResponse(responseBody: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(responseBody)
  } catch {
    return responseBody
  }

  if (!Array.isArray(parsed?.choices) || parsed.choices.length <= 1) {
    return responseBody
  }

  const choices: any[] = parsed.choices

  // Collect content and tool_calls across all choices
  const contentParts: string[] = []
  const toolCalls: any[] = []
  let finishReason: string = choices[0].finish_reason ?? "stop"

  for (const choice of choices) {
    const msg = choice.message
    if (!msg) continue
    if (typeof msg.content === "string" && msg.content.trim()) {
      contentParts.push(msg.content)
    }
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      toolCalls.push(...msg.tool_calls)
    }
    // Prefer "tool_calls" as the finish_reason if any choice has it
    if (choice.finish_reason === "tool_calls") {
      finishReason = "tool_calls"
    }
  }

  const mergedMessage: any = {
    role: "assistant",
    content: contentParts.join("") || null,
  }
  if (toolCalls.length > 0) {
    mergedMessage.tool_calls = toolCalls
  }

  parsed.choices = [
    {
      index: 0,
      message: mergedMessage,
      finish_reason: finishReason,
    },
  ]

  return JSON.stringify(parsed)
}

export async function proxyToGitHubCopilot(
  request: Request,
  targetPath: string,
  auth: AuthData,
): Promise<Response> {
  const baseURL = getBaseURL(auth)
  const targetURL = `${baseURL}/${targetPath}`

  // Read the body once so we can inspect it and forward it
  const bodyText = await request.text()
  let body: any = null
  try {
    body = JSON.parse(bodyText)
  } catch {}

  const isStream = body?.stream === true
  const isVision = hasImageContent(body)
  const isAgent = isAgentInitiated(body)

  // Build headers for the Copilot API
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: isStream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${auth.token}`,
    "User-Agent": `copilot-claude-api/${VERSION}`,
    "Openai-Intent": "conversation-edits",
    "x-initiator": isAgent ? "agent" : "user",
  }

  if (isVision) {
    headers["Copilot-Vision-Request"] = "true"
  }

  // Log outgoing request to provider
  const redactedHeaders = { ...headers }
  if (redactedHeaders["Authorization"]) {
    const val = redactedHeaders["Authorization"]
    redactedHeaders["Authorization"] = val.length > 20
      ? val.slice(0, 15) + "..." + val.slice(-4)
      : "***"
  }

  console.log(`[${ts()}]     ▶ PROXY REQUEST TO PROVIDER`)
  console.log(`[${ts()}]       POST ${targetURL}`)
  console.log(`[${ts()}]       Headers: ${JSON.stringify(redactedHeaders)}`)
  console.log(`[${ts()}]       Body: ${bodyText.length > 2000 ? bodyText.slice(0, 2000) + "...(truncated)" : bodyText}`)
  console.log(`[${ts()}]       stream=${isStream} vision=${isVision} agent=${isAgent}`)

  // Forward the request
  const start = performance.now()
  const upstream = await fetch(targetURL, {
    method: "POST",
    headers,
    body: bodyText,
  })
  const elapsed = (performance.now() - start).toFixed(1)

  // Log provider response
  const upstreamHeaders = Object.fromEntries(upstream.headers.entries())
  console.log(`[${ts()}]     ◀ PROVIDER RESPONSE`)
  console.log(`[${ts()}]       Status: ${upstream.status} ${upstream.statusText}`)
  console.log(`[${ts()}]       Headers: ${JSON.stringify(upstreamHeaders)}`)
  console.log(`[${ts()}]       Latency: ${elapsed}ms`)

  // For streaming, pipe the SSE stream through directly
  if (isStream && upstream.body) {
    console.log(`[${ts()}]       Mode: SSE stream passthrough`)
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }

  // For non-streaming, forward the JSON response
  const responseBody = await upstream.text()
  console.log(`[${ts()}]       Mode: JSON passthrough`)
  console.log(`[${ts()}]       Body: ${responseBody.length > 2000 ? responseBody.slice(0, 2000) + "...(truncated)" : responseBody}`)

  const normalized = normalizeChatResponse(responseBody)
  if (normalized !== responseBody) {
    console.log(`[${ts()}]       Normalized: ${normalized.length > 2000 ? normalized.slice(0, 2000) + "...(truncated)" : normalized}`)
  }

  // Log token usage summary if present
  try {
    const parsed = JSON.parse(normalized)
    const usage = parsed?.usage
    if (usage) {
      const prompt = usage.prompt_tokens ?? 0
      const completion = usage.completion_tokens ?? 0
      const total = usage.total_tokens ?? (prompt + completion)
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
      console.log(`[${ts()}]       Tokens: ${total} total (${prompt} prompt${cached ? ` / ${cached} cached` : ""} + ${completion} completion)`)
    }
  } catch {}

  return new Response(normalized, {
    status: upstream.status,
    headers: {
      "Content-Type": "application/json",
    },
  })
}
