// Sincroniza as notas entre os aparelhos (o Mac e o celular) pela rede do Tailscale.
//
// Cada app abre a porta 4318. Ela só atende pedidos vindos de um endereço do
// Tailscale (100.64.0.0 a 100.127.255.255) e com o segredo combinado no
// pareamento. A cada 30 segundos, e logo depois de cada edição, o app manda
// todas as suas notas para o outro aparelho e recebe as dele de volta. Cada
// lado guarda a versão mais recente de cada nota.
import http from 'node:http'
import os from 'node:os'
import crypto from 'node:crypto'

export const SYNC_PORT = Number(process.env.WC_SYNC_PORT || 4318)

function isTailscale(ip) {
  const m = /^(?:::ffff:)?100\.(\d+)\.\d+\.\d+$/.exec(ip || '')
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

export function tailscaleIp() {
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if ((a.family === 'IPv4' || a.family === 4) && isTailscale(a.address)) return a.address
      }
    }
  } catch {}
  return null
}

// Código curto, sem letras parecidas (0/O, 1/I), fácil de digitar no celular.
function randomCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return [...crypto.randomBytes(12)].map((b) => abc[b % abc.length]).join('')
}

function readJson(req, limit = 30_000_000) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
      } else parts.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

export function startSync({ store, onNotesChanged }) {
  const state = { lastSync: 0, error: null, listening: false }
  if (!store.getSetting('sync_secret')) store.setSetting('sync_secret', randomCode())
  const secret = () => store.getSetting('sync_secret')
  const peers = () => JSON.parse(store.getSetting('sync_peers') || '[]')
  const setPeers = (list) => store.setSetting('sync_peers', JSON.stringify([...new Set(list)]))
  const sameSecret = (v) => {
    const a = Buffer.from(String(v || ''))
    const b = Buffer.from(secret())
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  const merge = (notes) => {
    const n = store.mergeNotes(notes)
    if (n) onNotesChanged()
    return n
  }

  const server = http.createServer(async (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
      if (!isTailscale(ip)) return reply(403, { error: 'only Tailscale' })
      if (!sameSecret(req.headers['x-wc-sync'])) return reply(403, { error: 'wrong code' })
      if (req.method !== 'POST') return reply(404, {})
      const body = await readJson(req)

      if (req.url === '/sync/pair') {
        // O outro aparelho digitou o nosso código: passa a sincronizar com ele também.
        setPeers([...peers(), `${ip}:${Number(body.port) || SYNC_PORT}`])
        merge(body.notes)
        return reply(200, { notes: store.exportNotes() })
      }
      if (req.url === '/sync/notes') {
        merge(body.notes)
        state.lastSync = Date.now()
        state.error = null
        return reply(200, { notes: store.exportNotes() })
      }
      reply(404, {})
    } catch (e) {
      reply(500, { error: e.message })
    }
  })
  server.on('error', (e) => {
    state.error = `Could not open port ${SYNC_PORT}: ${e.code || e.message}`
  })
  server.listen(SYNC_PORT, '0.0.0.0', () => (state.listening = true))

  async function post(peer, path, payload, key = secret()) {
    const r = await fetch(`http://${peer}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wc-sync': key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `answer ${r.status}`)
    return data
  }

  let running = false
  async function syncAll() {
    if (running) return
    running = true
    try {
      for (const peer of peers()) {
        try {
          const { notes } = await post(peer, '/sync/notes', { notes: store.exportNotes() })
          merge(notes)
          state.lastSync = Date.now()
          state.error = null
        } catch (e) {
          state.error = `Could not reach ${peer} (${e.message}). Is Tailscale on and the app open there?`
        }
      }
    } finally {
      running = false
    }
  }
  let timer = null
  const soon = () => {
    clearTimeout(timer)
    timer = setTimeout(syncAll, 1500)
  }
  setTimeout(syncAll, 3000)
  setInterval(syncAll, 30000)

  return {
    status() {
      const ip = tailscaleIp()
      return {
        code: ip ? `${ip}/${secret()}` : null,
        peers: peers(),
        lastSync: state.lastSync,
        error: state.error,
      }
    },
    changed: soon,
    // Pareia com o código mostrado no outro aparelho: "100.x.y.z/SEGREDO".
    async pair(code) {
      const m = /^\s*(100\.\d+\.\d+\.\d+)(?::(\d+))?\s*\/\s*([A-Z0-9]{8,})\s*$/i.exec(code || '')
      if (!m) throw new Error('The code looks like 100.101.150.56/ABCD2345EFGH.')
      const peer = `${m[1]}:${m[2] || SYNC_PORT}`
      const key = m[3].toUpperCase()
      const { notes } = await post(peer, '/sync/pair', { port: SYNC_PORT, notes: store.exportNotes() }, key)
      store.setSetting('sync_secret', key)
      setPeers([...peers(), peer])
      merge(notes)
      state.lastSync = Date.now()
      state.error = null
    },
    unpair() {
      setPeers([])
      store.setSetting('sync_secret', randomCode())
      state.error = null
      state.lastSync = 0
    },
  }
}
