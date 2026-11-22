// Conta de mentira, usada só para testar a tela e a regra de arquivar sem
// ligar um WhatsApp de verdade. Liga com: npm run demo
import { prettyNumber } from './hub.js'

let seq = 0
const now = () => Math.floor(Date.now() / 1000)

export class DemoAccount {
  constructor({ id, hub, store, onChange, seed }) {
    Object.assign(this, { id, hub, store, onChange, seed })
    this.status = 'idle'
    this.qr = null
    this.me = null
    this.error = null
    hub.setPusher(id, { archive: async () => {}, read: async () => {} })
  }

  view() {
    const { id, status, qr, me, error } = this
    return { id, status, qr, me, error }
  }

  async isLinked() {
    return true
  }

  msg(chatId, text, opts = {}) {
    return {
      kind: opts.kind || 'text',
      text,
      chatId,
      sendJid: chatId,
      id: `demo-${this.id}-${++seq}`,
      fromMe: !!opts.fromMe,
      sender: opts.sender || (opts.fromMe ? null : chatId),
      pushName: opts.pushName || '',
      ts: opts.ts || now(),
      raw: null,
    }
  }

  async connect() {
    if (this.status === 'open') return
    this.status = 'open'
    this.me = prettyNumber(this.seed.me)
    this.hub.quietly(() => {
      for (const c of this.seed.chats) {
        if (c.contact) this.hub.contact(this.id, c.id, c.contact, null)
        this.hub.chatInfo(this.id, c.id, { name: c.group, archived: !!c.archived, unread: c.unread || 0 })
        for (const m of c.messages) {
          this.hub.ingest(this.id, this.msg(c.id, m.text, { ...m, ts: now() - m.ago }), { live: false })
        }
      }
    })
    this.onChange()
    for (const r of this.seed.reactions || []) {
      const row = this.store.db
        .prepare('SELECT id FROM messages WHERE account = ? AND chat_id = ? AND text = ?')
        .get(this.id, r.chat, r.text)
      if (row) this.hub.reaction(this.id, r.chat, row.id, r.from, r.emoji)
    }
    for (const ev of this.seed.incoming || []) {
      setTimeout(() => {
        this.hub.ingest(this.id, this.msg(ev.chat, ev.text, ev), { live: true })
      }, ev.afterMs)
    }
  }

  async send(chatId, text) {
    this.hub.ingest(this.id, this.msg(chatId, text, { fromMe: true }), { live: false })
  }

  async media(chatId, msgId) {
    return this.files?.get(msgId) || null
  }

  // Na demonstração o arquivo fica numa pasta temporária, para a tela conseguir mostrar.
  async sendMedia(chatId, { kind, buffer, mime, caption }) {
    const { default: os } = await import('node:os')
    const { default: fsp } = await import('node:fs/promises')
    const { default: path } = await import('node:path')
    const m = this.msg(chatId, caption || '', { fromMe: true, kind })
    m.mime = kind === 'audio' ? 'audio/ogg; codecs=opus' : mime
    const dir = path.join(os.tmpdir(), 'wc-demo-media')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${m.id}.${kind === 'audio' ? 'ogg' : 'img'}`)
    await fsp.writeFile(file, buffer)
    ;(this.files ||= new Map()).set(m.id, { file, mime: m.mime.split(';')[0], fileName: '' })
    this.hub.ingest(this.id, m, { live: false })
  }

  async react(chatId, msgId, emoji) {
    const next = this.store.getReaction(this.id, chatId, msgId, 'me') === emoji ? '' : emoji
    this.hub.reaction(this.id, chatId, msgId, 'me', next)
  }

  wantAvatar() {}

  avatarFile() {
    return null
  }

  async discard() {}

  async logout() {
    this.store.wipeAccount(this.id)
    this.status = 'idle'
    this.me = null
    this.onChange()
    this.hub.events.emit('event', { type: 'reload' })
  }

  async stop() {}
}

export const demoSeeds = {
  br: {
    me: '5511900000001@s.whatsapp.net',
    chats: [
      {
        id: '5511911110001@s.whatsapp.net',
        contact: 'Marina Fornecedora',
        unread: 2,
        messages: [
          { text: 'Oi, tudo bem?', ago: 900 },
          { text: 'Tudo, e você?', ago: 800, fromMe: true },
          { text: 'O lote novo sai na quinta.', ago: 300 },
          { text: 'Posso mandar a nota hoje?', ago: 240 },
        ],
      },
      {
        id: '120363000000000001@g.us',
        group: 'Equipe Loja',
        messages: [
          { text: 'Pedido 1042 embalado.', ago: 5000, sender: '5511922220002@s.whatsapp.net', pushName: 'Caio' },
          { text: 'Boa, obrigado.', ago: 4800, fromMe: true },
        ],
      },
      {
        id: '5511933330003@s.whatsapp.net',
        contact: 'Contador Paulo',
        archived: true,
        messages: [{ text: 'Guia do mês enviada por email.', ago: 86400 * 3 }],
      },
      {
        id: '5511944440004@s.whatsapp.net',
        contact: 'Tia Lúcia',
        archived: true,
        messages: [{ text: 'Bom dia!', ago: 86400 * 6 }],
      },
    ],
    reactions: [
      { chat: '5511911110001@s.whatsapp.net', text: 'Tudo, e você?', from: '5511911110001@s.whatsapp.net', emoji: '👍' },
    ],
    incoming: [
      { afterMs: 6000, chat: '5511933330003@s.whatsapp.net', text: 'Preciso da sua assinatura até sexta.' },
    ],
  },
  us: {
    me: '14155550101@s.whatsapp.net',
    chats: [
      {
        id: '14155550111@s.whatsapp.net',
        contact: 'Sam Carter',
        unread: 1,
        messages: [
          { text: 'Can you review the failure list today?', ago: 1500 },
        ],
      },
      {
        id: '14155550122@s.whatsapp.net',
        contact: 'Landlord',
        archived: true,
        messages: [{ text: 'Rent received, thanks.', ago: 86400 * 10 }],
      },
    ],
    incoming: [],
  },
}
