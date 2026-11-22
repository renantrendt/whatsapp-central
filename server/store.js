// Banco local (SQLite) com conversas, mensagens e contatos das duas contas.
// Tudo fica em um arquivo neste Mac. Nada sai do computador por aqui.
import { DatabaseSync } from 'node:sqlite'

export function openStore(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS chats (
      account TEXT NOT NULL,
      id TEXT NOT NULL,
      send_jid TEXT,
      name TEXT,
      is_group INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      unread INTEGER NOT NULL DEFAULT 0,
      last_ts INTEGER NOT NULL DEFAULT 0,
      last_text TEXT,
      last_from_me INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account, id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      account TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      id TEXT NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0,
      sender TEXT,
      sender_name TEXT,
      ts INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      text TEXT,
      thumb TEXT,
      mime TEXT,
      file_name TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      edited INTEGER NOT NULL DEFAULT 0,
      raw TEXT,
      PRIMARY KEY (account, chat_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_by_time ON messages (account, chat_id, ts);
    CREATE TABLE IF NOT EXISTS reactions (
      account TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      emoji TEXT NOT NULL,
      PRIMARY KEY (account, chat_id, msg_id, sender)
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      items TEXT NOT NULL DEFAULT '[]',
      created INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS contacts (
      account TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT,
      notify TEXT,
      PRIMARY KEY (account, id)
    );
  `)

  // Colunas novas em bancos criados por versões antigas.
  for (const col of ['avatar INTEGER NOT NULL DEFAULT 0', 'avatar_checked INTEGER NOT NULL DEFAULT 0']) {
    try {
      db.exec(`ALTER TABLE chats ADD COLUMN ${col}`)
    } catch {}
  }
  try {
    db.exec('ALTER TABLE notes ADD COLUMN body TEXT')
  } catch {}

  const q = {
    getChat: db.prepare('SELECT * FROM chats WHERE account = ? AND id = ?'),
    insertChat: db.prepare(
      'INSERT OR IGNORE INTO chats (account, id, send_jid, is_group) VALUES (?, ?, ?, ?)'
    ),
    listChats: db.prepare(
      'SELECT * FROM chats WHERE last_ts > 0 ORDER BY last_ts DESC LIMIT 2000'
    ),
    getContact: db.prepare('SELECT * FROM contacts WHERE account = ? AND id = ?'),
    upsertContact: db.prepare(`
      INSERT INTO contacts (account, id, name, notify) VALUES (?, ?, ?, ?)
      ON CONFLICT (account, id) DO UPDATE SET
        name = COALESCE(excluded.name, contacts.name),
        notify = COALESCE(excluded.notify, contacts.notify)
    `),
    getMessage: db.prepare(
      'SELECT * FROM messages WHERE account = ? AND chat_id = ? AND id = ?'
    ),
    findMessageById: db.prepare(
      'SELECT * FROM messages WHERE account = ? AND id = ? LIMIT 1'
    ),
    insertMessage: db.prepare(`
      INSERT INTO messages
        (account, chat_id, id, from_me, sender, sender_name, ts, kind, text, thumb, mime, file_name, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account, chat_id, id) DO NOTHING
    `),
    listMessages: db.prepare(`
      SELECT account, chat_id, id, from_me, sender, sender_name, ts, kind, text, thumb, mime, file_name, deleted, edited
      FROM messages WHERE account = ? AND chat_id = ? AND ts < ?
      ORDER BY ts DESC, rowid DESC LIMIT ?
    `),
    lastMessage: db.prepare(`
      SELECT * FROM messages WHERE account = ? AND chat_id = ?
      ORDER BY ts DESC, rowid DESC LIMIT 1
    `),
    unreadIncoming: db.prepare(`
      SELECT raw FROM messages WHERE account = ? AND chat_id = ? AND from_me = 0
      ORDER BY ts DESC, rowid DESC LIMIT ?
    `),
  }

  const allowed = new Set([
    'send_jid', 'name', 'is_group', 'archived', 'unread', 'last_ts', 'last_text', 'last_from_me',
    'avatar', 'avatar_checked',
  ])

  // Notas antigas guardavam só uma lista de tarefas. Viram texto com lista de tarefas.
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const itemsToHtml = (items) => {
    const list = JSON.parse(items || '[]').filter((i) => i.text)
    if (!list.length) return ''
    return `<ul class="checklist">${list
      .map((i) => `<li data-checked="${i.done ? 'true' : 'false'}">${esc(i.text)}</li>`)
      .join('')}</ul>`
  }
  const viewNote = (r) => ({
    id: r.id,
    title: r.title,
    body: r.body ?? itemsToHtml(r.items),
    updated: r.updated,
  })

  const store = {
    db,

    getChat(account, id) {
      return q.getChat.get(account, id) || null
    },

    ensureChat(account, id, sendJid) {
      q.insertChat.run(account, id, sendJid || id, id.endsWith('@g.us') ? 1 : 0)
      return q.getChat.get(account, id)
    },

    patchChat(account, id, patch) {
      const keys = Object.keys(patch).filter((k) => allowed.has(k) && patch[k] !== undefined)
      if (!keys.length) return q.getChat.get(account, id)
      const sql = `UPDATE chats SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE account = ? AND id = ?`
      db.prepare(sql).run(...keys.map((k) => patch[k]), account, id)
      return q.getChat.get(account, id)
    },

    listChats() {
      return q.listChats.all()
    },

    getContact(account, id) {
      return q.getContact.get(account, id) || null
    },

    upsertContact(account, id, name, notify) {
      if (!id) return
      q.upsertContact.run(account, id, name || null, notify || null)
    },

    getMessage(account, chatId, id) {
      return q.getMessage.get(account, chatId, id) || null
    },

    findMessageById(account, id) {
      return q.findMessageById.get(account, id) || null
    },

    // Devolve true quando a mensagem era nova.
    insertMessage(m) {
      const r = q.insertMessage.run(
        m.account, m.chatId, m.id, m.fromMe ? 1 : 0, m.sender || null, m.senderName || null,
        m.ts, m.kind, m.text || null, m.thumb || null, m.mime || null, m.fileName || null,
        m.raw || null
      )
      return r.changes > 0
    },

    patchMessage(account, chatId, id, patch) {
      const keys = Object.keys(patch)
      const sql = `UPDATE messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE account = ? AND chat_id = ? AND id = ?`
      db.prepare(sql).run(...keys.map((k) => patch[k]), account, chatId, id)
    },

    listMessages(account, chatId, before, limit) {
      return q.listMessages.all(account, chatId, before, limit).reverse()
    },

    lastMessage(account, chatId) {
      return q.lastMessage.get(account, chatId) || null
    },

    recentIncomingRaw(account, chatId, limit) {
      return q.unreadIncoming.all(account, chatId, limit).map((r) => r.raw).filter(Boolean)
    },

    setReaction(account, chatId, msgId, sender, emoji) {
      if (emoji) {
        db.prepare(
          `INSERT INTO reactions (account, chat_id, msg_id, sender, emoji) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (account, chat_id, msg_id, sender) DO UPDATE SET emoji = excluded.emoji`
        ).run(account, chatId, msgId, sender, emoji)
      } else {
        db.prepare(
          'DELETE FROM reactions WHERE account = ? AND chat_id = ? AND msg_id = ? AND sender = ?'
        ).run(account, chatId, msgId, sender)
      }
    },

    getReaction(account, chatId, msgId, sender) {
      return (
        db
          .prepare('SELECT emoji FROM reactions WHERE account = ? AND chat_id = ? AND msg_id = ? AND sender = ?')
          .get(account, chatId, msgId, sender)?.emoji || ''
      )
    },

    // Devolve { idDaMensagem: [{ emoji, count, mine }] } para as mensagens pedidas.
    reactionsFor(account, chatId, msgIds) {
      const out = {}
      for (let i = 0; i < msgIds.length; i += 200) {
        const ids = msgIds.slice(i, i + 200)
        const rows = db
          .prepare(
            `SELECT msg_id, sender, emoji FROM reactions
             WHERE account = ? AND chat_id = ? AND msg_id IN (${ids.map(() => '?').join(',')})`
          )
          .all(account, chatId, ...ids)
        for (const r of rows) {
          const list = (out[r.msg_id] ||= [])
          let e = list.find((x) => x.emoji === r.emoji)
          if (!e) list.push((e = { emoji: r.emoji, count: 0, mine: false }))
          e.count++
          if (r.sender === 'me') e.mine = true
        }
      }
      return out
    },

    // Notas com lista de tarefas. Não pertencem a nenhuma conta de WhatsApp.
    listNotes() {
      return db.prepare('SELECT * FROM notes ORDER BY updated DESC').all().map(viewNote)
    },

    saveNote(id, title, body) {
      const now = Math.floor(Date.now() / 1000)
      if (id && db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)) {
        db.prepare('UPDATE notes SET title = ?, body = ?, updated = ? WHERE id = ?').run(title, body, now, id)
      } else {
        id = Number(
          db.prepare('INSERT INTO notes (title, body, created, updated) VALUES (?, ?, ?, ?)')
            .run(title, body, now, now).lastInsertRowid
        )
      }
      return viewNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(id))
    },

    deleteNote(id) {
      db.prepare('DELETE FROM notes WHERE id = ?').run(id)
    },

    version() {
      return db.prepare('PRAGMA user_version').get().user_version
    },

    setVersion(n) {
      db.exec(`PRAGMA user_version = ${Number(n)}`)
    },

    // Junta a conversa "from" dentro da conversa "to". Usado quando o WhatsApp
    // revela que dois identificadores (um interno e o telefone) são a mesma pessoa.
    mergeChat(account, from, to) {
      const a = q.getChat.get(account, from)
      if (!a || from === to) return false
      const b = store.ensureChat(account, to, to)
      db.prepare(
        'UPDATE OR IGNORE messages SET chat_id = ? WHERE account = ? AND chat_id = ?'
      ).run(to, account, from)
      db.prepare('DELETE FROM messages WHERE account = ? AND chat_id = ?').run(account, from)
      db.prepare(
        'UPDATE OR IGNORE reactions SET chat_id = ? WHERE account = ? AND chat_id = ?'
      ).run(to, account, from)
      db.prepare('DELETE FROM reactions WHERE account = ? AND chat_id = ?').run(account, from)
      const newer = a.last_ts > b.last_ts ? a : b
      store.patchChat(account, to, {
        name: b.name || a.name,
        archived: a.archived && b.archived ? 1 : 0,
        unread: a.unread + b.unread,
        last_ts: newer.last_ts,
        last_text: newer.last_text,
        last_from_me: newer.last_from_me,
      })
      db.prepare('DELETE FROM chats WHERE account = ? AND id = ?').run(account, from)
      return true
    },

    wipeAccount(account) {
      for (const t of ['chats', 'messages', 'contacts', 'reactions']) {
        db.prepare(`DELETE FROM ${t} WHERE account = ?`).run(account)
      }
    },

    transaction(fn) {
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
  return store
}
