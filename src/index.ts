/**
 * @profullstack/voice-agent: a phone voice agent that holds a real conversation,
 * defined once in code and run on ElevenLabs Conversational AI.
 *
 * Describe the agent (who it is, its voice, its model, the tools it may call),
 * `deploy()` it, and dial its SIP address into any call: a Telnyx conference, a
 * group.call room, a party line. ElevenLabs does the listening, turn-taking,
 * interruptions and speech; the model does the thinking; your server does the
 * work, through webhook tools that `toolHandler()` answers.
 *
 * Per-call context rides in as SIP X- headers on the INVITE: `X-Gc-Room: 4821`
 * arrives as the dynamic variable `{{sip_gc_room}}` (see `headerVar`), usable
 * in the prompt, the first message and tool parameters.
 */

/** ElevenLabs' SIP endpoint for inbound calls to an agent. */
export const SIP_HOST = 'sip.rtc.elevenlabs.io'

/** The SIP address that reaches the agent a number is assigned to. */
export const sipUri = (phone: string) => `sip:${phone}@${SIP_HOST};transport=tcp`

/** The dynamic variable an X- header on the INVITE becomes: X-Gc-Room -> sip_gc_room. */
export const headerVar = (header: string) => `sip_${header.replace(/^x-/i, '').toLowerCase().replace(/-/g, '_')}`

/** One parameter the model fills in when it calls a tool. */
export type ToolParam = { type: 'string' | 'number' | 'integer' | 'boolean'; description: string; required?: boolean; enum?: string[] }

/**
 * A tool the agent calls on your server. `params` are filled by the model and sent
 * as the JSON body; `context` are query parameters filled from dynamic variables
 * (`{ room: 'sip_gc_room' }`), so which call it is never depends on the model.
 */
export type WebhookTool = {
  name: string
  description: string
  url: string
  params?: Record<string, ToolParam>
  context?: Record<string, string>
  headers?: Record<string, string>
  timeoutSecs?: number
}

export type VoiceAgentSpec = {
  /** The agent's name on ElevenLabs; also how deploy() finds it again. */
  name: string
  /** The system prompt. {{variables}} are filled per call. */
  prompt: string
  /** What it says on answer; '' lets the other side speak first. */
  firstMessage: string
  voiceId: string
  /** Default claude-sonnet-5-5. */
  llm?: string
  temperature?: number
  language?: string
  /** Default eleven_flash_v2 (the fastest English voice model). */
  ttsModel?: string
  tools?: WebhookTool[]
  /** When it may hang up; false leaves end_call out (it then never hangs up itself). */
  endCall?: string | false
  /** When it should stay silent for a turn (a group call where it was not addressed); unset leaves skip_turn out. */
  skipTurn?: string
  /** Placeholder values for every dynamic variable the prompt uses, for test calls without headers. */
  variables?: Record<string, string>
  /** Seconds of the other side's silence before the agent speaks again. */
  turnTimeout?: number
  /** Seconds of silence before the agent hangs up (-1 never). */
  silenceEndCallSecs?: number
  /** Longest call, seconds: 60 to 7200. */
  maxDurationSecs?: number
  /** The E.164 number that identifies it on SIP. Any number you control; nothing is bought or ported. */
  sipNumber?: string
}

/** The ElevenLabs conversation_config for a spec: what create and update send. */
export function agentConfig(spec: VoiceAgentSpec): Record<string, unknown> {
  const tools: unknown[] = []
  // System tools share this list with webhook tools: leaving end_call out of an update deletes it.
  if (spec.endCall !== false) tools.push({ type: 'system', name: 'end_call', description: spec.endCall ?? 'End the call when the conversation is over or you are asked to leave.', params: { system_tool_type: 'end_call' } })
  if (spec.skipTurn) tools.push({ type: 'system', name: 'skip_turn', description: spec.skipTurn, params: { system_tool_type: 'skip_turn' } })
  for (const t of spec.tools ?? []) {
    const params = Object.entries(t.params ?? {})
    const context = Object.entries(t.context ?? {})
    tools.push({
      type: 'webhook',
      name: t.name,
      description: t.description,
      response_timeout_secs: t.timeoutSecs ?? 20,
      api_schema: {
        url: t.url,
        // ElevenLabs refuses a POST without a body schema: a tool with no parameters is a GET.
        method: params.length ? 'POST' : 'GET',
        ...(context.length ? { query_params_schema: { properties: Object.fromEntries(context.map(([k, v]) => [k, { type: 'string', dynamic_variable: v }])), required: context.map(([k]) => k) } } : {}),
        ...(params.length
          ? {
              request_body_schema: {
                type: 'object',
                description: t.description,
                properties: Object.fromEntries(params.map(([k, p]) => [k, { type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}) }])),
                required: params.filter(([, p]) => p.required).map(([k]) => k),
              },
            }
          : {}),
        ...(t.headers ? { request_headers: t.headers } : {}),
      },
    })
  }
  return {
    agent: {
      first_message: spec.firstMessage,
      language: spec.language ?? 'en',
      ...(spec.variables ? { dynamic_variables: { dynamic_variable_placeholders: spec.variables } } : {}),
      prompt: { prompt: spec.prompt, llm: spec.llm ?? 'claude-sonnet-5-5', temperature: spec.temperature ?? 0.6, tools },
    },
    tts: { voice_id: spec.voiceId, model_id: spec.ttsModel ?? 'eleven_flash_v2' },
    turn: { turn_timeout: spec.turnTimeout ?? 7, silence_end_call_timeout: spec.silenceEndCallSecs ?? -1 },
    conversation: { max_duration_seconds: Math.min(7200, Math.max(60, spec.maxDurationSecs ?? 3600)) },
  }
}

export class VoiceAgentError extends Error {
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.status = status
  }
}

export type Deployed = { agentId: string; created: boolean; sip: string | null; phoneNumberId: string | null }

/** The parts of the ElevenLabs API a voice agent needs. */
export class ElevenLabs {
  private readonly key: string
  private readonly base: string
  private readonly doFetch: typeof fetch

  constructor(opts: { apiKey: string; base?: string; fetch?: typeof fetch }) {
    if (!opts.apiKey) throw new VoiceAgentError('an ElevenLabs API key is needed')
    this.key = opts.apiKey
    this.base = (opts.base ?? 'https://api.elevenlabs.io').replace(/\/+$/, '')
    this.doFetch = opts.fetch ?? fetch
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method,
      headers: { 'xi-api-key': this.key, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    // A 422 echoes the request back, tool headers and their secrets included: never let those into a log.
    if (!res.ok) throw new VoiceAgentError(`ElevenLabs ${method} ${path}: ${res.status} ${redact(text).slice(0, 800)}`, res.status)
    return (text ? JSON.parse(text) : {}) as T
  }

  /** The agent with exactly this name, if there is one. */
  async findAgent(name: string): Promise<{ agent_id: string; name: string } | null> {
    const r = await this.call<{ agents?: { agent_id: string; name: string }[] }>('GET', `/v1/convai/agents?search=${encodeURIComponent(name)}&page_size=100`)
    return r.agents?.find((a) => a.name === name) ?? null
  }

  /** Create the agent, or bring the one with its name (or `agentId`) up to the spec. */
  async syncAgent(spec: VoiceAgentSpec, agentId?: string): Promise<{ agentId: string; created: boolean }> {
    const id = agentId ?? (await this.findAgent(spec.name))?.agent_id
    const body = { name: spec.name, conversation_config: agentConfig(spec) }
    if (id) {
      await this.call('PATCH', `/v1/convai/agents/${encodeURIComponent(id)}`, body)
      return { agentId: id, created: false }
    }
    const r = await this.call<{ agent_id: string }>('POST', '/v1/convai/agents/create', body)
    return { agentId: r.agent_id, created: true }
  }

  /**
   * Give the agent a SIP identity: import `phone` as a SIP-trunk number (once) and
   * assign it, so calls to sipUri(phone) reach this agent.
   */
  async ensureSipNumber(phone: string, agentId: string, label: string): Promise<{ phoneNumberId: string; sip: string }> {
    const list = await this.call<{ phone_number: string; phone_number_id: string; provider: string; assigned_agent?: { agent_id?: string } | null }[]>('GET', '/v1/convai/phone-numbers')
    let found = list.find((p) => p.phone_number === phone)
    if (found && found.provider !== 'sip_trunk') throw new VoiceAgentError(`${phone} is on ElevenLabs as a ${found.provider} number, not SIP`)
    if (!found) {
      const r = await this.call<{ phone_number_id: string }>('POST', '/v1/convai/phone-numbers', { provider: 'sip_trunk', phone_number: phone, label, inbound_trunk_config: { media_encryption: 'allowed' } })
      found = { phone_number: phone, phone_number_id: r.phone_number_id, provider: 'sip_trunk' }
    }
    if (found.assigned_agent?.agent_id !== agentId) await this.call('PATCH', `/v1/convai/phone-numbers/${encodeURIComponent(found.phone_number_id)}`, { agent_id: agentId })
    return { phoneNumberId: found.phone_number_id, sip: sipUri(phone) }
  }

  /** The agent's latest conversations, newest first (status, duration, why it ended). */
  async conversations(agentId: string, size = 10): Promise<Record<string, unknown>[]> {
    const r = await this.call<{ conversations?: Record<string, unknown>[] }>('GET', `/v1/convai/conversations?agent_id=${encodeURIComponent(agentId)}&page_size=${size}`)
    return r.conversations ?? []
  }
}

/** Create or update the agent, and give it its SIP number when the spec has one. */
export async function deploy(spec: VoiceAgentSpec, opts: { apiKey: string; agentId?: string; fetch?: typeof fetch; base?: string }): Promise<Deployed> {
  const api = new ElevenLabs(opts)
  const { agentId, created } = await api.syncAgent(spec, opts.agentId)
  if (!spec.sipNumber) return { agentId, created, sip: null, phoneNumberId: null }
  const n = await api.ensureSipNumber(spec.sipNumber, agentId, `${spec.name} (SIP)`)
  return { agentId, created, sip: n.sip, phoneNumberId: n.phoneNumberId }
}

/** What a tool function gets besides its arguments: the query context and the request. */
export type ToolCall = { tool: string; context: Record<string, string>; request: Request }

export type ToolFn = (args: Record<string, unknown>, call: ToolCall) => unknown | Promise<unknown>

/**
 * Answer an agent's webhook tools. Mount it on any fetch-style server:
 * `toolHandler({ basePath: '/api/agent-tools', secret, tools: { room_status: ... } })`
 * answers POST /api/agent-tools/<tool>, checks the shared secret header, and returns
 * what the function returns as JSON. A thrown Error becomes { ok: false, error } with
 * 200, so the agent hears why and can say so. Requests outside basePath return null.
 */
export function toolHandler(opts: { basePath: string; secret: string; header?: string; tools: Record<string, ToolFn>; log?: (line: string) => void }): (request: Request) => Promise<Response | null> {
  const base = opts.basePath.replace(/\/+$/, '')
  const header = opts.header ?? 'x-voice-agent-secret'
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  return async (request) => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(`${base}/`)) return null
    if (!opts.secret || !sameString(request.headers.get(header) ?? '', opts.secret)) return json({ error: 'unauthorized' }, 401)
    if (request.method !== 'POST' && request.method !== 'GET') return json({ error: 'GET or POST' }, 405)
    const tool = url.pathname.slice(base.length + 1)
    const fn = Object.hasOwn(opts.tools, tool) ? opts.tools[tool] : undefined
    if (!fn) return json({ error: `no tool ${tool}` }, 404)
    const args = (request.method === 'POST' ? ((await request.json().catch(() => ({}))) ?? {}) : {}) as Record<string, unknown>
    const context = Object.fromEntries(url.searchParams)
    try {
      const result = await fn(args, { tool, context, request })
      opts.log?.(`voice-agent tool ${tool} ${JSON.stringify(context)} ok`)
      return json(result ?? { ok: true })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      opts.log?.(`voice-agent tool ${tool} ${JSON.stringify(context)} failed: ${error}`)
      return json({ ok: false, error })
    }
  }
}

/** Values of secret-looking JSON keys (and every request_headers value) blanked out. */
export function redact(text: string): string {
  return text
    .replace(/("[^"]*(?:secret|key|token|authorization|password)[^"]*"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/("request_headers"\s*:\s*\{)[^}]*\}/g, '$1"***":"***"}')
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * X- headers for a SIP INVITE from plain names, each one line and short:
 * sipHeaders('Gc', { room: '4821', asked_by: 'Anthony' }) -> { 'X-Gc-Room': '4821', 'X-Gc-Asked-By': 'Anthony' },
 * which the agent sees as {{sip_gc_room}} and {{sip_gc_asked_by}}.
 */
export function sipHeaders(prefix: string, values: Record<string, string | number | undefined | null>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '') continue
    const name = `X-${prefix}-${k
      .split(/[_-]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('-')}`
    out[name] = String(v).replace(/[\r\n]+/g, ' ').slice(0, 900)
  }
  return out
}
