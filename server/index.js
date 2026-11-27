// Servidor local do app. Só aceita conexões deste próprio Mac (127.0.0.1) e
// exige um cookie secreto, criado a cada abertura, para qualquer dado.
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'

// Node 20 and newer try each address of a host for only 250 ms before giving up.
// On a slow link (phone hotspot) every download from WhatsApp then failed with
// "fetch failed" (ETIMEDOUT), as seen on the Mac on 23/11. Give each try 2.5 s.
net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500)

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
import { createDiag, noDiag, accountState } from './diag.js'
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
// Event recorder for the connections (see diag.js). Read it at /api/diag.
const diag = demo ? noDiag : createDiag(dataDir)
diag.log('-', 'boot', { mobile: !!process.env.WC_MOBILE, node: process.version })
if (process.env.WC_MOBILE) {
  const brief = (e) => String(e?.stack || e).replace(/\d{8,}/g, '<n>').slice(0, 300)
  process.on('uncaughtException', (e) => diag.log('-', 'uncaught', { err: brief(e) }))
  process.on('unhandledRejection', (e) => diag.log('-', 'unhandled', { err: brief(e) }))
}
const hub = createHub(store)
// Sincronização das notas com o outro aparelho (não roda no modo de demonstração).
const sync = demo
  ? null
  : startSync({ store, onNotesChanged: () => hub.events.emit('event', { type: 'notes' }), report: (n) => selfReport(n) })
// No Android o app passa o segredo por WC_TOKEN, para o serviço de avisos também ler os eventos.
const token = /^[a-f0-9]{32,}$/.test(process.env.WC_TOKEN || '')
  ? process.env.WC_TOKEN
  : crypto.randomBytes(24).toString('hex')
const digits = (v) => (v == null ? undefined : String(v).replace(/\D/g, ''))

const accounts = new Map()
const accountViews = () => [...accounts.values()].map((a) => a.view())
const onChange = () => hub.accountsChanged(accountViews())

// How this device's WhatsApp connections are doing: each account's state, with
// no phone number and no message text (see accountState in diag.js). A paired
// device reads it over the notes link (route /sync/diag in sync.js), and
// /api/diag/peers shows both sides.
// - startedAt is the clock time when this process started.
// - upSec is the process's own count of running time. It can be shorter than
//   now - startedAt when the device slept.
// - starting is true until the accounts are loaded. Until then the account
//   list is not final: an empty list does not mean "no number on this device".
const bootAt = Date.now()
let started = false // true once the accounts are loaded
const newestChat = store.db.prepare('SELECT max(last_ts) AS t FROM chats WHERE account = ?')
function selfState() {
  const secret = store.getSetting('sync_secret')
  return {
    now: Date.now(),
    startedAt: bootAt,
    upSec: Math.round(process.uptime()),
    mobile: !!process.env.WC_MOBILE,
    starting: !started,
    accounts: [...accounts.values()].map((a) =>
      accountState(a, { newestChat: newestChat.get(a.id)?.t, number: store.getSetting(`num:${a.id}`), secret })
    ),
  }
}
// The report for a paired device: the state above, the recorder's last n lines
// and its counters not yet written. Reading it writes nothing to the recorder.
// It is served during start-up too: when a start fails, its lines say why.
function selfReport(n) {
  return { ...selfState(), pending: diag.pending(), lines: diag.tail(n) }
}

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
    if (/^[a-z0-9]+$/i.test(id)) accounts.set(id, new WaAccount({ id, dataDir, hub, store, onChange, diag }))
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
// HD copies saved before the app learned to skip them (see isHdCopy in parse.js).
// Only when the normal copy is saved too, so no photo or video disappears.
if (!demo) {
  const hasParent = store.db.prepare('SELECT 1 FROM messages WHERE account = ? AND chat_id = ? AND id = ?')
  const drop = store.db.prepare('DELETE FROM messages WHERE account = ? AND chat_id = ? AND id = ?')
  const rows = store.db
    .prepare("SELECT account, chat_id, id, raw FROM messages WHERE raw LIKE '%HD_VIDEO_DUAL_UPLOAD%' OR raw LIKE '%HD_IMAGE_DUAL_UPLOAD%'")
    .all()
  for (const r of rows) {
    let parent
    try {
      parent = JSON.parse(r.raw).message?.messageContextInfo?.messageAssociation?.parentMessageKey?.id
    } catch {}
    if (parent && hasParent.get(r.account, r.chat_id, parent)) drop.run(r.account, r.chat_id, r.id)
  }
}

// Linking a number again creates a new account id, and the old id keeps its chats,
// so every chat showed twice. This moves the old rows to the new account.
// An old id is one whose login folder is gone. It is merged only into a login of
// the SAME phone number. Two tests, in this order:
// 1. Both numbers are known (each login saves its number when it connects):
//    they must be equal.
// 2. A number is unknown: the two logins must share messages inside one-to-one
//    chats. Such a chat belongs to one number only, so two different numbers
//    never share its messages. (They do share group chats. Counting shared chats
//    was the old rule, and on 24/11 it moved one number's chats into the other.)
// Rows the new account already has are kept, the old copies are dropped.
// Only the local database and files change, never the WhatsApp connection.
async function mergeRelinked() {
  if (demo) return
  const live = [...accounts.values()].filter((a) => a.status === 'open')
  if (!live.length) return
  const olds = store.db.prepare('SELECT DISTINCT account FROM chats').all().map((r) => r.account)
  const numOf = (id) => store.getSetting(`num:${id}`)
  // Shared messages in the old login's 50 most recent one-to-one chats.
  const sharedDirect = store.db.prepare(
    `SELECT count(*) AS n FROM messages o
       JOIN messages n ON n.account = ? AND n.chat_id = o.chat_id AND n.id = o.id
      WHERE o.account = ? AND o.chat_id IN (
        SELECT id FROM chats WHERE account = ? AND is_group = 0 ORDER BY last_ts DESC LIMIT 50)`
  )
  for (const old of olds) {
    const gone = accounts.get(old)
    // Still a login here (linked, or waiting for its QR code): not an old id.
    if (gone && (gone.status !== 'idle' || fs.existsSync(path.join(dataDir, 'auth', old)))) continue
    const size = store.db.prepare('SELECT count(*) AS n FROM chats WHERE account = ?').get(old).n
    const oldNum = numOf(old)
    let best = null
    for (const a of live) {
      if (a.id === old) continue
      const num = numOf(a.id)
      if (oldNum && num) {
        if (oldNum !== num) continue
        best = { a, n: -1 }
        break
      }
      const n = sharedDirect.get(a.id, old, old).n
      if (n >= 5 && (!best || n > best.n)) best = { a, n }
    }
    if (!best) continue
    const to = best.a.id
    hub.quietly(() => {
      for (const t of ['messages', 'reactions', 'contacts']) {
        store.db.prepare(`UPDATE OR IGNORE ${t} SET account = ? WHERE account = ?`).run(to, old)
        store.db.prepare(`DELETE FROM ${t} WHERE account = ?`).run(old)
      }
      // A chat both have: keep the new row, but keep the old photo if the new one has none.
      store.db
        .prepare(
          `UPDATE chats SET avatar = (SELECT o.avatar FROM chats o WHERE o.account = ? AND o.id = chats.id)
           WHERE account = ? AND avatar = 0 AND id IN (SELECT id FROM chats WHERE account = ? AND avatar > 0)`
        )
        .run(old, to, old)
      store.db.prepare('UPDATE OR IGNORE chats SET account = ? WHERE account = ?').run(to, old)
      store.db.prepare('DELETE FROM chats WHERE account = ?').run(old)
    })
    // Saved photos, videos and profile pictures: move the files the new account lacks.
    for (const kind of ['media', 'avatars']) {
      const from = path.join(dataDir, kind, old)
      const dest = path.join(dataDir, kind, to)
      const files = await fsp.readdir(from).catch(() => null)
      if (!files) continue
      await fsp.mkdir(dest, { recursive: true })
      for (const f of files) {
        const target = path.join(dest, f)
        if (!fs.existsSync(target)) await fsp.rename(path.join(from, f), target).catch(() => {})
      }
      await fsp.rm(from, { recursive: true, force: true })
    }
    if (gone) {
      accounts.delete(old)
      onChange()
    }
    diag.log(to, 'merge', { from: old, chats: size, by: best.n < 0 ? 'same number' : `${best.n} shared direct messages` })
    console.log(`[merge] moved ${size} chats of an old login to the relinked account`)
  }
}
// History arrives a while after linking, so check again every 10 minutes.
setTimeout(() => mergeRelinked().catch((e) => console.error('[merge]', e)), 120000).unref?.()
setInterval(() => mergeRelinked().catch((e) => console.error('[merge]', e)), 600000).unref?.()

// Contas já ligadas reconectam sozinhas. Pastas de contas nunca ligadas são removidas.
for (const a of [...accounts.values()]) {
  if (await a.isLinked()) a.connect()
  else {
    await a.discard()
    accounts.delete(a.id)
  }
}
started = true

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

    // The event recorder, newest lines last (see diag.js). No message text in it.
    if (req.method === 'GET' && p === '/api/diag') {
      diag.flush()
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(`${diag.tail(Number(arg('n')) || 800).join('\n')}\n`)
    }

    // The same recorder on each paired device (the phone, seen from the Mac),
    // with each account's state there and here. See selfState above.
    if (req.method === 'GET' && p === '/api/diag/peers') {
      const peers = sync ? await sync.peerReports(Number(arg('n')) || 800) : []
      return json(res, 200, { here: selfState(), peers })
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

      // The phone screen turned on, or the app window came to the front: each
      // account tests its connection now (one ping). See WaAccount.wake.
      if (p === '/api/wake') {
        for (const a of accounts.values()) a.wake?.().catch(() => {})
        return json(res, 200, { ok: true })
      }

      if (p === '/api/connect-new') {
        if (demo) return json(res, 400, { error: 'Not available in demo mode.' })
        // Reaproveita uma conta que ainda está esperando o QR code.
        let acc = [...accounts.values()].find((a) => !a.me && a.status !== 'open')
        if (!acc) {
          const id = `a${Date.now().toString(36)}`
          acc = new WaAccount({ id, dataDir, hub, store, onChange, diag })
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

      // The other person's phone number, for the Android call button (null for groups).
      if (p === '/api/phone-for') {
        const chat = String(body.chat || '')
        const phone = chat && !chat.endsWith('@g.us') ? await acc.phoneFor(chat) : null
        return json(res, 200, { phone })
      }
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
