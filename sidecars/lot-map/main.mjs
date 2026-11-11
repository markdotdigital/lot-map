// Antigravity Auxiliary Pane sidecar for lot-map: confines reads to <appData>/brain/, makes no network calls, and draws with hooks/map.ts.
import { createServer } from 'node:http'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UUID_RE, buildBoard, describeNow, drawMap, renderFeed, setupFrom } from './transcript.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MAX_READ_BYTES = 8 * 1024 * 1024
const ROSTER_SCAN_TTL_MS = 3000

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; child-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Vary': 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site',
  'Cache-Control': 'no-store',
})

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
}

const safeReaddir = p => { try { return readdirSync(p) } catch { return [] } }
const logPath = (appData, id) => join(appData, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
const rosterPath = (appData, id) => join(appData, 'brain', id, '.system_generated', 'swarm', 'members.json')

export function findAppDataDirs(overrideDirs) {
  if (Array.isArray(overrideDirs)) return overrideDirs.filter(d => existsSync(join(d, 'brain')))
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') return existsSync(join(dirname(d), 'brain')) ? [dirname(d)] : []
    }
    return []
  }
  const root = join(homedir(), '.gemini')
  return safeReaddir(root).sort().map(n => join(root, n)).filter(d => existsSync(join(d, 'brain')))
}

/** Confines every file read strictly inside `<appData>/brain/` after resolving symlinks. */
export function canonicalBrainFile(appData, candidatePath) {
  try {
    const brainReal = realpathSync(join(appData, 'brain'))
    const prefix = brainReal.endsWith(sep) ? brainReal : `${brainReal}${sep}`
    const real = realpathSync(candidatePath)
    return real.startsWith(prefix) ? real : null
  } catch {
    return null
  }
}

function readTailUtf8(path, maxBytes) {
  const fd = openSync(path, 'r')
  try {
    const { size } = fstatSync(fd)
    if (size <= maxBytes) return readFileSync(fd, 'utf-8')
    const buf = Buffer.allocUnsafe(maxBytes)
    readSync(fd, buf, 0, maxBytes, size - maxBytes)
    const slice = buf.toString('utf-8')
    const nl = slice.indexOf('\n')
    return nl >= 0 ? slice.slice(nl + 1) : slice
  } finally {
    closeSync(fd)
  }
}

export function createMapService({ appDataDirs, optionsPath, defaultOptions = {} } = {}) {
  const fileCache = new Map()
  let swarmScan = { builtAt: 0, rosters: [] }
  const dirs = () => findAppDataDirs(appDataDirs)

  function readSafe(appData, targetPath) {
    const real = canonicalBrainFile(appData, targetPath)
    if (!real) return { text: '', mtime: 0, size: -1, key: '-' }
    try {
      const st = statSync(real)
      const key = `${st.mtimeMs}:${st.size}`
      const hit = fileCache.get(real)
      if (hit && hit.key === key) return hit
      const entry = { key, text: readTailUtf8(real, MAX_READ_BYTES), mtime: st.mtimeMs, size: st.size }
      fileCache.set(real, entry)
      return entry
    } catch {
      return { text: '', mtime: 0, size: -1, key: '-' }
    }
  }

  function locateConversation(conv) {
    if (!conv || !UUID_RE.test(conv)) return null
    return dirs().find(d => canonicalBrainFile(d, logPath(d, conv)) || canonicalBrainFile(d, rosterPath(d, conv))) ?? null
  }

  function pickLatestConversation() {
    let best = null
    for (const d of dirs()) {
      for (const id of safeReaddir(join(d, 'brain'))) {
        if (!UUID_RE.test(id)) continue
        const real = canonicalBrainFile(d, logPath(d, id))
        if (!real) continue
        try {
          const mtime = statSync(real).mtimeMs
          if (!best || mtime > best.mtime) best = { id, mtime }
        } catch {}
      }
    }
    return best?.id ?? null
  }

  function readRoster(appData, coordinatorId) {
    const doc = readSafe(appData, rosterPath(appData, coordinatorId))
    if (doc.size < 0) return null
    try {
      const p = JSON.parse(doc.text)
      return p && typeof p.members === 'object' && p.members ? { members: p.members, key: doc.key } : null
    } catch {
      return null
    }
  }

  function findSwarmPeers(appData, conv) {
    let roster = readRoster(appData, conv)
    if (!roster) {
      const now = Date.now()
      if (now - swarmScan.builtAt >= ROSTER_SCAN_TTL_MS) {
        const rosters = []
        for (const d of dirs()) {
          for (const id of safeReaddir(join(d, 'brain'))) {
            if (UUID_RE.test(id) && canonicalBrainFile(d, rosterPath(d, id))) rosters.push({ appData: d, id })
          }
        }
        swarmScan = { builtAt: now, rosters }
      }
      for (const c of swarmScan.rosters) {
        const r = readRoster(c.appData, c.id)
        if (r && Object.values(r.members).some(m => m?.conversation_id === conv)) { roster = r; break }
      }
    }
    if (!roster) return { peers: [], key: '' }
    const peers = Object.entries(roster.members)
      .filter(([, m]) => typeof m?.conversation_id === 'string' && m.conversation_id !== conv && UUID_RE.test(m.conversation_id))
      .map(([name, m]) => ({ id: m.conversation_id, name, label: name, model: typeof m.model === 'string' ? m.model : undefined, killed: Boolean(m.killed) }))
    return { peers, key: roster.key }
  }

  function loadUserOptions(query = {}) {
    const candidates = [
      optionsPath,
      process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ? join(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, 'options.json') : '',
      join(homedir(), '.gemini', 'config', 'lot-map.json'),
    ].filter(Boolean)
    let disk = {}
    for (const p of candidates) {
      try {
        if (!existsSync(p)) continue
        const parsed = JSON.parse(readFileSync(p, 'utf-8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { disk = parsed; break }
      } catch {}
    }
    return {
      coreName: 'AGY', memoryServers: ['memory'], ...defaultOptions, ...disk,
      ...(typeof query.language === 'string' ? { language: query.language } : {}),
      ...(typeof query.layout === 'string' ? { layout: query.layout } : {}),
      ...(typeof query.theme === 'string' ? { theme: query.theme } : {}),
      ...(typeof query.coreName === 'string' ? { coreName: query.coreName } : {}),
    }
  }

  function snapshot(data = {}, fallbackConv = '') {
    const now = typeof data._now === 'number' ? data._now : Date.now()
    const rawOptions = loadUserOptions(data)
    const setup = setupFrom(rawOptions)
    const effectiveTheme = setup.theme === 'auto' && (data.scheme === 'dark' || data.scheme === 'light') ? data.scheme : setup.theme
    const drawSetup = effectiveTheme === setup.theme ? setup : { ...setup, theme: effectiveTheme }
    const rawLang = typeof rawOptions.language === 'string' && /^[a-z]{2,5}$/.test(rawOptions.language) ? rawOptions.language : 'en'
    const lang = rawLang === 'en' || setup.t !== setupFrom({ language: 'en' }).t ? rawLang : 'en'

    const requested = (typeof data.conversationId === 'string' ? data.conversationId : typeof data.id === 'string' ? data.id : '').trim()
    if (requested !== '' && !UUID_RE.test(requested)) return { error: 'invalid conversationId', status: 400 }
    const conv = requested || (UUID_RE.test(fallbackConv) ? fallbackConv : '') || pickLatestConversation() || ''

    const empty = (id, tag) => {
      const b = { entries: [], counts: {} }
      return {
        conversationId: id, language: lang, title: setup.t.title, current: describeNow(b, setup.t),
        nothingYet: setup.t.nothingYet, svg: drawMap(b, now, drawSetup), rows: [], crew: [],
        etag: `${tag}:${lang}:${effectiveTheme}:${setup.layout}:${setup.core}`,
      }
    }
    if (!conv) return empty(null, 'empty')
    const appData = locateConversation(conv)
    if (!appData) return empty(conv, `missing:${conv}`)

    const keys = []
    const readTranscript = id => { const doc = readSafe(appData, logPath(appData, id)); keys.push(`${id}:${doc.key}`); return doc }
    const { peers, key: swarmKey } = findSwarmPeers(appData, conv)
    const { board, crew } = buildBoard({ mainId: conv, readTranscript, swarmPeers: peers, setup, now, contextWindow: rawOptions.contextWindow })

    const newestAt = board.entries.reduce((m, e) => Math.max(m, e.endedAt ?? e.startedAt), 0)
    const cool = board.entries.some(e => e.status === 'run') ? `run:${Math.floor(now / 1000)}` : now - newestAt < 8500 ? `cool:${Math.floor((now - newestAt) / 1000)}` : 'rest'
    const etag = `${conv}|${lang}|${effectiveTheme}|${setup.layout}|${setup.core}|${swarmKey}|${keys.join(',')}|${cool}`
    if (typeof data.etag === 'string' && data.etag === etag) return { conversationId: conv, unchanged: true, etag }

    return {
      conversationId: conv, language: lang, title: setup.t.title, current: describeNow(board, setup.t),
      nothingYet: setup.t.nothingYet, svg: drawMap(board, now, drawSetup), rows: renderFeed(board, setup), crew, etag,
    }
  }

  return { snapshot, locateConversation, pickLatestConversation }
}

/** Loopback-only server for standalone preview and integration tests outside Antigravity. */
export function createStandaloneServer(serviceOptions = {}, { port = Number(process.env.PORT || 0) } = {}) {
  const service = createMapService(serviceOptions)
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  const server = createServer((req, res) => {
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
    if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'cross-origin forbidden' })
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/') return send(res, 200, readFileSync(join(__dirname, 'index.html'), 'utf-8'), 'text/html; charset=utf-8')
    if (url.pathname === '/preload.js') return send(res, 200, '// standalone\n', 'application/javascript; charset=utf-8')
    if (STATIC[url.pathname]) return send(res, 200, readFileSync(join(__dirname, STATIC[url.pathname][0]), 'utf-8'), STATIC[url.pathname][1])
    if (url.pathname === '/api/map') {
      const out = service.snapshot(Object.fromEntries(url.searchParams), process.env.ANTIGRAVITY_CONVERSATION_ID || '')
      return send(res, out.status || 200, out)
    }
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8')
  })
  return {
    service, server,
    listen: () => new Promise(r => server.listen(port, '127.0.0.1', () => r(server.address()))),
    close: () => new Promise(r => server.close(() => r())),
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    const { SidecarApp, Response } = await import('sidecar_sdk')
    const app = new SidecarApp()
    const service = createMapService()
    app.page('/', () => new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), { contentType: 'text/html; charset=utf-8', headers: SECURITY_HEADERS }))
    for (const [route, [file, contentType]] of Object.entries(STATIC)) {
      app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType, headers: SECURITY_HEADERS }), 'GET')
    }
    app.api('/api/map', data => {
      const out = service.snapshot(data, app.config.conversationId || '')
      return new Response(JSON.stringify(out), { status: out.status || 200, contentType: 'application/json; charset=utf-8', headers: SECURITY_HEADERS })
    }, 'GET')
    await app.run()
  } else {
    const addr = await createStandaloneServer().listen()
    console.log(`[lot-map] listening on http://127.0.0.1:${addr.port}`)
  }
}
