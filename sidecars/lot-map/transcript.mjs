// Reads Antigravity's on-disk transcript.jsonl (plus spawned subagents and native swarm rosters)
// into the same Board shape that hooks/register.tsx builds for Claude Code. Read-only.
import { register } from 'node:module'

if (!globalThis.__lotMapTs) { register('./ts-loader.mjs', import.meta.url); globalThis.__lotMapTs = true }
const map = await import('../../hooks/map.ts')
export const { STATIONS, classify, clean, describeNow, drawMap, firstLine, foldRows, formatMs, memoryIds, routeOf, setupFrom, shortModel } = map

const KEEP = 80
const CREW = 12
export const LIVE_WINDOW_MS = 10 * 60 * 1000
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const str = v => (typeof v === 'string' ? v : '')
const parseIso = (iso, fallback) => { const ms = iso ? Date.parse(String(iso)) : NaN; return Number.isFinite(ms) ? ms : fallback }

const MODEL_CHANGE_RE = /changed setting `Model Selection` from (?:.+?) to ([^\r\n]+?)\.(?:\s|$)/
const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/
const SUBAGENT_ID_RE = /conversation[_]?id["'\s:=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
const EXIT_NONZERO_RE = /^Command exited with code ([1-9]\d*)\./m
const HOOK_DENY_RE = /^(?:Blocked by|Denied by|Refused by|Hook\b[^\r\n]*\b(?:denied|blocked|stopped|refused))\b/im

/** Unpacks Antigravity's JSON-encoded string values in `tool_calls[].args` without touching plain strings. */
export function decodeArg(v) {
  if (Array.isArray(v)) return v.map(decodeArg)
  if (v && typeof v === 'object') return decodeArgs(v)
  if (typeof v !== 'string') return v
  const s = v.trim()
  if (!/^(".*"|\{.*\}|\[.*\]|true|false|-?\d+(?:\.\d+)?)$/s.test(s)) return v
  try { return JSON.parse(s) } catch { return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : v }
}

export const decodeArgs = raw =>
  raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decodeArg(v)]))
    : {}

export function parseSteps(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    try { const p = JSON.parse(line); if (p && typeof p === 'object') out.push(p) } catch {}
  }
  return out
}

function parseToolTimes(content, fallback) {
  const m = /^Created At:\s*(\S+)\r?\nCompleted At:\s*(\S+)/.exec(str(content))
  if (!m) return { startedAt: fallback, endedAt: fallback }
  const startedAt = parseIso(m[1], fallback)
  return { startedAt, endedAt: Math.max(startedAt, parseIso(m[2], startedAt)) }
}

function windowFor(model, configured) {
  const n = Number(configured)
  if (Number.isFinite(n) && n >= 10_000) return n
  return /claude|opus|sonnet|haiku|fable/i.test(model) && !/1m\b/i.test(model) ? 200_000 : 1_000_000
}

export function reduceTranscript(steps, setup, {
  now = Date.now(), mtimeMs = now, agentId = undefined, fallbackModel = undefined, initialModel = undefined, contextWindow = undefined,
} = {}) {
  const { t } = setup
  const isMain = agentId === undefined
  const from = isMain ? 'core' : 'agents'
  const isLive = mtimeMs > 0 && now - mtimeMs < LIVE_WINDOW_MS

  const entries = []
  const counts = {}
  let faults = {}
  let pushed = 0
  let model = fallbackModel
  let lastUsedModel = initialModel
  let switchedAt, context
  let plannerStep = 0
  let seenPlanner = false, seenAtStartHook = false, justStartedTurn = false, awaitingModel = false, parkedInSwarmWait = false
  const seenRecordIds = new Set()
  const spawned = new Map()

  let clock = steps.length > 0 ? parseIso(steps[0]?.created_at, now) : now
  let seq = 0
  const nextId = tag => `${agentId ? `${agentId.slice(0, 8)}:` : ''}${tag}:${++seq}`

  const record = (entry, uncounted = false) => {
    const e = { ...entry, label: clean(entry.label), ...(agentId !== undefined ? { agentId } : {}) }
    entries.push(e)
    if (!uncounted) {
      counts[e.station] = (counts[e.station] ?? 0) + 1
      if (e.station === 'memory' && e.from === 'inbound') pushed++
    }
    if ((e.status === 'err' || e.status === 'block') && e.station !== 'you') {
      faults = { ...faults, [e.station]: (faults[e.station] ?? 0) + 1 }
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (!step || typeof step !== 'object') continue
    const stepAt = (clock = Math.max(clock, parseIso(step.created_at, clock)))
    const type = str(step.type)
    const content = str(step.content)

    if (type === 'USER_INPUT') {
      const picked = MODEL_CHANGE_RE.exec(content)?.[1]
      if (picked) model = picked.trim()
      const req = (USER_REQUEST_RE.exec(content)?.[1] ?? (step.source === 'USER_EXPLICIT' ? content : '')).trim()
      if (isMain && req !== '') {
        faults = {}
        record({ id: nextId('you'), station: 'you', label: t.newMessage, from: 'inbound', startedAt: stepAt, endedAt: stepAt, status: 'ok' })
        const slash = /^\/([a-z][a-z0-9_-]{1,24})(?:\s|$)/i.exec(req)?.[1]
        if (slash) record({ id: nextId('skill'), station: 'skills', label: slash, from: 'core', startedAt: stepAt, endedAt: stepAt, status: 'ok' })
      }
      justStartedTurn = awaitingModel = true
      parkedInSwarmWait = false
      continue
    }

    if (type === 'EPHEMERAL_MESSAGE' || type === 'SYSTEM_MESSAGE') {
      if (!isMain || content.trim() === '') continue
      const ids = setup.hookRecords ? memoryIds(content) : []
      let when = ''
      if (!seenPlanner && !seenAtStartHook) { when = t.atStart; seenAtStartHook = true }
      else if (justStartedTurn) { when = t.toMessage; justStartedTurn = false }
      else if (ids.some(id => !seenRecordIds.has(id))) when = t.toMessage
      if (when !== '') {
        for (const id of ids) seenRecordIds.add(id)
        if (ids.length === 0) {
          record({ id: nextId('hook'), station: 'hooks', label: t.addedContext(when), from: 'core', startedAt: stepAt, endedAt: stepAt, status: 'ok' })
        } else {
          const shown = ids.slice(0, 6).map(id => `#${id}`).join(' ') + (ids.length > 6 ? ' …' : '')
          record({ id: nextId('hook'), station: 'hooks', label: t.addedMemory(when), from: 'core', startedAt: stepAt, endedAt: stepAt, status: 'ok' })
          record({ id: nextId('mem'), station: 'memory', label: t.records(ids.length, shown), from: 'inbound', startedAt: stepAt, endedAt: stepAt, status: 'ok' })
        }
      }
      continue
    }

    if (type === 'CHECKPOINT') {
      const nextStep = steps[i + 1]
      const endedAt = nextStep === undefined ? undefined : Math.max(stepAt, parseIso(nextStep.created_at, stepAt))
      const status = nextStep === undefined && isLive ? 'run' : 'ok'
      record({ id: nextId('compact'), station: 'model', label: t.compacting, from, startedAt: stepAt, ...(status === 'run' ? {} : { endedAt: endedAt ?? stepAt }), status })
      if (endedAt !== undefined) clock = endedAt
      awaitingModel = nextStep !== undefined
      continue
    }

    if (type === 'ERROR_MESSAGE') {
      const canceled = step.status === 'CANCELED' || /cancel|abort|interrupt/i.test(content)
      record(
        isMain && canceled
          ? { id: nextId('abort'), station: 'you', label: t.turnAborted, from: 'core', startedAt: stepAt, endedAt: stepAt, status: 'err' }
          : { id: nextId('err'), station: 'model', label: shortModel(model || 'model'), from, startedAt: stepAt, endedAt: stepAt, status: 'err' },
      )
      awaitingModel = false
      continue
    }

    if (type === 'PLANNER_RESPONSE') {
      seenPlanner = true
      justStartedTurn = parkedInSwarmWait = false
      plannerStep++

      const stepModel = str(step.model) || str(step.model_name) || model || 'gemini'
      model = stepModel
      if (isMain && lastUsedModel !== undefined && lastUsedModel !== stepModel) {
        switchedAt = stepAt
        record({ id: nextId('switch'), station: 'model', label: `${shortModel(lastUsedModel)} → ${shortModel(stepModel)}`, from: 'core', startedAt: stepAt, endedAt: stepAt, status: 'ok', mark: 'switch' }, true)
      }
      lastUsedModel = stepModel

      if (isMain && (step.input_tokens !== undefined || step.cache_read_tokens !== undefined)) {
        const used = (Number(step.input_tokens) || 0) + (Number(step.cache_read_tokens) || 0) + (Number(step.output_tokens) || 0)
        if (used > 0) context = Math.max(0, Math.min(100, (used / windowFor(stepModel, contextWindow)) * 100))
      }

      const results = []
      while (i + 1 < steps.length && str(steps[i + 1]?.type) === 'GENERIC') results.push(steps[++i])
      const isNewestBatch = !steps.slice(i + 1).some(s => /^(PLANNER_RESPONSE|USER_INPUT|CHECKPOINT|ERROR_MESSAGE)$/.test(str(s?.type)))
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []
      const modelEnd = results[0] ? Math.max(stepAt, parseToolTimes(results[0].content, stepAt).startedAt) : stepAt
      clock = modelEnd

      record({
        id: nextId('model'), station: 'model',
        label: `${shortModel(stepModel)} · ${t.step(plannerStep)}${isMain ? '' : ` · ${t.subagent}`}`,
        from, startedAt: stepAt, endedAt: modelEnd, status: step.status === 'ERROR' ? 'err' : 'ok',
      })

      if (calls.length === 0) {
        awaitingModel = false
        if (isMain) {
          const aborted = step.status === 'CANCELED' || step.status === 'ABORTED'
          record({ id: nextId('done'), station: 'you', label: aborted ? t.turnAborted : t.answerReady, from: 'core', startedAt: modelEnd, endedAt: modelEnd, status: aborted ? 'err' : 'ok', ...(aborted ? {} : { mark: 'done' }) })
        }
        continue
      }

      let allSettled = results.length >= calls.length
      for (let k = 0; k < calls.length; k++) {
        const call = calls[k] || {}
        const toolName = str(call.name) || 'tool'
        const args = decodeArgs(call.args)
        const seen = classify(toolName, args, setup)
        const res = results[k]
        const resStatus = str(res?.status)

        if (!res || resStatus === 'RUNNING' || resStatus === 'PENDING') {
          allSettled = false
          const startedAt = res ? parseToolTimes(res.content, modelEnd).startedAt : modelEnd
          if (isNewestBatch && isLive) {
            if (toolName === 'swarm_wait') parkedInSwarmWait = true
            record({ id: nextId('tool'), ...seen, from, startedAt, status: 'run' })
          } else {
            record({ id: nextId('tool'), ...seen, from, startedAt, endedAt: startedAt, status: 'ok' })
          }
          continue
        }

        const { startedAt, endedAt } = parseToolTimes(res.content, modelEnd)
        clock = Math.max(clock, endedAt)
        const body = str(res.content).replace(/^Created At:[^\n]*\nCompleted At:[^\n]*\n?/, '').trim()
        const refused = (resStatus === 'ERROR' || resStatus === 'CANCELED') && HOOK_DENY_RE.test(body)
        const failed = !refused && (resStatus === 'ERROR' || EXIT_NONZERO_RE.test(body))
        if (refused && isMain) {
          record({ id: nextId('hook'), station: 'hooks', label: (setup.hookReasons ? firstLine(body) : '') || t.stopped(toolName), from: 'core', startedAt, endedAt: startedAt, status: 'block' })
        }
        record({ id: nextId('tool'), ...seen, from, startedAt, endedAt, status: refused ? 'block' : failed ? 'err' : 'ok' })

        if (toolName === 'invoke_subagent') {
          const child = SUBAGENT_ID_RE.exec(body)?.[1]
          if (child && UUID_RE.test(child)) spawned.set(child, clean(str(args.Role) || str(args.TypeName) || t.subagent, 36))
        }
      }
      awaitingModel = allSettled && isNewestBatch
    }
  }

  if (awaitingModel && isLive && !parkedInSwarmWait) {
    record({
      id: nextId('thinking'), station: 'model',
      label: `${shortModel(model || lastUsedModel || 'gemini')} · ${t.step(plannerStep + 1)}${isMain ? '' : ` · ${t.subagent}`}`,
      from, startedAt: clock, status: 'run',
    })
  }

  return {
    entries, counts, faults, pushed,
    model: lastUsedModel || model,
    step: plannerStep > 0 ? plannerStep : undefined,
    context, switchedAt, spawned,
    isRunning: isLive && !parkedInSwarmWait && entries.some(e => e.status === 'run'),
  }
}

/** Merges the main conversation with spawned subagents (up to depth 2) and native swarm peers. */
export function buildBoard({ mainId, readTranscript, swarmPeers = [], setup, now = Date.now(), initialModel = undefined, contextWindow = undefined }) {
  const mainDoc = readTranscript(mainId)
  const main = reduceTranscript(parseSteps(mainDoc.text), setup, { now, mtimeMs: mainDoc.mtime, initialModel, contextWindow })

  const queue = []
  const visited = new Set([mainId])
  for (const [id, label] of main.spawned) if (!visited.has(id)) { visited.add(id); queue.push({ id, label, kind: 'subagent', depth: 1 }) }
  for (const p of swarmPeers) {
    if (p?.id && UUID_RE.test(p.id) && !visited.has(p.id)) {
      visited.add(p.id)
      queue.push({ id: p.id, label: clean(p.label || p.name || setup.t.subagent, 36), kind: 'swarm', model: p.model, killed: Boolean(p.killed), depth: 1 })
    }
  }

  const allEntries = [...main.entries]
  const counts = { ...main.counts }
  const faults = { ...main.faults }
  let pushed = main.pushed
  const activeAgents = []
  const crew = []
  const lastUserAt = [...main.entries].reverse().find(e => e.station === 'you' && e.from === 'inbound')?.startedAt ?? 0

  while (queue.length > 0 && crew.length < CREW) {
    const item = queue.shift()
    const doc = readTranscript(item.id)
    if (doc.size < 0 && item.kind !== 'swarm') continue
    const sub = reduceTranscript(parseSteps(doc.text), setup, { now, mtimeMs: item.killed ? 0 : doc.mtime, agentId: item.id, fallbackModel: item.model, contextWindow })

    allEntries.push(...sub.entries)
    for (const [st, n] of Object.entries(sub.counts)) counts[st] = (counts[st] ?? 0) + n
    pushed += sub.pushed
    for (const e of sub.entries) {
      if ((e.status === 'err' || e.status === 'block') && e.station !== 'you' && e.startedAt >= lastUserAt) faults[e.station] = (faults[e.station] ?? 0) + 1
    }

    const running = !item.killed && sub.isRunning
    if (running) activeAgents.push(item.id)
    crew.push({
      id: item.id, label: item.label, kind: item.kind,
      status: item.killed ? 'done' : running ? 'run' : 'ok',
      calls: Object.values(sub.counts).reduce((sum, n) => sum + (n || 0), 0),
    })

    if (item.depth < 2) {
      for (const [grandId, grandLabel] of sub.spawned) {
        if (!visited.has(grandId) && crew.length + queue.length < CREW) {
          visited.add(grandId)
          queue.push({ id: grandId, label: grandLabel, kind: 'subagent', depth: item.depth + 1 })
        }
      }
    }
  }

  allEntries.sort((a, b) => a.startedAt - b.startedAt)
  return {
    board: {
      entries: allEntries.slice(-KEEP), counts,
      ...(main.model !== undefined ? { model: main.model } : {}),
      ...(main.step !== undefined ? { step: main.step } : {}),
      ...(pushed > 0 ? { pushed } : {}),
      ...(Object.keys(faults).length > 0 ? { faults } : {}),
      ...(activeAgents.length > 0 ? { agents: activeAgents.slice(0, CREW) } : {}),
      ...(main.context !== undefined ? { context: main.context } : {}),
      ...(main.switchedAt !== undefined ? { switchedAt: main.switchedAt } : {}),
    },
    crew,
  }
}

export function renderFeed(board, { t }) {
  const col = Math.max(8, ...Object.values(t.stations).map(n => n.length))
  return foldRows(board.entries).map(({ entry: e, times, tookMs }) => {
    const sw = e.mark === 'switch'
    return {
      id: e.id,
      mark: sw ? '◆' : e.status === 'run' ? '●' : e.status === 'ok' ? '·' : '✕',
      paddedStation: t.stations[e.station].padEnd(col),
      label: e.label,
      extra: times > 1 ? `+${times - 1}` : '',
      took: e.endedAt === undefined ? t.running : tookMs > 0 ? formatMs(tookMs, t) : '',
      tone: sw || e.status === 'run' ? 'accent' : e.status === 'ok' ? 'dim' : 'error',
    }
  })
}
