# copilot-openrouter-api

A lightweight local proxy server that exposes GitHub Copilot as an **OpenAI-compatible API**. Use your Copilot subscription with any tool or SDK that speaks the OpenAI protocol -- OpenAI SDK, OpenRouter SDK, LangChain, LiteLLM, Cursor, or anything else that can point at a custom base URL.

```
┌──────────────────────┐         ┌──────────────────────┐         ┌──────────────────────┐
│   Any OpenAI Client  │ ──────► │   copilot-openrouter  │ ──────► │  GitHub Copilot API  │
│  (SDK, curl, app)    │ ◄────── │   -api (localhost)    │ ◄────── │                      │
└──────────────────────┘         └──────────────────────┘         └──────────────────────┘
```

## Quickstart TLDR

```bash
git clone https://github.com/0xInuarashi/copilot-openrouter-api.git
cd copilot-openrouter-api && bun install
```

```bash
bun run login    # opens GitHub in your browser, approve it, done
bun run serve    # proxy is live on localhost:8080
```

Set these two env vars and use any OpenAI-compatible client:

```bash
export OPENAI_API_KEY="<key printed by login>"
export OPENAI_BASE_URL="http://localhost:8080/v1"
```

That's it. Everything below is details.

---

## Table of Contents

- [Quickstart TLDR](#quickstart-tldr)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Authentication](#authentication)
  - [GitHub.com](#githubcom)
  - [GitHub Enterprise](#github-enterprise)
  - [Re-authenticating](#re-authenticating)
- [Starting the Server](#starting-the-server)
- [Usage Guide](#usage-guide)
  - [OpenAI Python SDK](#openai-python-sdk)
  - [OpenAI Node.js SDK](#openai-nodejs-sdk)
  - [OpenRouter SDK](#openrouter-sdk)
  - [cURL](#curl)
  - [Streaming](#streaming)
  - [Vision (Image Inputs)](#vision-image-inputs)
  - [Tool Calling / Function Calling](#tool-calling--function-calling)
- [API Reference](#api-reference)
  - [Endpoints](#endpoints)
  - [Authentication](#api-authentication)
  - [Error Responses](#error-responses)
- [Available Models](#available-models)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Logging](#logging)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

- **OpenAI-compatible API** -- drop-in replacement for any client that targets the OpenAI API
- **Streaming & JSON** -- full support for both SSE streaming and standard JSON responses
- **Vision support** -- automatically detects image content and sets the required Copilot headers
- **Tool / function calling** -- normalizes Copilot's multi-choice responses into a single merged choice for SDK compatibility
- **Model discovery** -- dynamically fetches the list of available Copilot models from [models.dev](https://models.dev)
- **GitHub Enterprise** -- works with GitHub Enterprise Server and GitHub Enterprise Cloud
- **Local API key** -- generates a random key so only you can access your proxy
- **Detailed logging** -- request/response traces with latency, token usage, and redacted headers
- **Zero config files** -- authenticate once, run forever

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Bun** (v1.0+) | JavaScript/TypeScript runtime. Install from [bun.sh](https://bun.sh). |
| **GitHub account with Copilot** | Any Copilot plan (Individual, Business, or Enterprise). |
| **Git** | To clone the repository. |

---

## Installation

```bash
# Clone the repository
git clone https://github.com/0xInuarashi/copilot-openrouter-api.git

# Enter the directory
cd copilot-openrouter-api

# Install dependencies
bun install
```

That's it -- no build step required. Bun runs TypeScript directly.

---

## Quick Start

```bash
# 1. Authenticate with GitHub
bun run login

# 2. Follow the on-screen instructions:
#    - Open the URL shown in your browser
#    - Enter the one-time code
#    - Authorize the app

# 3. Start the proxy
bun run serve

# 4. In another terminal, use it like any OpenAI API:
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

The API key is printed during `bun run login` and also shown when the server starts. Copy it from either output.

---

## Authentication

### GitHub.com

```bash
bun run login
```

This starts the [GitHub Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow):

1. A verification URL and one-time code are displayed.
2. Open the URL in your browser and enter the code.
3. Approve the authorization request.
4. The CLI stores your token and generates a local API key.

```
==================================================
  Open:  https://github.com/login/device
  Code:  ABCD-1234
==================================================

Waiting for authorization...
Authenticated successfully!

Token stored in: ~/.config/copilot-claude-api/auth.json

Your local API key (use this with OpenAI SDK):

  sk-copilot-a1b2c3d4e5f6...

Start the server with: bun run serve
```

### GitHub Enterprise

Pass your enterprise instance URL with `--enterprise`:

```bash
bun run login -- --enterprise https://github.example.com
```

The proxy will automatically use the correct Copilot API endpoint for your enterprise domain (`https://copilot-api.<domain>`).

### Re-authenticating

Simply run `bun run login` again. The old credentials at `~/.config/copilot-claude-api/auth.json` will be overwritten. A new local API key is generated each time.

---

## Starting the Server

```bash
# Default port (8080)
bun run serve

# Custom port
bun run serve -- --port 3000
```

On startup, the server prints the environment variables you need:

```
copilot-claude-api server running on http://localhost:8080

Use with OpenAI SDK:
  export OPENAI_API_KEY="sk-copilot-..."
  export OPENAI_BASE_URL="http://localhost:8080/v1"

Use with OpenRouter SDK:
  export OPENROUTER_API_KEY="sk-copilot-..."
  export OPENROUTER_BASE_URL="http://localhost:8080/api/v1"
```

---

## Usage Guide

### OpenAI Python SDK

```bash
pip install openai
```

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-copilot-...",         # Your local API key
    base_url="http://localhost:8080/v1"
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Explain quantum computing in simple terms."}
    ]
)

print(response.choices[0].message.content)
```

Or use environment variables so you don't hardcode anything:

```bash
export OPENAI_API_KEY="sk-copilot-..."
export OPENAI_BASE_URL="http://localhost:8080/v1"
```

```python
from openai import OpenAI

client = OpenAI()  # Picks up env vars automatically
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

### OpenAI Node.js SDK

```bash
npm install openai
```

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-copilot-...",
  baseURL: "http://localhost:8080/v1",
});

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);
```

### OpenRouter SDK

The proxy also mounts routes at `/api/v1/*` for OpenRouter compatibility:

```bash
export OPENROUTER_API_KEY="sk-copilot-..."
export OPENROUTER_BASE_URL="http://localhost:8080/api/v1"
```

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-copilot-...",
    base_url="http://localhost:8080/api/v1"
)

response = client.chat.completions.create(
    model="claude-3.5-sonnet",
    messages=[{"role": "user", "content": "Hello from OpenRouter!"}]
)
```

### cURL

```bash
# Non-streaming
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-copilot-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'

# List available models (no auth required)
curl http://localhost:8080/v1/models
```

### Streaming

Set `"stream": true` in your request body. The proxy passes through Copilot's SSE stream directly:

```python
stream = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Write a short poem."}],
    stream=True
)

for chunk in stream:
    content = chunk.choices[0].delta.content
    if content:
        print(content, end="", flush=True)
```

### Vision (Image Inputs)

The proxy auto-detects image content and adds the `Copilot-Vision-Request: true` header:

```python
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "What's in this image?"},
                {
                    "type": "image_url",
                    "image_url": {"url": "https://example.com/photo.jpg"}
                }
            ]
        }
    ]
)
```

### Tool Calling / Function Calling

Works the same as the standard OpenAI API. The proxy normalizes Copilot's response format so that tool calls appear correctly in `choices[0]`:

```python
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "City name"}
                },
                "required": ["location"]
            }
        }
    }
]

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "What's the weather in Tokyo?"}],
    tools=tools
)

tool_call = response.choices[0].message.tool_calls[0]
print(tool_call.function.name, tool_call.function.arguments)
```

> **Note:** GitHub Copilot sometimes returns tool calls and text content in separate choices. The proxy automatically merges them into a single choice so standard SDK agentic loops work correctly.

---

## API Reference

### Endpoints

All endpoints are available under both `/v1` and `/api/v1` prefixes.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | No | Health check -- returns service status and endpoint list |
| `GET` | `/v1/models` | No | List all available Copilot models |
| `GET` | `/v1/models/:id` | No | Get a specific model by ID |
| `POST` | `/v1/chat/completions` | Yes | Chat completion (OpenAI-compatible) |
| `POST` | `/v1/responses` | Yes | Responses endpoint (Copilot-specific) |

### API Authentication

Protected endpoints require a Bearer token in the `Authorization` header:

```
Authorization: Bearer sk-copilot-...
```

This is the local API key generated during `bun run login` -- it is **not** your GitHub token. It only protects access to your local proxy.

### Error Responses

Errors follow the OpenAI format:

```json
{
  "error": {
    "message": "Missing Authorization header. Use: Authorization: Bearer <your-api-key>",
    "type": "invalid_request_error",
    "code": "missing_api_key"
  }
}
```

| Status | Code | Meaning |
|--------|------|---------|
| 401 | `missing_api_key` | No `Authorization` header provided |
| 401 | `invalid_api_key` | API key doesn't match |
| 404 | `model_not_found` | Requested model ID doesn't exist |

---

## Available Models

The proxy fetches the list of models available through GitHub Copilot from the [models.dev](https://models.dev) registry. The list is cached and refreshed every hour.

Query available models at any time:

```bash
curl -s http://localhost:8080/v1/models | jq '.data[].id'
```

Models are returned in the standard OpenAI format with `owned_by: "github-copilot"`.

---

## Architecture

```
src/
├── index.ts    CLI entry point -- parses commands (login, serve) and flags
├── auth.ts     GitHub OAuth Device Flow -- login, token storage, domain handling
├── server.ts   Hono HTTP server -- routing, CORS, logging middleware, API key auth
├── proxy.ts    Request forwarding -- header translation, streaming, response normalization
└── models.ts   Model registry -- fetches and caches models from models.dev
```

**Request lifecycle:**

1. Client sends an OpenAI-format request to the proxy
2. `server.ts` validates the API key and logs the request
3. `proxy.ts` translates headers for the Copilot API (intent, vision, initiator)
4. The request is forwarded to `api.githubcopilot.com` (or your enterprise endpoint)
5. The response is normalized (multi-choice merging) and returned to the client

---

## Configuration

| Setting | Default | How to Change |
|---------|---------|---------------|
| Server port | `8080` | `bun run serve -- --port <number>` |
| GitHub domain | `github.com` | `bun run login -- --enterprise <url>` |
| Auth storage | `~/.config/copilot-claude-api/auth.json` | Not configurable |
| Model cache TTL | 1 hour | Not configurable |

There are no environment variables or config files to manage. Everything is handled through CLI flags and the stored auth file.

---

## Logging

The server logs every request with detailed traces:

```
[2025-02-20T10:15:30.123Z] ──────────────────────────────────────
[2025-02-20T10:15:30.123Z] #5 ► INCOMING REQUEST
[2025-02-20T10:15:30.123Z] #5   POST /v1/chat/completions
[2025-02-20T10:15:30.123Z] #5   Headers: { ... }
[2025-02-20T10:15:30.123Z] #5     ▶ PROXY REQUEST TO PROVIDER
[2025-02-20T10:15:30.123Z] #5       POST https://api.githubcopilot.com/chat/completions
[2025-02-20T10:15:30.456Z] #5     ◀ PROVIDER RESPONSE
[2025-02-20T10:15:30.456Z] #5       Status: 200 OK
[2025-02-20T10:15:30.456Z] #5       Latency: 333.2ms
[2025-02-20T10:15:30.456Z] #5       Tokens: 150 total (100 prompt + 50 completion)
[2025-02-20T10:15:30.456Z] #5 ◄ RESPONSE TO CLIENT
[2025-02-20T10:15:30.456Z] #5   Status: 200
[2025-02-20T10:15:30.456Z] #5   Duration: 333.2ms
[2025-02-20T10:15:30.456Z] ──────────────────────────────────────
```

- Each request gets a unique `#id` for tracing
- Authorization tokens are redacted in log output
- Request/response bodies are truncated at 2000 characters

---

## Security

- **Token storage** -- GitHub OAuth tokens are stored at `~/.config/copilot-claude-api/auth.json` with `0600` permissions (owner read/write only).
- **Local API key** -- A random `sk-copilot-*` key is generated locally to protect the proxy. It is never sent to GitHub.
- **Header redaction** -- Auth headers are masked in all log output.
- **Local-only** -- The server binds to `localhost`. It is intended for local use only; do not expose it to the internet.
- **CORS** -- Enabled for all origins (appropriate for a local development proxy).

---

## Troubleshooting

**"Not authenticated. Run `bun run login` first."**
You haven't logged in yet, or the auth file was deleted. Run `bun run login`.

**"Invalid API key."**
The API key changes every time you run `bun run login`. Make sure you're using the key from the most recent login. Check the server startup output for the current key.

**Connection refused on port 8080**
Make sure `bun run serve` is running in another terminal. Check that nothing else is using port 8080, or pick a different port with `--port`.

**Models endpoint returns an empty list**
The proxy fetches models from [models.dev](https://models.dev). If the fetch fails (network issue, timeout), it falls back to the last cached result. Check your internet connection.

**Streaming responses seem broken**
Ensure your client is correctly handling SSE (Server-Sent Events). The proxy passes Copilot's stream through without modification.

**GitHub Enterprise not working**
Make sure you passed the full URL during login: `bun run login -- --enterprise https://github.example.com`. The domain is extracted and used to build the API endpoint (`https://copilot-api.<domain>`).

---

## License

See the repository for license information.
