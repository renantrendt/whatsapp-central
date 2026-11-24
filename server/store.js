// Banco local (SQLite) com conversas, mensagens e contatos das duas contas.
// Tudo fica em um arquivo neste Mac. Nada sai do computador por aqui.
import { randomUUID } from 'node:crypto'
import { openDatabase } from './sqlite.js'

export async function openStore(file) {
  const db = await openDatabase(file)
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
  // seen_ts: time of the newest message the user has already dealt with in the chat
  // (read, answered or archived). A message WhatsApp delivers late counts as new
  // only when it is newer than this. Starts at the last message already stored.
  try {
    db.exec('ALTER TABLE chats ADD COLUMN seen_ts INTEGER NOT NULL DEFAULT 0')
    db.exec('UPDATE chats SET seen_ts = last_ts')
  } catch {}
  // Colunas para sincronizar notas entre aparelhos: uid é o mesmo em todos os
  // aparelhos, mtime é a hora da última edição em milissegundos e deleted marca
  // uma nota apagada (fica guardada para o outro aparelho também apagar).
  for (const col of ['body TEXT', 'uid TEXT', 'mtime INTEGER NOT NULL DEFAULT 0', 'deleted INTEGER NOT NULL DEFAULT 0']) {
    try {
      db.exec(`ALTER TABLE notes ADD COLUMN ${col}`)
    } catch {}
  }
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)')
  for (const r of db.prepare('SELECT id, updated FROM notes WHERE uid IS NULL').all()) {
    db.prepare('UPDATE notes SET uid = ?, mtime = ? WHERE id = ?').run(randomUUID(), r.updated * 1000, r.id)
  }

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
    'avatar', 'avatar_checked', 'seen_ts',
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

    // Incoming messages newer than a time: what is still unread after the user
    // read up to that time on another device.
    countIncomingAfter(account, chatId, ts) {
      return db
        .prepare('SELECT count(*) AS n FROM messages WHERE account = ? AND chat_id = ? AND from_me = 0 AND ts > ?')
        .get(account, chatId, ts).n
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
      return db.prepare('SELECT * FROM notes WHERE deleted = 0 ORDER BY updated DESC').all().map(viewNote)
    },

    saveNote(id, title, body) {
      const ms = Date.now()
      const now = Math.floor(ms / 1000)
      if (id && db.prepare('SELECT 1 FROM notes WHERE id = ? AND deleted = 0').get(id)) {
        db.prepare('UPDATE notes SET title = ?, body = ?, updated = ?, mtime = ? WHERE id = ?').run(title, body, now, ms, id)
      } else {
        id = Number(
          db.prepare('INSERT INTO notes (uid, title, body, created, updated, mtime) VALUES (?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), title, body, now, now, ms).lastInsertRowid
        )
      }
      return viewNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(id))
    },

    // A nota apagada vira uma "lápide": sem texto, marcada como apagada.
    deleteNote(id) {
      const ms = Date.now()
      db.prepare("UPDATE notes SET deleted = 1, title = '', body = '', items = '[]', updated = ?, mtime = ? WHERE id = ?")
        .run(Math.floor(ms / 1000), ms, id)
    },

    // Todas as notas, inclusive as apagadas, no formato trocado entre aparelhos.
    exportNotes() {
      return db.prepare('SELECT * FROM notes').all().map((r) => ({
        uid: r.uid,
        title: r.title,
        body: r.body ?? itemsToHtml(r.items),
        created: r.created,
        updated: r.updated,
        mtime: r.mtime,
        deleted: r.deleted ? 1 : 0,
      }))
    },

    // Junta notas que vieram de outro aparelho. Vale a edição mais recente.
    // Devolve quantas notas mudaram aqui.
    mergeNotes(list) {
      let changed = 0
      store.transaction(() => {
        for (const n of Array.isArray(list) ? list : []) {
          if (!n || typeof n.uid !== 'string' || !n.uid || typeof n.mtime !== 'number') continue
          const row = [String(n.title || '').slice(0, 200), String(n.body || '').slice(0, 1_500_000),
            Number(n.created) || 0, Number(n.updated) || 0, n.mtime, n.deleted ? 1 : 0]
          const local = db.prepare('SELECT id, mtime FROM notes WHERE uid = ?').get(n.uid)
          if (!local) {
            db.prepare('INSERT INTO notes (title, body, created, updated, mtime, deleted, uid) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(...row, n.uid)
            changed++
          } else if (n.mtime > local.mtime) {
            db.prepare('UPDATE notes SET title = ?, body = ?, created = ?, updated = ?, mtime = ?, deleted = ? WHERE id = ?')
              .run(...row, local.id)
            changed++
          }
        }
      })
      return changed
    },

    getSetting(key) {
      return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null
    },

    setSetting(key, value) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        .run(key, value)
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
        seen_ts: Math.max(a.seen_ts || 0, b.seen_ts || 0),
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
