import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalBrainFile, createMapService, createStandaloneServer } from './main.mjs'
import { decodeArgs, drawMap, parseSteps, reduceTranscript, renderFeed, routeOf, setupFrom } from './transcript.mjs'

const MAIN_ID = '11111111-2222-3333-4444-555555555555'
const SUB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const GRAND_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const SWARM_ID = 'cccccccc-dddd-eeee-ffff-000000000000'

const at = sec => `2026-11-11T04:00:${String(sec).padStart(2, '0')}Z`
const user = (sec, content) => ({ source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: at(sec), content })
const planner = (sec, extra = {}) => ({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(sec), ...extra })
const generic = (s0, s1, body, status = 'DONE') => ({
  source: 'MODEL', type: 'GENERIC', status, created_at: at(s0),
  content: `Created At: ${at(s0)}\nCompleted At: ${at(s1)}\n${body}`,
})

function writeJsonl(dir, convId, steps) {
  const logDir = join(dir, 'brain', convId, '.system_generated', 'logs')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, 'transcript.jsonl'), `${steps.map(s => JSON.stringify(s)).join('\n')}\n`, 'utf-8')
}

test('decodeArgs unpacks Antigravity JSON-encoded string map values without mangling plain inputs', () => {
  assert.deepEqual(
    decodeArgs({
      CommandLine: '"git push origin main"',
      WaitMsBeforeAsync: '8000',
      IsDaemon: 'false',
      ArtifactMetadata: '{"UserFacing":true,"Summary":"secret summary"}',
      PlainPath: '/Users/a/b/c.ts',
    }),
    {
      CommandLine: 'git push origin main',
      WaitMsBeforeAsync: 8000,
      IsDaemon: false,
      ArtifactMetadata: { UserFacing: true, Summary: 'secret summary' },
      PlainPath: '/Users/a/b/c.ts',
    },
  )
})

test('reduceTranscript maps turns, hooks, compaction, model switches, faults and privacy rules', () => {
  const t0 = Date.parse(at(0))
  const setup = setupFrom({ language: 'en', coreName: 'AGY', memoryServers: ['recall'], hookRecords: true, hookReasons: false })
  const steps = [
    user(0, '<USER_REQUEST>\n/boost audit repo\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.1 Pro (High).\n</USER_SETTINGS_CHANGE>'),
    { source: 'SYSTEM_SDK', type: 'EPHEMERAL_MESSAGE', status: 'DONE', created_at: at(0), content: '• [#1971 excerpt] secret note body\n• [#42 excerpt] another private note' },
    planner(1, {
      input_tokens: 150_000, cache_read_tokens: 90_000, output_tokens: 10_000,
      tool_calls: [
        { name: 'read_file', args: { Path: '"/Users/a/.gemini/config/skills/plugin/SKILL.md"' } },
        { name: 'run_command', args: { CommandLine: '"gh api bad?glob"', toolSummary: '"Fetch repo tree"' } },
        { name: 'run_command', args: { CommandLine: '"rm -rf /secret"', toolSummary: '"Blocked cleanup"' } },
      ],
    }),
    generic(4, 5, 'Showing lines 1-10'),
    generic(4, 6, 'Command exited with code 1.\n\nCommand output:\nzsh: no matches'),
    generic(5, 5, 'Blocked by safety-gate: destructive rm\nCommand: rm -rf /secret', 'ERROR'),
    { source: 'SYSTEM_SDK', type: 'EPHEMERAL_MESSAGE', status: 'DONE', created_at: at(6), content: 'status bar ping without new memory ids' },
    { source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: at(7), content: '# Resuming from a compaction' },
    user(10, '<USER_REQUEST>\nfinish up\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 3.1 Pro (High) to Gemini 4 Carbon (Medium).\n</USER_SETTINGS_CHANGE>'),
    planner(12, { input_tokens: 40_000, cache_read_tokens: 80_000, output_tokens: 5_000, content: 'All done.' }),
  ]

  const out = reduceTranscript(steps, setup, { now: t0 + 13_000, mtimeMs: t0 + 12_000 })
  assert.equal(out.pushed, 1)
  assert.equal(Math.round(out.context), 13)
  assert.equal(out.model, 'Gemini 4 Carbon (Medium)')
  assert.ok(out.switchedAt !== undefined)
  assert.deepEqual(out.faults, {})

  const labels = out.entries.map(e => `${e.station}:${e.label}:${e.status}${e.mark ? `:${e.mark}` : ''}`)
  for (const expected of [
    'you:new message:ok', 'skills:boost:ok', 'hooks:added memory at session start:ok',
    'memory:2 records: #1971 #42:ok', 'skills:plugin:ok', 'web:Fetch repo tree:err',
    'hooks:stopped run_command:block', 'shell:Blocked cleanup:block', 'model:compacting context:ok',
    'model:3.1 pro → 4 carbon:ok:switch', 'you:answer ready:ok:done',
  ]) assert.ok(labels.includes(expected), `missing ${expected}`)

  assert.equal(/secret|destructive|bad\?glob/.test(JSON.stringify(out.entries)), false)
  assert.deepEqual(routeOf(out.entries).map(r => r.station), ['hooks', 'memory', 'skills', 'web', 'hooks', 'shell', 'you'])
})

test('buildBoard fans in spawned subagents, nested subagents and native swarm workers', () => {
  const root = mkdtempSync(join(tmpdir(), 'lot-map-agy-'))
  try {
    const now = Date.parse(at(10))
    writeJsonl(root, MAIN_ID, [
      user(0, '<USER_REQUEST>\nrun research\n</USER_REQUEST>'),
      planner(1, { tool_calls: [{ name: 'invoke_subagent', args: { Role: '"Codebase Researcher"', TypeName: '"research"', Prompt: '"private instructions"' } }] }),
      generic(2, 3, `{"conversationId":"${SUB_ID}"}`),
    ])
    writeJsonl(root, SUB_ID, [
      planner(4, { tool_calls: [{ name: 'invoke_subagent', args: { Role: '"Verifier"', Prompt: '"secret"' } }, { name: 'grep_search', args: { Query: '"secret token"' } }] }),
      generic(5, 6, `conversationId: ${GRAND_ID}`),
    ])
    writeJsonl(root, GRAND_ID, [planner(6, { content: 'Verified.' })])

    const swarmDir = join(root, 'brain', MAIN_ID, '.system_generated', 'swarm')
    mkdirSync(swarmDir, { recursive: true })
    writeFileSync(join(swarmDir, 'members.json'), JSON.stringify({
      title: 'Audit Swarm',
      members: { coordinator: { conversation_id: MAIN_ID, role: 'coordinator' }, auditor: { conversation_id: SWARM_ID, role: 'worker', model: 'gemini-2.5-flash' } },
    }), 'utf-8')
    writeJsonl(root, SWARM_ID, [planner(7, { tool_calls: [{ name: 'read_file', args: { Path: '"/repo/src/auth.ts"' } }] })])

    const snap = createMapService({ appDataDirs: [root] }).snapshot({ conversationId: MAIN_ID, _now: now })
    assert.deepEqual(snap.crew.map(c => `${c.label}:${c.kind}:${c.status}`), ['Codebase Researcher:subagent:run', 'auditor:swarm:run', 'Verifier:subagent:ok'])
    assert.equal(snap.svg.split('<animateTransform').length - 1, 2)
    assert.equal(/secret|private instructions/.test(JSON.stringify(snap)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('HTTP server enforces CSP, cross-site blocking, brain realpath confinement and etag caching', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lot-map-http-'))
  const outside = mkdtempSync(join(tmpdir(), 'lot-map-outside-'))
  const srv = createStandaloneServer({ appDataDirs: [root] }, { port: 0 })
  const base = `http://127.0.0.1:${(await srv.listen()).port}`

  try {
    writeJsonl(root, MAIN_ID, [user(0, '<USER_REQUEST>\nhi\n</USER_REQUEST>'), planner(2, { content: 'hello' })])

    const evilConv = '99999999-9999-9999-9999-999999999999'
    const evilLogs = join(root, 'brain', evilConv, '.system_generated', 'logs')
    mkdirSync(evilLogs, { recursive: true })
    const secretFile = join(outside, 'secret.jsonl')
    writeFileSync(secretFile, '{"type":"USER_INPUT","source":"USER_EXPLICIT","content":"hi"}\n', 'utf-8')
    symlinkSync(secretFile, join(evilLogs, 'transcript.jsonl'))
    assert.equal(canonicalBrainFile(root, join(evilLogs, 'transcript.jsonl')), null)

    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy') || '', /default-src 'none'/)
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(page.headers.get('cross-origin-resource-policy'), 'same-origin')
    assert.equal(/fonts\.googleapis\.com|https?:\/\//.test(await page.text()), false)

    assert.equal((await fetch(`${base}/api/map`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
    assert.equal((await fetch(`${base}/api/map`, { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403)
    assert.equal((await fetch(`${base}/api/map`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}/api/map?conversationId=../../etc/passwd`)).status, 400)
    assert.deepEqual((await (await fetch(`${base}/api/map?conversationId=${evilConv}`)).json()).rows, [])

    const first = await (await fetch(`${base}/api/map?conversationId=${MAIN_ID}&scheme=light&language=de`)).json()
    assert.equal(first.title, 'Arbeitskarte')
    assert.match(first.svg, /#f5f2ea/)
    const cached = await (await fetch(`${base}/api/map?conversationId=${MAIN_ID}&scheme=light&language=de&etag=${encodeURIComponent(first.etag)}`)).json()
    assert.equal(cached.unchanged, true)
  } finally {
    await srv.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('parses a live Antigravity brain transcript cleanly when present on this machine', () => {
  const appData = join(homedir(), '.gemini', 'antigravity')
  if (!existsSync(join(appData, 'brain'))) return
  const service = createMapService({ appDataDirs: [appData] })
  const latest = service.pickLatestConversation()
  if (!latest) return
  const snap = service.snapshot({ conversationId: latest })
  assert.equal(snap.conversationId, latest)
  assert.match(snap.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.equal(snap.svg.includes('NaN') || snap.svg.includes('Infinity'), false)
  assert.ok(snap.rows.length > 0)
  const setup = setupFrom({ coreName: 'AGY' })
  assert.equal(renderFeed({ entries: [] }, setup).length, 0)
  assert.ok(drawMap({ entries: [], counts: {} }, Date.now(), setup).includes('>AGY<'))
  assert.ok(Array.isArray(parseSteps('')))
})
