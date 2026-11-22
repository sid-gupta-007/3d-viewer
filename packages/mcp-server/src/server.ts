import readline from 'node:readline'
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from './tools.ts'

export const SERVER_INFO = {
  name: 'forge-3d-mcp',
  version: '0.1.0',
} as const

export const SUPPORTED_PROTOCOL_VERSION = '2024-11-05'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export function createErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data !== undefined ? { code, message, data } : { code, message },
  }
}

export async function handleJsonRpcMessage(
  raw: unknown,
  ctx: ToolContext
): Promise<JsonRpcResponse | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createErrorResponse(null, -32600, 'Invalid Request')
  }

  const msg = raw as Partial<JsonRpcRequest>
  const hasId = msg.id !== undefined && msg.id !== null
  const id = hasId ? (msg.id as string | number) : null

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return createErrorResponse(id, -32600, 'Invalid JSON-RPC 2.0 request')
  }

  // Notifications have no id and expect no response.
  if (!hasId) {
    return null
  }

  switch (msg.method) {
    case 'initialize': {
      const params =
        msg.params && typeof msg.params === 'object'
          ? (msg.params as Record<string, unknown>)
          : {}
      const clientVersion =
        typeof params.protocolVersion === 'string'
          ? params.protocolVersion
          : SUPPORTED_PROTOCOL_VERSION

      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: clientVersion || SUPPORTED_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        },
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOL_DEFINITIONS,
        },
      }

    case 'tools/call': {
      const params =
        msg.params && typeof msg.params === 'object'
          ? (msg.params as Record<string, unknown>)
          : null
      if (!params || typeof params.name !== 'string') {
        return createErrorResponse(id, -32602, 'Invalid params: missing tool name')
      }
      const known = TOOL_DEFINITIONS.some((t) => t.name === params.name)
      if (!known) {
        return createErrorResponse(id, -32602, `Unknown tool: ${params.name}`)
      }

      try {
        const result = await executeTool(params.name, params.arguments, ctx)
        return { jsonrpc: '2.0', id, result }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: message }],
            isError: true,
          },
        }
      }
    }

    default:
      return createErrorResponse(id, -32601, `Method not found: ${msg.method}`)
  }
}

export function startStdioServer(
  ctx: ToolContext,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): readline.Interface {
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  })

  const writeResponse = (res: JsonRpcResponse) => {
    output.write(`${JSON.stringify(res)}\n`)
  }

  let queue = Promise.resolve()

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    queue = queue.then(async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        writeResponse(createErrorResponse(null, -32700, `Parse error: ${message}`))
        return
      }
      const response = await handleJsonRpcMessage(parsed, ctx)
      if (response) {
        writeResponse(response)
      }
    })
  })

  return rl
}
