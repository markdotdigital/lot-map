// Auxiliary Pane frontend for lot-map in Antigravity: polls /api/map, syncs host theme, mounts DOM without innerHTML.
(() => {
  const params = new URLSearchParams(window.location.search)
  const titleEl = document.getElementById('title')
  const crewEl = document.getElementById('crew')
  const stageEl = document.getElementById('stage')
  const currentEl = document.getElementById('current')
  const feedEl = document.getElementById('feed')
  const parser = new DOMParser()
  let lastEtag = ''
  let currentScheme = ''
  let timer = null

  function detectScheme() {
    if (document.documentElement.style.getPropertyValue('--background').trim()) {
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;color:var(--background)'
      document.documentElement.appendChild(probe)
      const computed = getComputedStyle(probe).color
      probe.remove()
      const nums = (computed.match(/[\d.]+/g) || []).map(Number)
      if (nums.length >= 3) {
        const s = computed.startsWith('color(') ? 1 : 255
        return (0.2126 * nums[0] + 0.7152 * nums[1] + 0.0722 * nums[2]) / s < 0.5 ? 'dark' : 'light'
      }
    }
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }

  function syncTheme() {
    const forced = params.get('theme')
    const scheme = forced === 'dark' || forced === 'light' ? forced : detectScheme()
    if (scheme !== currentScheme) {
      currentScheme = scheme
      document.documentElement.dataset.theme = scheme
      document.documentElement.style.colorScheme = scheme
      lastEtag = ''
    }
  }

  syncTheme()
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { syncTheme(); void poll() })

  function renderSvg(source, label) {
    const doc = parser.parseFromString(String(source || ''), 'image/svg+xml')
    const root = doc.documentElement
    if (doc.querySelector('parsererror') || !root || root.tagName.toLowerCase() !== 'svg') return
    root.setAttribute('role', 'img')
    root.setAttribute('aria-label', label)
    stageEl.replaceChildren(document.importNode(root, true))
  }

  function renderCrew(crew) {
    if (!Array.isArray(crew) || crew.length === 0) { crewEl.hidden = true; crewEl.replaceChildren(); return }
    const canNav = typeof window.sidecar?.ui?.toggleConversation === 'function'
    crewEl.replaceChildren(...crew.map(m => {
      const wrap = document.createElement('div')
      wrap.setAttribute('role', 'listitem')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'crew-pill'
      btn.disabled = !canNav
      const dot = document.createElement('span')
      dot.className = `crew-dot${m.status === 'run' ? ' is-run' : ''}`
      dot.setAttribute('aria-hidden', 'true')
      const text = document.createElement('span')
      text.textContent = m.calls > 0 ? `${m.label} · ${m.calls}` : String(m.label || '')
      btn.append(dot, text)
      if (canNav && m.id) btn.addEventListener('click', () => window.sidecar.ui.toggleConversation(m.id))
      wrap.appendChild(btn)
      return wrap
    }))
    crewEl.hidden = false
  }

  function renderRows(rows, nothingYet) {
    if (!Array.isArray(rows) || rows.length === 0) {
      const li = document.createElement('li')
      li.className = 'empty'
      li.textContent = String(nothingYet || 'Nothing yet.')
      feedEl.replaceChildren(li)
      return
    }
    feedEl.replaceChildren(...rows.map(r => {
      const li = document.createElement('li')
      li.className = `row tone-${r.tone || 'dim'}`
      li.append(document.createTextNode(`${r.mark} ${r.paddedStation} ${r.label}`))
      for (const [cls, val] of [['row-extra', r.extra], ['row-took', r.took]]) {
        if (!val) continue
        const span = document.createElement('span')
        span.className = cls
        span.textContent = `  ${val}`
        li.appendChild(span)
      }
      return li
    }))
  }

  async function poll() {
    try {
      const q = new URLSearchParams()
      const conv = params.get('conversationId') || window.sidecar?.conversationId || ''
      if (conv) q.set('conversationId', conv)
      if (currentScheme) q.set('scheme', currentScheme)
      for (const k of ['language', 'layout', 'theme', 'coreName']) if (params.get(k)) q.set(k, params.get(k))
      if (lastEtag) q.set('etag', lastEtag)
      const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : window.fetch.bind(window)
      const res = await fetcher(`/api/map?${q.toString()}`, { method: 'GET' })
      const data = res.ok ? await res.json() : null
      if (data && !data.unchanged && !data.error) {
        lastEtag = data.etag || ''
        if (data.language && document.documentElement.lang !== data.language) document.documentElement.lang = data.language
        if (data.title) { document.title = data.title; titleEl.textContent = data.title }
        currentEl.textContent = String(data.current || '')
        renderSvg(data.svg, `${data.title || 'Work map'}. ${data.current || ''}`)
        renderCrew(data.crew)
        renderRows(data.rows, data.nothingYet)
      }
    } catch {} finally {
      clearTimeout(timer)
      if (params.get('once') !== '1') timer = setTimeout(poll, document.hidden ? 2200 : 650)
    }
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll() })
  void poll()
})()
