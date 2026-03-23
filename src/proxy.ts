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

// Convert chat/completions messages format → responses input format
function completionsToResponses(body: any): any {
  const converted: any = { ...body }
  delete converted.messages

  converted.input = (body.messages ?? []).map((msg: any) => {
    // String content → input_text block
    if (typeof msg.content === "string") {
      return {
        role: msg.role,
        content: [{ type: "input_text", text: msg.content }],
      }
    }
    // Array content → map each part
    if (Array.isArray(msg.content)) {
      return {
        role: msg.role,
        content: msg.content.map((part: any) => {
          if (part.type === "text") return { type: "input_text", text: part.text }
          if (part.type === "image_url") return { type: "input_image", image_url: part.image_url }
          return part
        }),
      }
    }
    return { role: msg.role, content: msg.content }
  })

  return converted
}

// Convert responses input format → chat/completions messages format
function responsesToCompletions(body: any): any {
  const converted: any = { ...body }
  delete converted.input

  converted.messages = (body.input ?? []).map((item: any) => {
    // Already a string content
    if (typeof item.content === "string") {
      return { role: item.role, content: item.content }
    }
    // Array content → map each part
    if (Array.isArray(item.content)) {
      const parts = item.content.map((part: any) => {
        if (part.type === "input_text") return { type: "text", text: part.text }
        if (part.type === "input_image") return { type: "image_url", image_url: part.image_url }
        return part
      })
      // If single text part, flatten to string
      if (parts.length === 1 && parts[0].type === "text") {
        return { role: item.role, content: parts[0].text }
      }
      return { role: item.role, content: parts }
    }
    return { role: item.role, content: item.content }
  })

  return converted
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

function buildHeaders(auth: AuthData, isStream: boolean, isVision: boolean, isAgent: boolean): Record<string, string> {
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
  return headers
}

function logRequest(targetURL: string, headers: Record<string, string>, bodyText: string, isStream: boolean, isVision: boolean, isAgent: boolean) {
  const redacted = { ...headers }
  if (redacted["Authorization"]) {
    const val = redacted["Authorization"]
    redacted["Authorization"] = val.length > 20 ? val.slice(0, 15) + "..." + val.slice(-4) : "***"
  }
  console.log(`[${ts()}]     ▶ PROXY REQUEST TO PROVIDER`)
  console.log(`[${ts()}]       POST ${targetURL}`)
  console.log(`[${ts()}]       Headers: ${JSON.stringify(redacted)}`)
  console.log(`[${ts()}]       Body: ${bodyText.length > 2000 ? bodyText.slice(0, 2000) + "...(truncated)" : bodyText}`)
  console.log(`[${ts()}]       stream=${isStream} vision=${isVision} agent=${isAgent}`)
}

function logResponse(upstream: Response, elapsed: string) {
  const upstreamHeaders = Object.fromEntries(upstream.headers.entries())
  console.log(`[${ts()}]     ◀ PROVIDER RESPONSE`)
  console.log(`[${ts()}]       Status: ${upstream.status} ${upstream.statusText}`)
  console.log(`[${ts()}]       Headers: ${JSON.stringify(upstreamHeaders)}`)
  console.log(`[${ts()}]       Latency: ${elapsed}ms`)
}

function logTokenUsage(responseBody: string) {
  try {
    const parsed = JSON.parse(responseBody)
    const usage = parsed?.usage
    if (usage) {
      const prompt = usage.prompt_tokens ?? 0
      const completion = usage.completion_tokens ?? 0
      const total = usage.total_tokens ?? (prompt + completion)
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
      console.log(`[${ts()}]       Tokens: ${total} total (${prompt} prompt${cached ? ` / ${cached} cached` : ""} + ${completion} completion)`)
    }
  } catch {}
}

// Check if an error response indicates the model doesn't support this API
function isUnsupportedApiError(status: number, responseBody: string): boolean {
  if (status !== 400) return false
  try {
    const parsed = JSON.parse(responseBody)
    return parsed?.error?.code === "unsupported_api_for_model"
  } catch {}
  return false
}

export async function proxyToGitHubCopilot(
  request: Request,
  targetPath: string,
  auth: AuthData,
): Promise<Response> {
  const baseURL = getBaseURL(auth)

  const bodyText = await request.text()
  let body: any = null
  try {
    body = JSON.parse(bodyText)
  } catch {}

  const isStream = body?.stream === true
  const isVision = hasImageContent(body)
  const isAgent = isAgentInitiated(body)
  const headers = buildHeaders(auth, isStream, isVision, isAgent)

  // First attempt: send to the requested endpoint
  const targetURL = `${baseURL}/${targetPath}`
  logRequest(targetURL, headers, bodyText, isStream, isVision, isAgent)

  const start = performance.now()
  const upstream = await fetch(targetURL, { method: "POST", headers, body: bodyText })
  const elapsed = (performance.now() - start).toFixed(1)
  logResponse(upstream, elapsed)

  // For streaming, we can't easily detect the error, so pass through as-is
  if (isStream && upstream.body && upstream.status !== 400) {
    console.log(`[${ts()}]       Mode: SSE stream passthrough`)
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    })
  }

  const responseBody = await upstream.text()

  // If model doesn't support this API, translate and retry on the other endpoint
  if (body && isUnsupportedApiError(upstream.status, responseBody)) {
    const altPath = targetPath === "chat/completions" ? "responses" : "chat/completions"
    const altBody = targetPath === "chat/completions"
      ? completionsToResponses(body)
      : responsesToCompletions(body)
    const altBodyText = JSON.stringify(altBody)
    const altURL = `${baseURL}/${altPath}`

    console.log(`[${ts()}]       Model unsupported on /${targetPath}, retrying on /${altPath}`)
    logRequest(altURL, headers, altBodyText, isStream, isVision, isAgent)

    const retryStart = performance.now()
    const retryUpstream = await fetch(altURL, { method: "POST", headers, body: altBodyText })
    const retryElapsed = (performance.now() - retryStart).toFixed(1)
    logResponse(retryUpstream, retryElapsed)

    if (isStream && retryUpstream.body) {
      console.log(`[${ts()}]       Mode: SSE stream passthrough (fallback)`)
      return new Response(retryUpstream.body, {
        status: retryUpstream.status,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      })
    }

    const retryBody = await retryUpstream.text()
    console.log(`[${ts()}]       Mode: JSON passthrough (fallback)`)
    console.log(`[${ts()}]       Body: ${retryBody.length > 2000 ? retryBody.slice(0, 2000) + "...(truncated)" : retryBody}`)

    const retryNormalized = normalizeChatResponse(retryBody)
    if (retryNormalized !== retryBody) {
      console.log(`[${ts()}]       Normalized: ${retryNormalized.length > 2000 ? retryNormalized.slice(0, 2000) + "...(truncated)" : retryNormalized}`)
    }
    logTokenUsage(retryNormalized)

    return new Response(retryNormalized, {
      status: retryUpstream.status,
      headers: { "Content-Type": "application/json" },
    })
  }

  // Normal path — no fallback needed
  console.log(`[${ts()}]       Mode: JSON passthrough`)
  console.log(`[${ts()}]       Body: ${responseBody.length > 2000 ? responseBody.slice(0, 2000) + "...(truncated)" : responseBody}`)

  const normalized = normalizeChatResponse(responseBody)
  if (normalized !== responseBody) {
    console.log(`[${ts()}]       Normalized: ${normalized.length > 2000 ? normalized.slice(0, 2000) + "...(truncated)" : normalized}`)
  }
  logTokenUsage(normalized)

  return new Response(normalized, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  })
}
