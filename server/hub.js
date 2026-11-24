// Regras do app, iguais para a conta real e para o modo de demonstração.
// A regra principal: mensagem nova recebida em conversa arquivada tira a
// conversa do arquivo. O resto continua arquivado.
import { EventEmitter } from 'node:events'

const PREVIEW = {
  image: 'Photo',
  video: 'Video',
  audio: 'Voice message',
  document: 'Document',
  sticker: 'Sticker',
  contact: 'Contact',
  location: 'Location',
  poll: 'Poll',
  other: 'Message',
}

export function previewOf(msg) {
  if (msg.deleted) return 'Deleted message'
  if (msg.kind === 'text') return msg.text || ''
  const label = PREVIEW[msg.kind] || 'Message'
  return msg.text ? `${label}: ${msg.text}` : label
}

export function prettyNumber(jid) {
  const user = String(jid || '').split('@')[0].split(':')[0]
  if (!/^\d{8,}$/.test(user)) return user
  if (user.startsWith('55') && user.length >= 12) {
    const ddd = user.slice(2, 4)
    const rest = user.slice(4)
    return `+55 ${ddd} ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`
  }
  if (user.startsWith('1') && user.length === 11) {
    return `+1 (${user.slice(1, 4)}) ${user.slice(4, 7)}-${user.slice(7)}`
  }
  return `+${user}`
}

export function createHub(store) {
  const events = new EventEmitter()
  events.setMaxListeners(100)
  let quiet = 0 // durante a carga do histórico não avisamos a tela a cada linha

  const emit = (ev) => {
    if (quiet === 0) events.emit('event', ev)
  }

  function chatName(account, chat) {
    if (chat.name) return chat.name
    if (!chat.is_group) {
      const c = store.getContact(account, chat.id)
      if (c?.name) return c.name
      if (c?.notify) return c.notify
      return prettyNumber(chat.id)
    }
    return 'Group'
  }

  function viewChat(chat) {
    return {
      account: chat.account,
      id: chat.id,
      name: chatName(chat.account, chat),
      isGroup: !!chat.is_group,
      archived: !!chat.archived,
      unread: chat.unread,
      lastTs: chat.last_ts,
      lastText: chat.last_text || '',
      lastFromMe: !!chat.last_from_me,
      avatar: chat.avatar || 0, // 0 = sem foto; outro número = versão da foto
    }
  }

  function viewMessage(m, reactions) {
    return {
      account: m.account,
      chatId: m.chat_id,
      id: m.id,
      fromMe: !!m.from_me,
      senderName: m.sender_name || '',
      ts: m.ts,
      kind: m.kind,
      text: m.deleted ? '' : m.text || '',
      thumb: m.deleted ? '' : m.thumb || '',
      mime: m.mime || '',
      fileName: m.file_name || '',
      deleted: !!m.deleted,
      edited: !!m.edited,
      reactions: reactions || store.reactionsFor(m.account, m.chat_id, [m.id])[m.id] || [],
    }
  }

  function chatChanged(account, id) {
    const chat = store.getChat(account, id)
    if (chat) emit({ type: 'chat', chat: viewChat(chat) })
  }

  function messageChanged(account, chatId, id) {
    const row = store.getMessage(account, chatId, id)
    if (row) emit({ type: 'message', message: viewMessage(row), updated: true })
    return row
  }

  function senderName(account, senderJid, pushName) {
    if (!senderJid) return pushName || ''
    const c = store.getContact(account, senderJid)
    return c?.name || pushName || c?.notify || prettyNumber(senderJid)
  }

  // Ganchos que a conta real preenche para espelhar a mudança no WhatsApp.
  const pushers = new Map() // account -> { archive(chatId, archived), read(chatId, count) }

  const hub = {
    events,
    viewChat,
    viewMessage,
    chatChanged,

    setPusher(account, pusher) {
      pushers.set(account, pusher)
    },

    quietly(fn) {
      quiet++
      try {
        return store.transaction(fn)
      } finally {
        quiet--
        if (quiet === 0) events.emit('event', { type: 'reload' })
      }
    },

    listChats() {
      return store.listChats().map(viewChat)
    },

    listMessages(account, chatId, before, limit) {
      const rows = store.listMessages(account, chatId, before, limit)
      const reactions = store.reactionsFor(account, chatId, rows.map((r) => r.id))
      return rows.map((r) => viewMessage(r, reactions[r.id] || []))
    },

    contact(account, id, name, notify) {
      store.upsertContact(account, id, name, notify)
    },

    // Dados de uma conversa vindos do histórico ou de uma mudança feita no celular.
    chatInfo(account, id, info) {
      store.ensureChat(account, id, info.sendJid)
      const patch = {}
      if (info.sendJid) patch.send_jid = info.sendJid
      if (info.name) patch.name = info.name
      if (typeof info.archived === 'boolean') patch.archived = info.archived ? 1 : 0
      if (typeof info.unread === 'number') patch.unread = Math.max(0, info.unread)
      // Archived or read on another device: the user has dealt with what is stored here.
      if (info.archived === true || info.unread === 0) {
        const cur = store.getChat(account, id)
        patch.seen_ts = Math.max(cur.seen_ts || 0, cur.last_ts || 0)
      }
      if (info.markedUnread) patch.unread = Math.max(1, store.getChat(account, id).unread)
      if (info.lastTs) {
        const cur = store.getChat(account, id)
        if (info.lastTs > cur.last_ts) patch.last_ts = info.lastTs
      }
      store.patchChat(account, id, patch)
      chatChanged(account, id)
    },

    mergeChat(account, from, to) {
      if (store.mergeChat(account, from, to)) {
        emit({ type: 'chat-removed', account, id: from })
        chatChanged(account, to)
      }
    },

    // sender = 'me' ou o identificador de quem reagiu. emoji vazio remove a reação.
    reaction(account, chatId, msgId, sender, emoji) {
      store.setReaction(account, chatId, msgId, sender, emoji || '')
      messageChanged(account, chatId, msgId)
    },

    // Entrada de uma mensagem já traduzida (ver parse.js).
    // live = arrived now, while connected.
    // offline = WhatsApp held it while this app was disconnected (or while the
    //   server was holding messages back) and delivered it after a reconnect.
    // Neither = old history.
    ingest(account, p, { live, offline }) {
      const chatId = p.chatId

      if (p.kind === 'reaction') {
        hub.reaction(account, chatId, p.targetId, p.fromMe ? 'me' : p.sender || chatId, p.emoji)
        return
      }

      if (p.kind === 'revoke' || p.kind === 'edit') {
        if (!store.getMessage(account, chatId, p.targetId)) return
        store.patchMessage(
          account, chatId, p.targetId,
          p.kind === 'revoke' ? { deleted: 1 } : { text: p.text, edited: 1 }
        )
        const fresh = messageChanged(account, chatId, p.targetId)
        const last = store.lastMessage(account, chatId)
        if (last && last.id === p.targetId) {
          store.patchChat(account, chatId, { last_text: previewOf(fresh) })
          chatChanged(account, chatId)
        }
        return
      }

      const chat = store.ensureChat(account, chatId, p.sendJid)
      if (!p.fromMe && p.pushName && p.sender) store.upsertContact(account, p.sender, null, p.pushName)

      const isNew = store.insertMessage({
        account,
        chatId,
        id: p.id,
        fromMe: p.fromMe,
        sender: p.sender,
        senderName: p.fromMe ? '' : senderName(account, p.sender, p.pushName),
        ts: p.ts,
        kind: p.kind,
        text: p.text,
        thumb: p.thumb,
        mime: p.mime,
        fileName: p.fileName,
        raw: p.raw,
      })
      if (!isNew) return

      const patch = {}
      if (p.sendJid && p.sendJid !== chat.send_jid) patch.send_jid = p.sendJid
      if (p.ts >= chat.last_ts) {
        patch.last_ts = p.ts
        patch.last_text = previewOf(p)
        patch.last_from_me = p.fromMe ? 1 : 0
      }

      // A late message is new for the user when it is the newest in the chat and
      // newer than what the user already dealt with (read, answered, archived).
      // Before, late messages were stored as old history: no unread count, no
      // return to the inbox and no notification.
      const newest = p.ts >= chat.last_ts
      const late = !!offline && newest && p.ts > (chat.seen_ts || 0)
      const fresh = !p.fromMe && (!!live || late)
      const ageSec = Math.floor(Date.now() / 1000) - p.ts

      let unarchived = false
      if (fresh) {
        patch.unread = chat.unread + 1
        if (chat.archived) {
          patch.archived = 0
          unarchived = true
        }
      }
      // Resposta enviada por mim (daqui ou do celular) zera o contador.
      if (p.fromMe && (live || (offline && newest))) {
        if (chat.unread) patch.unread = 0
        patch.seen_ts = Math.max(chat.seen_ts || 0, p.ts)
      }

      store.patchChat(account, chatId, patch)
      const row = store.getMessage(account, chatId, p.id)
      // "live" makes the phone and the Mac show a notification. A late message
      // gets one only when it is under 6 hours old.
      emit({ type: 'message', message: viewMessage(row), live: !!live || (fresh && ageSec < 6 * 3600) })
      chatChanged(account, chatId)

      // Tell WhatsApp the chat left the archive. For a late message only when it
      // is recent: an older one may be followed by an archive done on the phone.
      if (unarchived && (live || ageSec < 600)) {
        pushers.get(account)?.archive(chatId, false).catch(() => {})
      }
      return fresh
    },

    // Pedido feito na tela.
    async setArchived(account, chatId, archived) {
      const chat = store.getChat(account, chatId)
      if (!chat) return
      const patch = { archived: archived ? 1 : 0 }
      if (archived) {
        patch.unread = 0
        patch.seen_ts = Math.max(chat.seen_ts || 0, chat.last_ts || 0)
      }
      store.patchChat(account, chatId, patch)
      chatChanged(account, chatId)
      await pushers.get(account)?.archive(chatId, archived).catch(() => {})
    },

    async markRead(account, chatId) {
      const chat = store.getChat(account, chatId)
      if (!chat || !chat.unread) return
      const count = chat.unread
      store.patchChat(account, chatId, { unread: 0, seen_ts: Math.max(chat.seen_ts || 0, chat.last_ts || 0) })
      chatChanged(account, chatId)
      await pushers.get(account)?.read?.(chatId, count).catch(() => {})
    },

    // The user read this chat on another device (the phone's WhatsApp, or the
    // other copy of this app), up to the message with time ts.
    readElsewhere(account, chatId, ts) {
      const chat = store.getChat(account, chatId)
      if (!chat || ts <= (chat.seen_ts || 0)) return
      const patch = { seen_ts: ts }
      if (chat.unread) patch.unread = Math.min(chat.unread, store.countIncomingAfter(account, chatId, ts))
      store.patchChat(account, chatId, patch)
      if (patch.unread !== undefined && patch.unread !== chat.unread) chatChanged(account, chatId)
    },

    accountsChanged(accounts) {
      events.emit('event', { type: 'accounts', accounts })
    },
  }
  return hub
}
