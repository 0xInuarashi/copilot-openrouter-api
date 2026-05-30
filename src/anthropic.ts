// Translates between Anthropic Messages API and OpenAI Chat Completions API formats.

// ── Request Conversion (Anthropic → OpenAI) ────────────────────────

function convertMessages(messages: any[]): any[] {
  const out: any[] = []

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      out.push({ role: msg.role, content: msg.content })
      continue
    }

    const toolResults: any[] = []
    const toolUses: any[] = []
    const parts: any[] = []

    for (const block of msg.content) {
      switch (block.type) {
        case "tool_result":
          toolResults.push(block)
          break
        case "tool_use":
          toolUses.push(block)
          break
        case "image": {
          const url =
            block.source?.type === "base64"
              ? `data:${block.source.media_type};base64,${block.source.data}`
              : block.source?.url
          parts.push({ type: "image_url", image_url: { url } })
          break
        }
        case "text":
          parts.push({ type: "text", text: block.text })
          break
        default:
          parts.push(block)
      }
    }

    // tool_result blocks → OpenAI "tool" role messages
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        let content = tr.content
        if (Array.isArray(content)) {
          content = content
            .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("")
        }
        out.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
        })
      }
      continue
    }

    // Assistant with tool_use blocks → OpenAI tool_calls
    if (msg.role === "assistant" && toolUses.length > 0) {
      const text = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("")
      out.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolUses.map((tu: any) => ({
          id: tu.id,
          type: "function",
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input ?? {}),
          },
        })),
      })
      continue
    }

    // Regular content array — collapse single text block to string
    out.push({
      role: msg.role,
      content:
        parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
    })
  }

  return out
}

export function anthropicToOpenAI(body: any): any {
  const messages: any[] = []

  // System prompt → system message
  if (body.system) {
    const text =
      typeof body.system === "string"
        ? body.system
        : (body.system as any[])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
    if (text) messages.push({ role: "system", content: text })
  }

  messages.push(...convertMessages(body.messages ?? []))

  const result: any = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
  }

  if (body.stream !== undefined) result.stream = body.stream
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p
  if (body.stop_sequences) result.stop = body.stop_sequences

  // Tools
  if (body.tools?.length) {
    result.tools = body.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? {},
      },
    }))

    if (body.tool_choice) {
      const tc = body.tool_choice
      if (tc.type === "auto" || tc === "auto") result.tool_choice = "auto"
      else if (tc.type === "any" || tc === "any") result.tool_choice = "required"
      else if (tc.type === "tool")
        result.tool_choice = { type: "function", function: { name: tc.name } }
    }
  }

  return result
}

// ── Response Conversion (OpenAI → Anthropic) ────────────────────────

function mapStopReason(reason: string | null): string {
  switch (reason) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool_calls":
      return "tool_use"
    default:
      return "end_turn"
  }
}

export function openAIToAnthropic(res: any, model: string): any {
  const choice = res.choices?.[0]
  const msg = choice?.message
  const content: any[] = []

  if (msg?.content) {
    content.push({ type: "text", text: msg.content })
  }

  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input = {}
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {}
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  return {
    id: res.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: mapStopReason(choice?.finish_reason ?? null),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  }
}

// ── Streaming Conversion (OpenAI SSE → Anthropic SSE) ───────────────

export function openAIStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  let buffer = ""
  let started = false
  let finished = false

  // Block tracking
  let textBlockIdx: number | null = null // Anthropic index of the text block
  let textBlockClosed = false
  const toolBlockMap = new Map<number, number>() // OpenAI tool index → Anthropic block index
  let nextBlockIdx = 0

  function sse(event: string, data: any): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  function closeOpenBlocks(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (textBlockIdx !== null && !textBlockClosed) {
      controller.enqueue(
        sse("content_block_stop", { type: "content_block_stop", index: textBlockIdx }),
      )
      textBlockClosed = true
    }
    for (const [, idx] of toolBlockMap) {
      controller.enqueue(
        sse("content_block_stop", { type: "content_block_stop", index: idx }),
      )
    }
    toolBlockMap.clear()
  }

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            const payload = line.slice(6).trim()

            if (payload === "[DONE]") {
              if (!finished) {
                closeOpenBlocks(controller)
                controller.enqueue(
                  sse("message_delta", {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: 0 },
                  }),
                )
                finished = true
              }
              controller.enqueue(sse("message_stop", { type: "message_stop" }))
              continue
            }

            let chunk: any
            try {
              chunk = JSON.parse(payload)
            } catch {
              continue
            }

            // Emit message_start on the very first data chunk
            if (!started) {
              controller.enqueue(
                sse("message_start", {
                  type: "message_start",
                  message: {
                    id: chunk.id ?? `msg_${Date.now()}`,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: {
                      input_tokens: chunk.usage?.prompt_tokens ?? 0,
                      output_tokens: 0,
                    },
                  },
                }),
              )
              started = true
            }

            const delta = chunk.choices?.[0]?.delta
            const finishReason = chunk.choices?.[0]?.finish_reason

            // ── Text content ──
            if (delta?.content) {
              if (textBlockIdx === null) {
                textBlockIdx = nextBlockIdx++
                controller.enqueue(
                  sse("content_block_start", {
                    type: "content_block_start",
                    index: textBlockIdx,
                    content_block: { type: "text", text: "" },
                  }),
                )
              }
              controller.enqueue(
                sse("content_block_delta", {
                  type: "content_block_delta",
                  index: textBlockIdx,
                  delta: { type: "text_delta", text: delta.content },
                }),
              )
            }

            // ── Tool calls ──
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const oaiIdx = tc.index ?? 0

                // New tool call (has id + name)
                if (tc.id && tc.function?.name) {
                  // Close text block before first tool
                  if (textBlockIdx !== null && !textBlockClosed) {
                    controller.enqueue(
                      sse("content_block_stop", {
                        type: "content_block_stop",
                        index: textBlockIdx,
                      }),
                    )
                    textBlockClosed = true
                  }
                  const anthropicIdx = nextBlockIdx++
                  toolBlockMap.set(oaiIdx, anthropicIdx)
                  controller.enqueue(
                    sse("content_block_start", {
                      type: "content_block_start",
                      index: anthropicIdx,
                      content_block: {
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input: {},
                      },
                    }),
                  )
                }

                // Argument delta
                if (tc.function?.arguments) {
                  const anthropicIdx = toolBlockMap.get(oaiIdx)
                  if (anthropicIdx !== undefined) {
                    controller.enqueue(
                      sse("content_block_delta", {
                        type: "content_block_delta",
                        index: anthropicIdx,
                        delta: {
                          type: "input_json_delta",
                          partial_json: tc.function.arguments,
                        },
                      }),
                    )
                  }
                }
              }
            }

            // ── Finish reason ──
            if (finishReason && !finished) {
              closeOpenBlocks(controller)
              controller.enqueue(
                sse("message_delta", {
                  type: "message_delta",
                  delta: {
                    stop_reason: mapStopReason(finishReason),
                    stop_sequence: null,
                  },
                  usage: { output_tokens: chunk.usage?.completion_tokens ?? 0 },
                }),
              )
              finished = true
            }
          }
        }
      } finally {
        reader.releaseLock()
        controller.close()
      }
    },
  })
}
