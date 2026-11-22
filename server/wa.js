// Uma conta de WhatsApp ligada como "aparelho conectado" (o mesmo mecanismo do
// WhatsApp Web). As chaves de acesso ficam na pasta authDir, só neste Mac.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import QRCode from 'qrcode'
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  assertMediaContent,
  jidNormalizedUser,
} from 'baileys'
import { parseContent, rawOf, fromRaw, toSeconds } from './parse.js'
import { prettyNumber } from './hub.js'

const debug = !!process.env.WC_DEBUG
const logger = {
  level: 'silent',
  child() {
    return logger
  },
  trace() {},
  debug() {},
  info() {},
  warn(...a) {
    if (debug) console.warn('[wa]', ...a)
  },
  error(...a) {
    if (debug) console.error('[wa]', ...a)
  },
  fatal(...a) {
    console.error('[wa fatal]', ...a)
  },
}

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
}

const skipJid = (jid) =>
  !jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')

export class WaAccount {
  constructor({ id, dataDir, hub, store, onChange }) {
    this.id = id
    this.hub = hub
    this.store = store
    this.onChange = onChange
    this.authDir = path.join(dataDir, 'auth', id)
    this.mediaDir = path.join(dataDir, 'media', id)
    this.avatarDir = path.join(dataDir, 'avatars', id)
    this.avatarQueue = []
    this.avatarQueued = new Set()
    this.avatarBusy = false
    this.status = 'idle' // idle | connecting | qr | open | blocked | replaced
    this.qr = null
    this.me = null
    this.error = null
    this.sock = null
    this.starting = false
    this.retries = 0
    this.timer = null
    this.queue = Promise.resolve()
    this.lidCache = new Map()

    hub.setPusher(id, {
      archive: (chatId, archived) => this.pushArchive(chatId, archived),
      read: (chatId, count) => this.pushRead(chatId, count),
    })
  }

  view() {
    return {
      id: this.id,
      status: this.status,
      qr: this.qr,
      me: this.me,
      error: this.error,
    }
  }

  set(patch) {
    Object.assign(this, patch)
    this.onChange()
  }

  async isLinked() {
    try {
      const raw = await fs.readFile(path.join(this.authDir, 'creds.json'), 'utf8')
      const me = JSON.parse(raw).me
      if (me?.id && !this.me) this.me = prettyNumber(me.id)
      return !!me
    } catch {
      return false
    }
  }

  enqueue(fn) {
    this.queue = this.queue.then(fn).catch((e) => {
      if (debug) console.error('[wa handler]', e)
    })
  }

  async canon(jid, alt) {
    if (!jid) return null
    const j = jidNormalizedUser(jid)
    if (!j.endsWith('@lid')) return j
    if (alt && alt.endsWith('@s.whatsapp.net')) {
      const pn = jidNormalizedUser(alt)
      this.lidCache.set(j, pn)
      return pn
    }
    if (this.lidCache.has(j)) return this.lidCache.get(j)
    try {
      const pn = await this.sock?.signalRepository?.lidMapping?.getPNForLID(j)
      if (pn) {
        const n = jidNormalizedUser(pn)
        this.lidCache.set(j, n)
        return n
      }
    } catch {}
    return j
  }

  async connect() {
    if (this.sock || this.starting) return
    this.starting = true
    clearTimeout(this.timer)
    this.stopped = false
    try {
      await fs.mkdir(this.authDir, { recursive: true })
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
      let version
      try {
        const v = await fetchLatestWaWebVersion()
        if (v?.version) version = v.version
      } catch {}

      this.set({ status: 'connecting', error: null })
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        logger,
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        markOnlineOnConnect: false, // o celular continua recebendo as notificações
        generateHighQualityLinkPreview: false,
        getMessage: async (key) => {
          const row = this.store.findMessageById(this.id, key.id)
          return row?.raw ? fromRaw(row.raw).message : undefined
        },
      })
      this.sock = sock

      sock.ev.on('creds.update', saveCreds)
      sock.ev.on('connection.update', (u) => this.onConnection(sock, state, u))
      sock.ev.on('messaging-history.set', (h) => this.enqueue(() => this.onHistory(h)))
      sock.ev.on('messages.upsert', ({ messages, type }) =>
        this.enqueue(async () => {
          for (const m of messages) await this.onMessage(m, type === 'notify')
        })
      )
      sock.ev.on('messages.update', (updates) =>
        this.enqueue(async () => {
          for (const u of updates) await this.onMessageUpdate(u)
        })
      )
      sock.ev.on('messages.reaction', (list) =>
        this.enqueue(async () => {
          for (const r of list) await this.onReaction(r.key, r.reaction)
        })
      )
      sock.ev.on('chats.upsert', (chats) => this.enqueue(() => this.onChats(chats)))
      sock.ev.on('chats.update', (chats) => this.enqueue(() => this.onChats(chats)))
      sock.ev.on('contacts.upsert', (c) => this.enqueue(() => this.onContacts(c)))
      sock.ev.on('contacts.update', (c) => this.enqueue(() => this.onContacts(c)))
      sock.ev.on('groups.upsert', (g) => this.enqueue(() => this.onGroups(g)))
      sock.ev.on('groups.update', (g) => this.enqueue(() => this.onGroups(g)))
      sock.ev.on('lid-mapping.update', ({ lid, pn }) =>
        this.enqueue(() => {
          if (!lid || !pn) return
          const l = jidNormalizedUser(lid)
          const p = jidNormalizedUser(pn)
          this.lidCache.set(l, p)
          this.hub.mergeChat(this.id, l, p)
        })
      )
    } catch (e) {
      this.sock = null
      this.set({ status: 'idle', error: `Could not start: ${e.message}` })
    } finally {
      this.starting = false
    }
  }

  async onConnection(sock, state, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return
    if (qr) {
      const img = await QRCode.toDataURL(qr, { margin: 1, width: 320 })
      this.set({ status: 'qr', qr: img })
    }
    if (connection === 'open') {
      this.retries = 0
      this.set({
        status: 'open',
        qr: null,
        error: null,
        me: prettyNumber(sock.user?.id || ''),
      })
      this.enqueue(() => this.loadGroupNames())
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      this.sock = null
      const linked = !!state.creds.me

      if (code === DisconnectReason.loggedOut) {
        await fs.rm(this.authDir, { recursive: true, force: true })
        this.set({ status: 'idle', qr: null, me: null, error: 'This account was disconnected from the phone.' })
        return
      }
      if (code === DisconnectReason.forbidden) {
        this.set({ status: 'blocked', qr: null, error: 'WhatsApp refused this connection (code 403).' })
        return
      }
      if (code === DisconnectReason.connectionReplaced) {
        this.set({ status: 'replaced', qr: null, error: 'Another window opened this same session.' })
        return
      }
      if (this.stopped) {
        this.set({ status: 'idle', qr: null })
        return
      }
      if (!linked && code !== DisconnectReason.restartRequired) {
        // O QR code venceu sem ser lido. Para aqui até a pessoa pedir de novo.
        this.set({ status: 'idle', qr: null, error: 'The QR code expired.' })
        return
      }
      const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(30000, 2000 * 2 ** this.retries++)
      this.set({ status: 'connecting', qr: null })
      this.timer = setTimeout(() => this.connect(), wait)
    }
  }

  async loadGroupNames() {
    try {
      const groups = await this.sock.groupFetchAllParticipating()
      this.hub.quietly(() => {
        for (const g of Object.values(groups)) {
          if (g?.id && g.subject) this.hub.chatInfo(this.id, g.id, { name: g.subject })
        }
      })
    } catch {}
  }

  async onHistory({ chats = [], contacts = [], messages = [], lidPnMappings = [] }) {
    for (const m of lidPnMappings) {
      if (m?.lid && m?.pn) this.lidCache.set(jidNormalizedUser(m.lid), jidNormalizedUser(m.pn))
    }
    const chatRows = []
    for (const c of chats) {
      if (skipJid(c.id)) continue
      const id = await this.canon(c.id, c.pnJid)
      chatRows.push({ id, c })
    }
    const msgRows = []
    const reactRows = []
    for (const m of messages) {
      const p = await this.translate(m)
      if (!p) continue
      msgRows.push(p)
      for (const r of m.reactions || []) {
        const who = await this.reactor(r.key, p.chatId)
        if (who && r.text) reactRows.push([p.chatId, p.id, who, r.text])
      }
    }
    this.hub.quietly(() => {
      this.saveContacts(contacts)
      for (const { id, c } of chatRows) {
        this.hub.chatInfo(this.id, id, {
          sendJid: jidNormalizedUser(c.id),
          name: c.name || undefined,
          archived: !!c.archived,
          unread: typeof c.unreadCount === 'number' ? c.unreadCount : undefined,
          markedUnread: c.unreadCount < 0 || c.markedAsUnread,
        })
      }
      for (const p of msgRows) this.hub.ingest(this.id, p, { live: false })
      for (const r of reactRows) this.hub.reaction(this.id, ...r)
    })
  }

  saveContacts(contacts) {
    for (const c of contacts) {
      for (const jid of [c.id, c.lid, c.phoneNumber]) {
        if (jid) this.hub.contact(this.id, jidNormalizedUser(jid), c.name, c.notify)
      }
    }
  }

  onContacts(contacts) {
    this.hub.quietly(() => this.saveContacts(contacts))
  }

  onGroups(groups) {
    for (const g of groups) {
      if (g?.id && g.subject) this.hub.chatInfo(this.id, g.id, { name: g.subject })
    }
  }

  async onChats(chats) {
    for (const c of chats) {
      if (skipJid(c.id)) continue
      const id = await this.canon(c.id, c.pnJid)
      const info = {}
      if (typeof c.archived === 'boolean') info.archived = c.archived
      // Contagem positiva é ignorada: quem conta as novas é o próprio app.
      if (c.unreadCount === 0) info.unread = 0
      if (typeof c.unreadCount === 'number' && c.unreadCount < 0) info.markedUnread = true
      if (!Object.keys(info).length) continue
      if (!this.store.getChat(this.id, id)) continue
      this.hub.chatInfo(this.id, id, info)
    }
  }

  async translate(m) {
    const key = m?.key
    if (!key?.remoteJid || !key.id || skipJid(key.remoteJid)) return null
    const parsed = parseContent(m)
    if (!parsed) return null
    const chatId = await this.canon(key.remoteJid, key.remoteJidAlt)
    const isGroup = chatId.endsWith('@g.us')
    let sender = null
    if (!key.fromMe) sender = isGroup ? await this.canon(key.participant, key.participantAlt) : chatId
    const special = ['revoke', 'edit', 'reaction'].includes(parsed.kind)
    return {
      ...parsed,
      chatId,
      sendJid: jidNormalizedUser(key.remoteJid),
      id: key.id,
      fromMe: !!key.fromMe,
      sender,
      pushName: m.pushName || '',
      ts: toSeconds(m.messageTimestamp) || Math.floor(Date.now() / 1000),
      raw: special ? null : rawOf(m),
    }
  }

  // Quem reagiu, a partir da chave da própria reação.
  async reactor(key, chatId) {
    if (!key) return null
    if (key.fromMe) return 'me'
    if (chatId.endsWith('@g.us')) return this.canon(key.participant, key.participantAlt)
    return chatId
  }

  async onReaction(targetKey, reaction) {
    if (!targetKey?.remoteJid || !targetKey.id || skipJid(targetKey.remoteJid)) return
    const chatId = await this.canon(targetKey.remoteJid, targetKey.remoteJidAlt)
    const who = await this.reactor(reaction?.key, chatId)
    if (who) this.hub.reaction(this.id, chatId, targetKey.id, who, reaction.text || '')
  }

  async react(chatId, msgId, emoji) {
    if (!this.sock || this.status !== 'open') throw new Error('Account is offline.')
    const row = this.store.getMessage(this.id, chatId, msgId)
    if (!row?.raw) throw new Error('Message not found.')
    // Clicar no mesmo emoji de novo remove a reação.
    const next = this.store.getReaction(this.id, chatId, msgId, 'me') === emoji ? '' : emoji
    await this.sock.sendMessage(this.jidFor(chatId), { react: { text: next, key: fromRaw(row.raw).key } })
    this.hub.reaction(this.id, chatId, msgId, 'me', next)
  }

  // Foto de perfil: baixa uma vez, guarda no Mac e confere de novo a cada 7 dias.
  avatarFile(chatId) {
    const name = crypto.createHash('sha1').update(chatId).digest('hex')
    return path.join(this.avatarDir, `${name}.jpg`)
  }

  wantAvatar(chatId) {
    if (this.status !== 'open' || this.avatarQueued.has(chatId)) return
    const chat = this.store.getChat(this.id, chatId)
    if (!chat || Date.now() / 1000 - chat.avatar_checked < 7 * 86400) return
    this.avatarQueued.add(chatId)
    this.avatarQueue.push(chatId)
    this.pumpAvatars()
  }

  async pumpAvatars() {
    if (this.avatarBusy) return
    this.avatarBusy = true
    try {
      while (this.avatarQueue.length && this.sock && this.status === 'open') {
        const chatId = this.avatarQueue.shift()
        const now = Math.floor(Date.now() / 1000)
        let saved = 0
        try {
          const url = await this.sock.profilePictureUrl(this.jidFor(chatId), 'preview')
          const host = url ? new URL(url).hostname : ''
          if (url && url.startsWith('https://') && host.endsWith('.whatsapp.net')) {
            const res = await fetch(url)
            if (res.ok) {
              await fs.mkdir(this.avatarDir, { recursive: true })
              await fs.writeFile(this.avatarFile(chatId), Buffer.from(await res.arrayBuffer()))
              saved = now
            }
          }
        } catch {}
        this.store.patchChat(this.id, chatId, { avatar: saved, avatar_checked: now })
        this.avatarQueued.delete(chatId)
        if (saved) this.hub.chatChanged(this.id, chatId)
        await new Promise((r) => setTimeout(r, 400))
      }
    } finally {
      this.avatarBusy = false
    }
  }

  async onMessage(m, live) {
    const p = await this.translate(m)
    if (p) this.hub.ingest(this.id, p, { live })
  }

  async onMessageUpdate({ key, update }) {
    if (!key?.remoteJid || !key.id || !update || skipJid(key.remoteJid)) return
    const chatId = await this.canon(key.remoteJid, key.remoteJidAlt)
    if (update.message === null) {
      this.hub.ingest(this.id, { kind: 'revoke', chatId, targetId: key.id }, { live: true })
    } else if (update.message?.editedMessage?.message) {
      const p = parseContent({ message: update.message.editedMessage.message })
      if (p && typeof p.text === 'string') {
        this.hub.ingest(this.id, { kind: 'edit', chatId, targetId: key.id, text: p.text }, { live: true })
      }
    }
  }

  jidFor(chatId) {
    return this.store.getChat(this.id, chatId)?.send_jid || chatId
  }

  async send(chatId, text) {
    if (!this.sock || this.status !== 'open') throw new Error('Account is offline.')
    const sent = await this.sock.sendMessage(this.jidFor(chatId), { text })
    if (sent) this.enqueue(() => this.onMessage(sent, false))
  }

  async pushArchive(chatId, archived) {
    if (!this.sock || this.status !== 'open') return
    const last = this.store.lastMessage(this.id, chatId)
    if (!last?.raw) return
    const { key, messageTimestamp } = fromRaw(last.raw)
    await this.sock.chatModify(
      { archive: archived, lastMessages: [{ key, messageTimestamp }] },
      this.jidFor(chatId)
    )
  }

  async pushRead(chatId, count) {
    if (!this.sock || this.status !== 'open') return
    const raws = this.store.recentIncomingRaw(this.id, chatId, Math.min(count, 50))
    const keys = raws.map((r) => fromRaw(r).key)
    if (keys.length) await this.sock.readMessages(keys)
  }

  async media(chatId, msgId) {
    const row = this.store.getMessage(this.id, chatId, msgId)
    if (!row?.raw) return null
    const mime = (row.mime || 'application/octet-stream').split(';')[0].trim()
    const ext = EXT[mime] || 'bin'
    const file = path.join(this.mediaDir, `${msgId.replace(/[^A-Za-z0-9_-]/g, '')}.${ext}`)
    try {
      await fs.access(file)
    } catch {
      if (!this.sock) return null
      let msg = fromRaw(row.raw)
      // A chave da mídia pode vir como texto. O pedido de reenvio ao celular
      // só funciona com a chave em bytes.
      try {
        const content = assertMediaContent(msg.message)
        if (typeof content.mediaKey === 'string') content.mediaKey = Buffer.from(content.mediaKey, 'base64')
      } catch {}
      let buf
      try {
        buf = await downloadMediaMessage(msg, 'buffer', {}, { logger })
      } catch (e) {
        // Mídia antiga vence no servidor do WhatsApp (erros 404, 410 e 403).
        // Nesse caso o app pede ao celular para enviar o arquivo de novo.
        const code = e?.output?.statusCode ?? e?.status
        if (![403, 404, 410].includes(code) || this.status !== 'open') throw e
        msg = await Promise.race([
          this.sock.updateMediaMessage(msg),
          new Promise((_, no) => setTimeout(() => no(new Error('phone did not answer')), 25000)),
        ])
        buf = await downloadMediaMessage(msg, 'buffer', {}, { logger })
        this.store.patchMessage(this.id, chatId, msgId, { raw: rawOf(msg) })
      }
      await fs.mkdir(this.mediaDir, { recursive: true })
      await fs.writeFile(file, buf)
    }
    return { file, mime, fileName: row.file_name }
  }

  // Desliga a conta neste Mac e apaga as chaves e as conversas dela daqui.
  async logout() {
    this.stopped = true
    clearTimeout(this.timer)
    try {
      await this.sock?.logout()
    } catch {}
    try {
      this.sock?.end?.(undefined)
    } catch {}
    this.sock = null
    await fs.rm(this.authDir, { recursive: true, force: true })
    await fs.rm(this.mediaDir, { recursive: true, force: true })
    await fs.rm(this.avatarDir, { recursive: true, force: true })
    this.store.wipeAccount(this.id)
    this.set({ status: 'idle', qr: null, me: null, error: null })
    this.hub.events.emit('event', { type: 'reload' })
  }

  // Desiste de uma conta que nunca chegou a ser ligada (QR code não lido).
  async discard() {
    await this.stop()
    await fs.rm(this.authDir, { recursive: true, force: true })
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    try {
      this.sock?.end?.(undefined)
    } catch {}
    this.sock = null
  }
}
