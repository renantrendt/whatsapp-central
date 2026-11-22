// Servidor local do app. Só aceita conexões deste próprio Mac (127.0.0.1) e
// exige um cookie secreto, criado a cada abertura, para qualquer dado.
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'

// O Node 18 (usado no Android) não expõe globalThis.crypto, que a biblioteca de WhatsApp usa.
if (!globalThis.crypto) globalThis.crypto = webcrypto

// O Node do Android vem sem ICU (a biblioteca de textos internacionais) e recusa
// new TextDecoder(..., { fatal: true }). Sem ICU, o mesmo leitor funciona sem essa opção.
try {
  new TextDecoder('utf-8', { fatal: true })
} catch {
  const Base = globalThis.TextDecoder
  globalThis.TextDecoder = class extends Base {
    constructor(label, opts = {}) {
      const { fatal, ...rest } = opts
      super(label, rest)
    }
  }
}

// No celular o servidor roda dentro do app: um erro inesperado não pode fechar o app inteiro.
if (process.env.WC_MOBILE) {
  process.on('uncaughtException', (e) => console.error('[uncaught]', e))
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e))
}
import { openStore } from './store.js'
import { createHub, previewOf } from './hub.js'
import { startSync } from './sync.js'
import { webmToOgg } from './ogg.js'
import { EventEmitter } from 'node:events'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.join(here, '..', 'ui')
const demo = !!process.env.WC_DEMO
const port = Number(process.env.WC_PORT || 4319)
const dataDir =
  // A pasta mantém o nome antigo para não perder os dados de quem já usava o app.
  process.env.WC_DATA || path.join(os.homedir(), 'Library', 'Application Support', 'WhatsCentral')

if (!demo) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const store = await openStore(demo ? ':memory:' : path.join(dataDir, 'app.db'))
const hub = createHub(store)
// Sincronização das notas com o outro aparelho (não roda no modo de demonstração).
const sync = demo ? null : startSync({ store, onNotesChanged: () => hub.events.emit('event', { type: 'notes' }) })
// No Android o app passa o segredo por WC_TOKEN, para o serviço de avisos também ler os eventos.
const token = /^[a-f0-9]{32,}$/.test(process.env.WC_TOKEN || '')
  ? process.env.WC_TOKEN
  : crypto.randomBytes(24).toString('hex')
const digits = (v) => (v == null ? undefined : String(v).replace(/\D/g, ''))

const accounts = new Map()
const accountViews = () => [...accounts.values()].map((a) => a.view())
const onChange = () => hub.accountsChanged(accountViews())

let WaAccount = null
if (demo) {
  const { DemoAccount, demoSeeds } = await import('./demo.js')
  for (const id of Object.keys(demoSeeds)) {
    accounts.set(id, new DemoAccount({ id, hub, store, onChange, seed: demoSeeds[id] }))
  }
} else {
  ;({ WaAccount } = await import('./wa.js'))
  // Cada pasta dentro de auth/ é uma conta já criada neste Mac.
  const dirs = await fsp.readdir(path.join(dataDir, 'auth')).catch(() => [])
  for (const id of dirs) {
    if (/^[a-z0-9]+$/i.test(id)) accounts.set(id, new WaAccount({ id, dataDir, hub, store, onChange }))
  }
}

// Ajustes feitos uma única vez em bancos de versões antigas.
if (store.version() < 2) {
  const { parseContent, fromRaw } = await import('./parse.js')
  store.transaction(() => {
    // Mensagens que a versão 1 guardou como "tipo desconhecido".
    const others = store.db.prepare("SELECT account, chat_id, id, raw FROM messages WHERE kind = 'other'").all()
    for (const r of others) {
      try {
        const p = parseContent(fromRaw(r.raw))
        if (p && p.kind === 'text') store.patchMessage(r.account, r.chat_id, r.id, { kind: 'text', text: p.text })
      } catch {}
    }
    // Resumo da última mensagem, que a versão 1 gravou em português.
    for (const c of store.db.prepare('SELECT account, id FROM chats WHERE last_ts > 0').all()) {
      const last = store.lastMessage(c.account, c.id)
      if (last) store.patchChat(c.account, c.id, { last_text: previewOf(last) })
    }
  })
  store.setVersion(2)
}

// Conversas sem foto são conferidas de novo a cada abertura (só as que aparecem na tela).
if (!demo) store.db.prepare('UPDATE chats SET avatar_checked = 0 WHERE avatar = 0').run()

// Contas já ligadas reconectam sozinhas. Pastas de contas nunca ligadas são removidas.
for (const a of [...accounts.values()]) {
  if (await a.isLinked()) a.connect()
  else {
    await a.discard()
    accounts.delete(a.id)
  }
}

function wantAvatars(chats) {
  let archived = 0
  for (const c of chats) {
    if (c.archived && ++archived > 60) continue
    accounts.get(c.account)?.wantAvatar(c.id)
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const sseClients = new Set()
// Ponte com a janela do Mac (electron/main.cjs): pedidos para abrir a janela de
// ligações (o WhatsApp Web oficial) de um número.
export const calls = new EventEmitter()
const callsAvailable = !!process.env.WC_CALLS
const accountLabel = (id) => accounts.get(id)?.me || 'WhatsApp'

hub.events.on('event', (ev) => {
  if (ev.type === 'chat' && !ev.chat.archived) accounts.get(ev.chat.account)?.wantAvatar(ev.chat.id)
  if (ev.type === 'call') calls.emit('incoming', { account: ev.account, label: accountLabel(ev.account) })
  const line = `data: ${JSON.stringify(ev)}\n\n`
  for (const res of sseClients) res.write(line)
})

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

// Envia um arquivo aceitando pedidos "por pedaço" (cabeçalho Range). O tocador
// de áudio e vídeo do Chromium depende disso para tocar e para avançar.
async function sendFile(req, res, file, headers) {
  const { size } = await fsp.stat(file)
  const base = { ...headers, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      return res.end()
    }
    res.writeHead(206, {
      ...base,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    })
    return fs.createReadStream(file, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...base, 'content-length': size })
  fs.createReadStream(file).pipe(res)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', (c) => {
      size += c.length
      if (size > 2_000_000) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      parts.push(c)
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

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('file too large'))
        req.destroy()
        return
      }
      parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

function authorized(req) {
  const cookie = req.headers.cookie || ''
  const m = cookie.match(/(?:^|;\s*)wc=([a-f0-9]+)/)
  if (!m) return false
  const a = Buffer.from(m[1])
  const b = Buffer.from(token)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const server = http.createServer(async (req, res) => {
  try {
    // Bloqueia páginas de outros sites tentando falar com o app pelo navegador.
    if (!hosts.has(req.headers.host || '')) return json(res, 403, { error: 'host' })
    const origin = req.headers.origin
    if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'origin' })

    const url = new URL(req.url, `http://${req.headers.host}`)
    const p = url.pathname
    const arg = (k) => url.searchParams.get(k)

    if (req.method === 'GET' && !p.startsWith('/api/')) {
      const name = p === '/' ? 'index.html' : p.slice(1)
      if (!/^[a-z0-9.-]+$/i.test(name) || !TYPES[path.extname(name)]) return json(res, 404, {})
      const file = path.join(uiDir, name)
      const body = await fsp.readFile(file).catch(() => null)
      if (!body) return json(res, 404, {})
      const headers = {
        'content-type': TYPES[path.extname(name)],
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      }
      if (name === 'index.html') headers['set-cookie'] = `wc=${token}; HttpOnly; SameSite=Strict; Path=/`
      res.writeHead(200, headers)
      return res.end(body)
    }

    if (!authorized(req)) return json(res, 401, { error: 'no access' })

    if (req.method === 'GET' && p === '/api/state') {
      const chats = hub.listChats()
      wantAvatars(chats)
      return json(res, 200, { accounts: accountViews(), chats, demo, calls: callsAvailable })
    }

    if (req.method === 'GET' && p === '/api/notes') {
      return json(res, 200, { notes: store.listNotes() })
    }

    if (req.method === 'GET' && p === '/api/sync') {
      return json(res, 200, sync ? sync.status() : { code: null, peers: [], lastSync: 0, error: 'Not available in demo mode.' })
    }

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write('retry: 2000\n\n')
      sseClients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 25000)
      req.on('close', () => {
        clearInterval(ping)
        sseClients.delete(res)
      })
      return
    }

    if (req.method === 'GET' && p === '/api/messages') {
      const before = Number(arg('before')) || 9e12
      const limit = Math.min(Number(arg('limit')) || 60, 200)
      accounts.get(arg('account'))?.wantAvatar(arg('chat'))
      return json(res, 200, { messages: hub.listMessages(arg('account'), arg('chat'), before, limit) })
    }

    if (req.method === 'GET' && p === '/api/media') {
      const acc = accounts.get(arg('account'))
      let why = 'media unavailable'
      const m = acc && (await acc.media(arg('chat'), arg('id')).catch((e) => {
        why = String(e?.message || why).replace(/https?:\/\/\S+/g, '(url)')
        return null
      }))
      if (!m) return json(res, 404, { error: why })
      const headers = { 'content-type': m.mime, 'cache-control': 'private, max-age=86400' }
      if (m.fileName) {
        headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(m.fileName)}`
      }
      return sendFile(req, res, m.file, headers)
    }

    if (req.method === 'GET' && p === '/api/avatar') {
      const file = accounts.get(arg('account'))?.avatarFile(arg('chat'))
      if (!file || !(await fsp.stat(file).catch(() => null))) return json(res, 404, {})
      return sendFile(req, res, file, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=604800' })
    }

    // Foto ou mensagem de voz: o corpo do pedido é o próprio arquivo.
    if (req.method === 'POST' && p === '/api/send-file') {
      const acc = accounts.get(arg('account'))
      if (!acc) return json(res, 400, { error: 'unknown account' })
      const kind = arg('kind')
      let mime = String(arg('mime') || '').toLowerCase()
      let buffer = await readRaw(req, 64 * 1024 * 1024)
      if (!buffer.length) return json(res, 400, { error: 'empty file' })
      if (kind === 'image' && !/^image\/(jpeg|png|webp|gif)$/.test(mime)) {
        return json(res, 400, { error: 'Only JPEG, PNG, WebP or GIF images.' })
      }
      if (kind === 'audio') {
        if (mime.startsWith('audio/webm')) buffer = webmToOgg(buffer)
        else if (!mime.startsWith('audio/ogg')) return json(res, 400, { error: 'Recording format not supported.' })
        mime = 'audio/ogg; codecs=opus'
      }
      const waveform = arg('waveform') ? Buffer.from(arg('waveform'), 'base64') : undefined
      await acc.sendMedia(arg('chat'), {
        kind,
        buffer,
        mime,
        caption: String(arg('caption') || '').slice(0, 4000),
        seconds: Number(arg('seconds')) || 0,
        waveform,
      })
      return json(res, 200, { ok: true })
    }

    if (req.method === 'POST') {
      const body = await readBody(req)

      if (p === '/api/connect-new') {
        if (demo) return json(res, 400, { error: 'Not available in demo mode.' })
        // Reaproveita uma conta que ainda está esperando o QR code.
        let acc = [...accounts.values()].find((a) => !a.me && a.status !== 'open')
        if (!acc) {
          const id = `a${Date.now().toString(36)}`
          acc = new WaAccount({ id, dataDir, hub, store, onChange })
          accounts.set(id, acc)
        }
        acc.connect(digits(body.phone))
        onChange()
        return json(res, 200, { id: acc.id })
      }

      if (p === '/api/notes/save') {
        const title = String(body.title || '').slice(0, 200)
        const html = String(body.body || '').slice(0, 1_500_000)
        const note = store.saveNote(Number(body.id) || null, title, html)
        sync?.changed()
        hub.events.emit('event', { type: 'notes-local' })
        return json(res, 200, { note })
      }
      if (p === '/api/notes/delete') {
        store.deleteNote(Number(body.id))
        sync?.changed()
        hub.events.emit('event', { type: 'notes-local' })
        return json(res, 200, { ok: true })
      }
      if (p === '/api/sync/pair') {
        if (!sync) return json(res, 400, { error: 'Not available in demo mode.' })
        await sync.pair(String(body.code || ''))
        return json(res, 200, sync.status())
      }
      if (p === '/api/sync/unpair') {
        sync?.unpair()
        return json(res, 200, { ok: true })
      }

      const acc = accounts.get(body.account)
      if (!acc) return json(res, 400, { error: 'unknown account' })

      if (p === '/api/call' || p === '/api/calls/setup') {
        if (!callsAvailable) return json(res, 400, { error: 'Calls are only available in the Mac app.' })
        const phone = p === '/api/call' && body.chat ? await acc.phoneFor(String(body.chat)) : null
        calls.emit('open', { account: acc.id, label: accountLabel(acc.id), phone })
        return json(res, 200, { ok: true, phone: !!phone })
      }
      if (p === '/api/connect') {
        // Trocar entre QR code e código por número reinicia a tentativa de ligação.
        if ('phone' in body) await acc.stop()
        acc.connect('phone' in body ? digits(body.phone) || '' : undefined)
        return json(res, 200, { ok: true })
      }
      if (p === '/api/cancel') {
        // Fechou a janela do QR code sem ligar a conta.
        if (acc.status !== 'open' && !(await acc.isLinked())) {
          await acc.discard()
          accounts.delete(acc.id)
          onChange()
        }
        return json(res, 200, { ok: true })
      }
      if (p === '/api/logout') {
        await acc.logout()
        accounts.delete(acc.id)
        onChange()
        return json(res, 200, { ok: true })
      }
      if (p === '/api/send') {
        const text = String(body.text || '').trim()
        if (!text || !body.chat) return json(res, 400, { error: 'empty message' })
        await acc.send(body.chat, text)
        return json(res, 200, { ok: true })
      }
      if (p === '/api/react') {
        await acc.react(body.chat, body.id, String(body.emoji || ''))
        return json(res, 200, { ok: true })
      }
      if (p === '/api/archive') {
        await hub.setArchived(body.account, body.chat, !!body.archived)
        return json(res, 200, { ok: true })
      }
      if (p === '/api/read') {
        await hub.markRead(body.account, body.chat)
        return json(res, 200, { ok: true })
      }
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: e.message || 'error' })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Whatsapp Central on http://127.0.0.1:${port}${demo ? ' (demo)' : ''}`)
})

export async function shutdown() {
  for (const a of accounts.values()) await a.stop()
  server.close()
}
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)))
