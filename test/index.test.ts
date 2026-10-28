import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentConfig, deploy, headerVar, sipHeaders, sipUri, toolHandler, type VoiceAgentSpec } from '../src/index.ts'

const spec: VoiceAgentSpec = {
  name: 'riotcoder (test)',
  prompt: 'You are riotcoder in room {{sip_gc_room}}.',
  firstMessage: 'riotcoder here.',
  voiceId: 'voice-1',
  skipTurn: 'Stay quiet when nobody spoke to you.',
  variables: { sip_gc_room: '0000' },
  sipNumber: '+14155550100',
  tools: [{ name: 'take_task', description: 'Queue work.', url: 'https://x.test/api/agent-tools/take_task', context: { room: 'sip_gc_room' }, params: { brief: { type: 'string', description: 'What to do', required: true }, ack: { type: 'string', description: 'What you said' } }, headers: { 'x-voice-agent-secret': 's' } }],
}

test('a spec becomes an ElevenLabs config: end_call kept beside the webhook tools, context from dynamic variables', () => {
  const c = agentConfig(spec) as any
  const tools = c.agent.prompt.tools
  assert.deepEqual(tools.map((t: any) => t.name), ['end_call', 'skip_turn', 'take_task'])
  assert.equal(c.agent.prompt.llm, 'claude-sonnet-5-5')
  const hook = tools[2].api_schema
  assert.deepEqual(hook.query_params_schema, { properties: { room: { type: 'string', dynamic_variable: 'sip_gc_room' } }, required: ['room'] })
  assert.deepEqual(hook.request_body_schema.required, ['brief'])
  assert.equal(c.conversation.max_duration_seconds, 3600)
  assert.deepEqual(agentConfig({ ...spec, endCall: false, skipTurn: undefined, tools: [] }).agent, { first_message: 'riotcoder here.', language: 'en', dynamic_variables: { dynamic_variable_placeholders: { sip_gc_room: '0000' } }, prompt: { prompt: spec.prompt, llm: 'claude-sonnet-5-5', temperature: 0.6, tools: [] } })
})

test('SIP names and headers line up with the variables the agent sees', () => {
  assert.equal(sipUri('+14155550100'), 'sip:+14155550100@sip.rtc.elevenlabs.io;transport=tcp')
  const h = sipHeaders('Gc', { room: '4821', asked_by: 'Anthony', empty: '', brief: 'line one\nline two' })
  assert.deepEqual(h, { 'X-Gc-Room': '4821', 'X-Gc-Asked-By': 'Anthony', 'X-Gc-Brief': 'line one line two' })
  assert.deepEqual(Object.keys(h).map(headerVar), ['sip_gc_room', 'sip_gc_asked_by', 'sip_gc_brief'])
})

test('deploy creates once, then updates the same agent, and assigns the SIP number', async () => {
  const calls: string[] = []
  let agents: { agent_id: string; name: string }[] = []
  let numbers: any[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace('https://api.elevenlabs.io', '')
    calls.push(`${init?.method} ${path.split('?')[0]}`)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })
    if (path.startsWith('/v1/convai/agents?')) return ok({ agents })
    if (path === '/v1/convai/agents/create') {
      agents = [{ agent_id: 'ag_1', name: body.name }]
      return ok({ agent_id: 'ag_1' })
    }
    if (path === '/v1/convai/phone-numbers' && init?.method === 'GET') return ok(numbers)
    if (path === '/v1/convai/phone-numbers') {
      numbers = [{ phone_number: body.phone_number, phone_number_id: 'pn_1', provider: 'sip_trunk', assigned_agent: null }]
      return ok({ phone_number_id: 'pn_1' })
    }
    if (path === '/v1/convai/phone-numbers/pn_1') {
      numbers[0].assigned_agent = { agent_id: body.agent_id }
      return ok({})
    }
    return ok({})
  }) as unknown as typeof globalThis.fetch
  const first = await deploy(spec, { apiKey: 'k', fetch })
  assert.deepEqual(first, { agentId: 'ag_1', created: true, sip: 'sip:+14155550100@sip.rtc.elevenlabs.io;transport=tcp', phoneNumberId: 'pn_1' })
  const second = await deploy(spec, { apiKey: 'k', fetch })
  assert.equal(second.created, false)
  assert.deepEqual(calls, [
    'GET /v1/convai/agents',
    'POST /v1/convai/agents/create',
    'GET /v1/convai/phone-numbers',
    'POST /v1/convai/phone-numbers',
    'PATCH /v1/convai/phone-numbers/pn_1',
    'GET /v1/convai/agents',
    'PATCH /v1/convai/agents/ag_1',
    'GET /v1/convai/phone-numbers',
  ])
})

test('the tool handler checks the secret, runs the tool with its context, and turns a throw into words', async () => {
  const handle = toolHandler({
    basePath: '/api/agent-tools/',
    secret: 's3cret',
    tools: {
      take_task: (args, call) => ({ queued: args.brief, room: call.context.room }),
      call_in: () => {
        throw new Error('only Anthony can have me call people in')
      },
    },
  })
  const req = (path: string, secret = 's3cret', body: unknown = {}) => new Request(`https://x.test${path}`, { method: 'POST', headers: { 'x-voice-agent-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal(await handle(new Request('https://x.test/elsewhere')), null)
  assert.equal((await handle(req('/api/agent-tools/take_task', 'nope')))!.status, 401)
  assert.equal((await handle(req('/api/agent-tools/toString')))!.status, 404)
  assert.deepEqual(await (await handle(req('/api/agent-tools/take_task?room=4821', 's3cret', { brief: 'fix the footer' })))!.json(), { queued: 'fix the footer', room: '4821' })
  assert.deepEqual(await (await handle(req('/api/agent-tools/call_in')))!.json(), { ok: false, error: 'only Anthony can have me call people in' })
})
