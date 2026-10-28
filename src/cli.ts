#!/usr/bin/env node
/**
 * voice-agent: deploy a spec to ElevenLabs and look at its calls.
 *
 *   ELEVENLABS_API_KEY=... voice-agent deploy ./agents.mjs     # default export: a spec or a list of specs
 *   ELEVENLABS_API_KEY=... voice-agent conversations <agent_id>
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { deploy, ElevenLabs, type VoiceAgentSpec } from './index.ts'

const HELP = `voice-agent: phone voice agents on ElevenLabs, defined in code

  voice-agent deploy <spec.mjs|spec.json>   create or update each agent and its SIP number
  voice-agent conversations <agent_id>      its latest calls

  ELEVENLABS_API_KEY                        required
`

async function main(argv: string[]): Promise<number> {
  const [command, arg] = argv
  const apiKey = process.env.ELEVENLABS_API_KEY ?? ''
  if (!command || command === 'help' || command === '--help') {
    console.log(HELP)
    return 0
  }
  if (!apiKey) throw new Error('set ELEVENLABS_API_KEY')
  if (command === 'deploy') {
    if (!arg) throw new Error('voice-agent deploy <spec file>')
    const mod = (await import(pathToFileURL(resolve(arg)).href, arg.endsWith('.json') ? { with: { type: 'json' } } : undefined)) as { default: VoiceAgentSpec | VoiceAgentSpec[] }
    for (const spec of [mod.default].flat()) {
      const d = await deploy(spec, { apiKey })
      console.log(`${spec.name}: ${d.created ? 'created' : 'updated'} ${d.agentId}${d.sip ? `, dial ${d.sip}` : ''}`)
    }
    return 0
  }
  if (command === 'conversations') {
    if (!arg) throw new Error('voice-agent conversations <agent_id>')
    for (const c of await new ElevenLabs({ apiKey }).conversations(arg)) console.log(`${c.conversation_id}  ${c.status}  ${c.call_duration_secs ?? '?'} s  ${c.termination_reason ?? ''}`)
    return 0
  }
  console.error(HELP)
  return 1
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`voice-agent: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  },
)
