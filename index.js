#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8766'
const ASK_TIMEOUT_MS = parseInt(process.env.ASK_TIMEOUT_MS || '120000', 10)
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

function log(...args) {
  // MCP uses stdout for protocol — all logging MUST go to stderr
  console.error('[one-editor-mcp]', ...args)
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options)
      return res
    } catch (err) {
      if (attempt === retries) throw err
      log(`Fetch attempt ${attempt}/${retries} failed: ${err.message}. Retrying in ${RETRY_DELAY_MS}ms...`)
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt))
    }
  }
}

async function askUser(question, options) {
  const questionId = 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
  log('Asking user:', questionId, question)
  if (options && options.length > 0) {
    log('Options:', options.join(', '))
  }

  try {
    // POST to bridge — this will BLOCK until user answers (long-poll)
    const res = await fetchWithRetry(`${BRIDGE_URL}/mcp/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId, question, options: options || [] }),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error')
      log('Bridge returned error:', res.status, text)
      return { error: true, message: `Bridge error (${res.status}): ${text}` }
    }

    const data = await res.json()
    if (!data.answer && data.answer !== '') {
      log('Bridge returned response with no answer field:', JSON.stringify(data))
      return { error: true, message: 'The user response was empty. Try asking the question again.' }
    }
    log('User answered:', data.answer)
    return { error: false, answer: data.answer }
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      log('Timeout waiting for user answer')
      return { error: true, message: 'The user did not respond in time. You may continue without their input or try asking again.' }
    }
    log('Error asking user:', err.message)
    return { error: true, message: `Failed to reach user: ${err.message}` }
  }
}

// --- MCP Server Setup ---

const server = new Server(
  { name: 'one-editor-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ask_user',
      description: [
        'Ask the user a question and wait for their response via the One Editor web interface.',
        'Use this when you need clarification, want the user to choose between options,',
        'or need any kind of user input before proceeding.',
        'The question will be displayed in the chat UI and the user can pick an option or type a free-text answer.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask the user. Be clear and concise.'
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of choices. If provided, the user picks one. If omitted, the user types a free-text answer.'
          }
        },
        required: ['question']
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name !== 'ask_user') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    }
  }

  const question = args?.question
  if (!question || typeof question !== 'string') {
    return {
      content: [{ type: 'text', text: 'Error: "question" parameter is required and must be a string.' }],
      isError: true,
    }
  }

  const options = Array.isArray(args?.options) ? args.options.filter(o => typeof o === 'string') : []

  const result = await askUser(question, options)

  if (result.error) {
    return {
      content: [{ type: 'text', text: result.message }],
      isError: true,
    }
  }

  return {
    content: [{ type: 'text', text: `The user responded: ${result.answer}` }],
  }
})

// --- Graceful Shutdown ---

function shutdown() {
  log('Shutting down...')
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// --- Start ---

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('Ready. Bridge URL:', BRIDGE_URL)
}

main().catch(err => {
  log('Fatal error:', err.message)
  log(err.stack)
  process.exit(1)
})
