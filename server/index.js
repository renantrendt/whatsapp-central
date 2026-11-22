// Servidor local do app. Só aceita conexões deste próprio Mac (127.0.0.1) e
// exige um cookie secreto, criado a cada abertura, para qualquer dado.
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openStore } from './store.js'
import { createHub, previewOf } from './hub.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.join(here, '..', 'ui')
const demo = !!process.env.WC_DEMO
const port = Number(process.env.WC_PORT || 4319)
const dataDir =
  // A pasta mantém o nome antigo para não perder os dados de quem já usava o app.
  process.env.WC_DATA || path.join(os.homedir(), 'Library', 'Application Support', 'WhatsCentral')

if (!demo) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const store = openStore(demo ? ':memory:' : path.join(dataDir, 'app.db'))
const hub = createHub(store)
const token = crypto.randomBytes(24).toString('hex')

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
hub.events.on('event', (ev) => {
  if (ev.type === 'chat' && !ev.chat.archived) accounts.get(ev.chat.account)?.wantAvatar(ev.chat.id)
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
          "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      }
      if (name === 'index.html') headers['set-cookie'] = `wc=${token}; HttpOnly; SameSite=Strict; Path=/`
      res.writeHead(200, headers)
      return res.end(body)
    }

    if (!authorized(req)) return json(res, 401, { error: 'no access' })

    if (req.method === 'GET' && p === '/api/state') {
      const chats = hub.listChats()
      wantAvatars(chats)
      return json(res, 200, { accounts: accountViews(), chats, demo })
    }

    if (req.method === 'GET' && p === '/api/notes') {
      return json(res, 200, { notes: store.listNotes() })
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
        acc.connect()
        onChange()
        return json(res, 200, { id: acc.id })
      }

      if (p === '/api/notes/save') {
        const title = String(body.title || '').slice(0, 200)
        const html = String(body.body || '').slice(0, 1_500_000)
        return json(res, 200, { note: store.saveNote(Number(body.id) || null, title, html) })
      }
      if (p === '/api/notes/delete') {
        store.deleteNote(Number(body.id))
        return json(res, 200, { ok: true })
      }

      const acc = accounts.get(body.account)
      if (!acc) return json(res, 400, { error: 'unknown account' })

      if (p === '/api/connect') {
        acc.connect()
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
