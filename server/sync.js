// Sincroniza as notas entre os aparelhos (o Mac e o celular) pela rede do Tailscale.
//
// Cada app abre a porta 4318. Ela só atende pedidos vindos de um endereço do
// Tailscale (100.64.0.0 a 100.127.255.255) e com o segredo combinado no
// pareamento. A cada 30 segundos, e logo depois de cada edição, o app manda
// todas as suas notas para o outro aparelho e recebe as dele de volta. Cada
// lado guarda a versão mais recente de cada nota.
//
// The same port also answers /sync/diag: a paired device asks how this
// device's WhatsApp connections are doing. The Mac uses it to read the phone's
// event recorder (see diag.js) without a cable. Same two checks as the notes.
import http from 'node:http'
import os from 'node:os'
import crypto from 'node:crypto'
import { cleanReport } from './diag.js'

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

const REPORT_MAX = 8_000_000 // bytes; a full recorder is about 2 MB

// A real report holds one object per recorder line (6,000 at most) and a few
// more. An answer with more opening brackets than this is not parsed: millions
// of nested or empty objects fit in 8 MB and cost hundreds of MB to parse.
const REPORT_BRACKETS = 100_000

// report(n) returns this device's connection report with the last n recorder
// lines. Without it, /sync/diag answers 404. reportWaitMs is how long this
// device waits for another device's report.
export function startSync({ store, onNotesChanged, report, reportWaitMs = 15000 }) {
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
      if (req.url === '/sync/diag' && report) {
        return reply(200, report(Number(body.n) || 800))
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
      // A redirect is never followed: the request, with the secret and the
      // notes in it, would be repeated to the address the answer names.
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `answer ${r.status}`)
    return data
  }

  // Asks one device for its report. Each failure has its own reason. The answer
  // is read piece by piece, to stop at the size limit, and then rebuilt field
  // by field (cleanReport), so the result has the report's fields and limits
  // whatever was sent.
  async function askReport(peer, n) {
    const res = await fetch(`http://${peer}/sync/diag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wc-sync': secret() },
      body: JSON.stringify({ n }),
      redirect: 'manual', // see post() above
      signal: AbortSignal.timeout(reportWaitMs),
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      if (res.status === 404) throw new Error('The app on that device is an older version. It cannot send its report.')
      if (res.status === 403) throw new Error('That device refused the request (answer 403). Pair the two devices again.')
      throw new Error(`That device answered ${res.status}.`)
    }
    if (!res.body) throw new Error('The answer is not a report.')
    const parts = []
    let size = 0
    let brackets = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      for (let i = 0; i < value.length; i++) if (value[i] === 0x7b || value[i] === 0x5b) brackets++
      if (size > REPORT_MAX || brackets > REPORT_BRACKETS) {
        await reader.cancel().catch(() => {})
        if (size > REPORT_MAX) throw new Error('The answer is larger than 8 MB. It was not read.')
        throw new Error('The answer holds more objects than a report can. It was not read.')
      }
      parts.push(value)
    }
    let data = null
    try {
      data = JSON.parse(Buffer.concat(parts).toString('utf8'))
    } catch {}
    if (!data || !Array.isArray(data.lines)) throw new Error('The answer is not a report.')
    return cleanReport(data)
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
    // Asks each paired device for its connection report (route /sync/diag), all
    // at the same time. One entry per device: the report, or `error` with the
    // reason when the device gave none. It answers within reportWaitMs.
    peerReports(n) {
      const reach = 'Is Tailscale on and the app open there?'
      return Promise.all(
        peers().map(async (peer) => {
          try {
            return { ...(await askReport(peer, n)), peer }
          } catch (e) {
            if (e.name === 'TimeoutError' || e.name === 'AbortError') {
              return { peer, error: `No complete answer in ${reportWaitMs / 1000} seconds. ${reach}` }
            }
            // "fetch failed" alone says nothing: the cause holds ECONNREFUSED, EHOSTUNREACH and so on.
            if (e.cause) return { peer, error: `The connection failed (${e.cause.code || e.cause.message || e.message}). ${reach}` }
            return { peer, error: e.message }
          }
        })
      )
    },
    // Pareia com o código mostrado no outro aparelho: "100.x.y.z/SEGREDO".
    async pair(code) {
      const m = /^\s*(100\.\d+\.\d+\.\d+)(?::(\d+))?\s*\/\s*([A-Z0-9]{8,})\s*$/i.exec(code || '')
      if (!m) throw new Error('The code looks like 100.64.0.1/ABCD2345EFGH.')
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
