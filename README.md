# @profullstack/voice-agent

Phone voice agents that hold a real conversation. Define one in code: who it is,
its voice, its model, the tools it may call. `deploy()` it to ElevenLabs
Conversational AI with a SIP address, dial that address into any call (a Telnyx
conference, a group.call room, a party line), and answer its tools from your own
server.

ElevenLabs does the listening, turn-taking, interruptions and speech. The model
(Claude Sonnet by default) does the thinking. Your server does the work.

This is the brain behind group.call's agents (riotcoder, cha0spunk) and the Off
The Record podcast host.

```sh
npm i @profullstack/voice-agent
```

## Define and deploy

```ts
import { deploy, sipHeaders } from '@profullstack/voice-agent'

const riotcoder = {
  name: 'riotcoder (group.call)',
  voiceId: 'iP95p4xoKVk53GoZ742B', // Chris
  prompt: 'You are riotcoder on a group call in room {{sip_gc_room}}. Asked by {{sip_gc_asked_by}}. ...',
  firstMessage: 'riotcoder here.',
  skipTurn: 'Stay silent this turn: the people are talking to each other, not to you.',
  variables: { sip_gc_room: '0000', sip_gc_asked_by: 'someone' },
  sipNumber: '+14155550100', // any number you control; it only names the agent on SIP
  tools: [
    {
      name: 'take_task',
      description: 'Queue work you were asked to do after the call.',
      url: 'https://example.com/api/agent-tools/take_task',
      context: { room: 'sip_gc_room' }, // filled from the call, never by the model
      params: { brief: { type: 'string', description: 'Everything that was asked', required: true } },
      headers: { 'x-voice-agent-secret': process.env.TOOL_SECRET! },
    },
  ],
}

const { agentId, sip } = await deploy(riotcoder, { apiKey: process.env.ELEVENLABS_API_KEY! })
// sip = 'sip:+14155550100@sip.rtc.elevenlabs.io;transport=tcp'
```

Or from the terminal, with a module whose default export is a spec or a list:

```sh
ELEVENLABS_API_KEY=... npx @profullstack/voice-agent deploy ./agents.mjs
ELEVENLABS_API_KEY=... npx @profullstack/voice-agent conversations <agent_id>
```

`deploy` finds the agent by name, so running it again updates the same agent.

## Dial it in

Place a call to the SIP address with your telephony API. X- headers on the INVITE
become dynamic variables: `sipHeaders('Gc', { room: '4821', asked_by: 'Anthony' })`
gives `X-Gc-Room` and `X-Gc-Asked-By`, which the agent sees as `{{sip_gc_room}}` and
`{{sip_gc_asked_by}}`.

```ts
// Telnyx Call Control
await fetch('https://api.telnyx.com/v2/calls', {
  method: 'POST',
  headers: { authorization: `Bearer ${TELNYX_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ to: sip, from: '+15106169327', connection_id, custom_headers: Object.entries(sipHeaders('Gc', { room: '4821' })).map(([name, value]) => ({ name, value })) }),
})
```

## Answer its tools

```ts
import { toolHandler } from '@profullstack/voice-agent'

const tools = toolHandler({
  basePath: '/api/agent-tools',
  secret: process.env.TOOL_SECRET!,
  tools: {
    take_task: async ({ brief }, { context }) => ({ queued: true, room: context.room }),
  },
})
// in any fetch-style server: (await tools(request)) ?? next()
```

A tool that throws answers `{ ok: false, error }` with a 200, so the agent hears the
reason and can say it out loud ("only Anthony can have me do that").

## Gotchas this handles

- System tools (end_call, skip_turn) live in the same list as webhook tools: an update
  that sends only webhook tools deletes end_call and the agent can never hang up.
- `max_duration_seconds` must be 60 to 7200.
- A SIP-trunk number on ElevenLabs is only an identifier: nothing is bought or ported.

MIT
