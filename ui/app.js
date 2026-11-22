// Tela do Whatsapp Central. Todo texto vindo de mensagens entra por textContent,
// nunca como HTML, para que uma mensagem não consiga injetar código na tela.
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}
const keyOf = (c) => `${c.account}|${c.id}`
const MAX_ROWS = 300
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏']

const state = {
  accounts: [],
  chats: new Map(),
  tab: 'inbox',
  selected: null, // chave da conversa aberta
  notes: [],
  selectedNote: null, // id da nota aberta
  messages: [],
  dialog: null, // null | { mode: 'accounts' } | { mode: 'connect', account }
  demo: false,
}

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined)
  if (res.status === 401) {
    location.reload()
    throw new Error('no access')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'error')
  return data
}
const alertError = (e) => alert(e.message || 'Error')
const q = (c) => `account=${encodeURIComponent(c.account)}&chat=${encodeURIComponent(c.id)}`

// ---------- datas ----------
const two = (n) => String(n).padStart(2, '0')
const sameDay = (a, b) => a.toDateString() === b.toDateString()
const clock = (ts) => {
  const d = new Date(ts * 1000)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
function shortTime(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  if (sameDay(d, now)) return clock(ts)
  if (now - d < 6 * 86400e3) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function dayLabel(ts) {
  const d = new Date(ts * 1000)
  const now = new Date()
  if (sameDay(d, now)) return 'Today'
  if (sameDay(d, new Date(now - 86400e3))) return 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ---------- foto de perfil ----------
const COLORS = ['#7a8f6a', '#8a7a9c', '#9c7a6a', '#6a8a9c', '#9c8f5f', '#7f7f86']
function colorOf(text) {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}
function paintAvatar(node, c) {
  node.replaceChildren()
  node.style.background = colorOf(c.id)
  node.textContent = (c.name.trim()[0] || '?').toUpperCase()
  if (!c.avatar) return
  const img = el('img')
  img.alt = ''
  img.loading = 'lazy'
  img.src = `/api/avatar?${q(c)}&v=${c.avatar}`
  img.onerror = () => img.remove()
  node.append(img)
}

// ---------- contas (abertas pelo menu do app) ----------
const STATUS = {
  idle: 'Offline',
  connecting: 'Connecting...',
  qr: 'Waiting for QR code',
  open: 'Connected',
  blocked: 'Refused by WhatsApp',
  replaced: 'Open in another window',
}
const accountOf = (id) => state.accounts.find((a) => a.id === id)

function renderEmpty() {
  const notes = state.tab === 'notes'
  const none = state.accounts.length === 0
  $('empty-text').textContent = notes
    ? 'Press ⌘N to create a note.'
    : none
      ? 'No WhatsApp account connected yet.'
      : 'Select a conversation from the list.'
  $('empty-connect').hidden = notes || !none || state.demo
}

// Mostra só uma das áreas da direita: vazio, conversa ou nota.
function showMain(which) {
  for (const id of ['empty', 'chat', 'note']) $(id).hidden = id !== which
  if (which === 'empty') renderEmpty()
}

function renderMain() {
  if (state.tab === 'notes') {
    if (curNote()) {
      showMain('note')
      renderNoteEditor()
    } else showMain('empty')
  } else {
    showMain(state.chats.has(state.selected) ? 'chat' : 'empty')
  }
}

function showDialog(d) {
  state.dialog = d
  renderDialog()
  if (!$('dialog').open) $('dialog').showModal()
}

async function connectNew() {
  try {
    const { id } = await api('/api/connect-new', {})
    showDialog({ mode: 'connect', account: id })
  } catch (e) {
    alertError(e)
  }
}

function renderDialog() {
  const d = state.dialog
  if (!d) return
  const body = $('dialog-body')
  body.replaceChildren()

  if (d.mode === 'accounts') {
    $('dialog-title').textContent = 'Accounts'
    if (!state.accounts.length) body.append(el('p', null, 'No account connected.'))
    for (const a of state.accounts) {
      const row = el('div', 'acct-row')
      const info = el('div')
      info.append(el('b', null, a.me || 'New account'))
      info.append(el('small', a.status === 'open' ? 'ok' : '', STATUS[a.status] || a.status))
      if (a.error && a.status !== 'open') info.append(el('small', 'err', a.error))
      row.append(info)
      if (a.status === 'idle' || a.status === 'replaced') {
        const re = el('button', null, 'Reconnect')
        re.onclick = () => api('/api/connect', { account: a.id }).catch(alertError)
        row.append(re)
      }
      const out = el('button', 'danger', 'Disconnect')
      out.onclick = async () => {
        if (!confirm(`Disconnect ${a.me || 'this account'} from this Mac? Its conversations are removed from this app. Nothing is deleted on the phone.`)) return
        await api('/api/logout', { account: a.id }).catch(alertError)
      }
      row.append(out)
      body.append(row)
    }
    if (!state.demo) {
      const add = el('button', 'primary', 'Connect new account')
      add.onclick = connectNew
      body.append(add)
    }
    return
  }

  // modo "connect": mostra o QR code de uma conta nova
  const a = accountOf(d.account)
  $('dialog-title').textContent = 'Connect new account'
  if (!a) {
    body.append(el('p', null, 'Starting...'))
  } else if (a.status === 'open') {
    body.append(el('p', null, `Connected as ${a.me}. Loading conversations...`))
    setTimeout(() => state.dialog?.account === a.id && $('dialog').close(), 1500)
  } else if (a.status === 'qr' && a.qr) {
    const img = el('img', 'qr')
    img.src = a.qr
    img.alt = 'QR code'
    body.append(img)
    const ol = el('ol')
    for (const s of [
      'Open WhatsApp on the phone.',
      'Go to Settings, then Linked devices.',
      'Tap Link a device and point the camera at this code.',
    ]) ol.append(el('li', null, s))
    body.append(ol)
  } else if (a.status === 'connecting') {
    body.append(el('p', null, 'Connecting...'))
  } else {
    if (a.error) body.append(el('p', 'err', a.error))
    const b = el('button', 'primary', 'Show a new QR code')
    b.onclick = () => api('/api/connect', { account: a.id }).catch(alertError)
    body.append(b)
  }
}

$('dialog-close').onclick = () => $('dialog').close()
$('dialog').addEventListener('close', () => {
  const d = state.dialog
  state.dialog = null
  // Fechou a janela do QR code sem ligar: desiste dessa conta nova.
  if (d?.mode === 'connect') api('/api/cancel', { account: d.account }).catch(() => {})
})
$('empty-connect').onclick = connectNew

// ---------- lista ----------
function visibleChats() {
  return [...state.chats.values()]
    .filter((c) => (state.tab === 'archived' ? c.archived : !c.archived))
    .sort((a, b) => b.lastTs - a.lastTs)
}

function renderList() {
  const all = [...state.chats.values()]
  const inbox = all.filter((c) => !c.archived)
  const unreadTotal = inbox.reduce((n, c) => n + c.unread, 0)
  document.title = unreadTotal ? `(${unreadTotal}) Whatsapp Central` : 'Whatsapp Central'

  if (state.tab === 'notes') return renderNotesList()
  const box = $('list')
  const rows = visibleChats()
  box.replaceChildren()
  if (!rows.length) {
    box.append(el('div', 'list-empty',
      state.tab === 'inbox' ? 'Inbox is empty.' : 'No archived conversations.'))
    return
  }
  for (const c of rows.slice(0, MAX_ROWS)) {
    const k = keyOf(c)
    const row = el('div', `row${k === state.selected ? ' sel' : ''}${c.unread ? ' unread' : ''}`)
    const av = el('div', 'avatar')
    paintAvatar(av, c)
    row.append(av)

    const mid = el('div', 'mid')
    mid.append(el('div', 'name', c.name))
    mid.append(el('div', 'preview', (c.lastFromMe ? 'You: ' : '') + c.lastText))
    row.append(mid)

    const end = el('div', 'end')
    end.append(el('span', 'time', shortTime(c.lastTs)))
    if (c.unread) end.append(el('span', 'badge', String(c.unread)))
    row.append(end)

    row.onclick = () => openChat(k)
    box.append(row)
  }
  if (rows.length > MAX_ROWS) {
    box.append(el('div', 'list-empty', `Showing the ${MAX_ROWS} most recent. Press ⌘K to find older ones.`))
  }
}

async function setArchived(c, archived) {
  const k = keyOf(c)
  if (archived && state.selected === k) {
    // Depois de arquivar, abre a próxima conversa da lista, como em uma fila.
    const rows = visibleChats()
    const i = rows.findIndex((x) => keyOf(x) === k)
    const next = rows[i + 1] || rows[i - 1]
    if (next) openChat(keyOf(next))
    else closeChat()
  }
  await api('/api/archive', { account: c.account, chat: c.id, archived }).catch(alertError)
}

function archiveSelected() {
  const c = state.chats.get(state.selected)
  if (c) setArchived(c, !c.archived)
}

// ---------- conversa ----------
function closeChat() {
  state.selected = null
  state.messages = []
  if (state.tab !== 'notes') showMain('empty')
  renderList()
}

async function openChat(k) {
  const c = state.chats.get(k)
  if (!c) return
  state.selected = k
  state.messages = []
  showMain('chat')
  renderChatHead()
  renderList()
  $('messages').replaceChildren()
  const { messages } = await api(`/api/messages?${q(c)}`)
  if (state.selected !== k) return
  state.messages = messages
  renderMessages(true)
  markReadIfVisible()
  $('input').focus()
}

function renderChatHead() {
  const c = state.chats.get(state.selected)
  if (!c) return
  paintAvatar($('chat-avatar'), c)
  $('chat-name').textContent = c.name
  const parts = []
  if (c.isGroup) parts.push('Group')
  // Com mais de uma conta, mostra por qual número a conversa passa.
  if (state.accounts.length > 1) parts.push(`via ${accountOf(c.account)?.me || 'offline account'}`)
  if (c.archived) parts.push('Archived')
  $('chat-sub').textContent = parts.join(' - ')
}

const mediaUrl = (m) =>
  `/api/media?account=${encodeURIComponent(m.account)}&chat=${encodeURIComponent(m.chatId)}&id=${encodeURIComponent(m.id)}`

const react = (m, emoji) =>
  api('/api/react', { account: m.account, chat: m.chatId, id: m.id, emoji }).catch(alertError)

function messageNode(m, isGroup) {
  const wrap = el('div', `msg-wrap${m.fromMe ? ' me' : ''}`)
  const n = el('div', 'msg')
  if (isGroup && !m.fromMe && m.senderName) n.append(el('div', 'who', m.senderName))

  if (m.deleted) {
    n.append(el('div', 'gone', 'Deleted message'))
  } else if (m.kind === 'image') {
    const img = el('img', 'media')
    img.alt = 'Photo'
    if (m.thumb) {
      img.src = `data:image/jpeg;base64,${m.thumb}`
      img.title = 'Click to load full size'
      img.onclick = () => (img.src = mediaUrl(m))
    } else {
      img.loading = 'lazy'
      img.src = mediaUrl(m)
    }
    n.append(img)
  } else if (m.kind === 'video') {
    const v = el('video', 'media')
    v.controls = true
    v.preload = 'none'
    if (m.thumb) v.poster = `data:image/jpeg;base64,${m.thumb}`
    v.src = mediaUrl(m)
    n.append(v)
  } else if (m.kind === 'audio') {
    const a = el('audio')
    a.controls = true
    a.preload = 'metadata'
    a.src = mediaUrl(m)
    a.onerror = () => a.replaceWith(el('div', 'note', 'This voice message could not be loaded.'))
    n.append(a)
  } else if (m.kind === 'sticker') {
    const img = el('img', 'media sticker')
    img.alt = 'Sticker'
    img.loading = 'lazy'
    img.src = mediaUrl(m)
    n.append(img)
  } else if (m.kind === 'document') {
    const a = el('a', 'file', m.fileName || 'Document')
    a.href = mediaUrl(m)
    a.download = m.fileName || ''
    n.append(a)
  } else if (m.kind !== 'text') {
    const names = { contact: 'Contact', location: 'Location', poll: 'Poll', other: 'Message type not shown yet' }
    n.append(el('div', 'note', names[m.kind] || 'Message'))
  }

  if (!m.deleted && m.text) n.append(el('div', 'text', m.text))
  n.append(el('div', 'meta', (m.edited ? 'edited - ' : '') + clock(m.ts)))

  if (!m.deleted) {
    const bar = el('div', 'react-bar')
    for (const e of QUICK) {
      const b = el('button', null, e)
      b.type = 'button'
      b.title = `React with ${e}`
      b.onclick = () => react(m, e)
      bar.append(b)
    }
    n.append(bar)
  }
  wrap.append(n)

  if (m.reactions?.length) {
    const chips = el('div', 'chips')
    for (const r of m.reactions) {
      const chip = el('button', `chip${r.mine ? ' mine' : ''}`, r.count > 1 ? `${r.emoji} ${r.count}` : r.emoji)
      chip.type = 'button'
      chip.title = r.mine ? 'Remove your reaction' : `React with ${r.emoji}`
      chip.onclick = () => react(m, r.emoji)
      chips.append(chip)
    }
    wrap.append(chips)
  }
  return wrap
}

function renderMessages(toBottom) {
  const box = $('messages')
  const c = state.chats.get(state.selected)
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80
  const keep = box.scrollTop
  box.replaceChildren()
  let last = ''
  for (const m of state.messages) {
    const d = dayLabel(m.ts)
    if (d !== last) {
      box.append(el('div', 'day', d))
      last = d
    }
    box.append(messageNode(m, c?.isGroup))
  }
  box.scrollTop = toBottom || nearBottom ? box.scrollHeight : keep
}

let loadingOlder = false
$('messages').addEventListener('scroll', async () => {
  const box = $('messages')
  if (box.scrollTop > 40 || loadingOlder || !state.messages.length) return
  const c = state.chats.get(state.selected)
  if (!c) return
  loadingOlder = true
  const k = state.selected
  const first = state.messages[0]
  try {
    const { messages } = await api(`/api/messages?${q(c)}&before=${first.ts}`)
    if (state.selected === k && messages.length) {
      const before = box.scrollHeight
      const known = new Set(state.messages.map((m) => m.id))
      state.messages = [...messages.filter((m) => !known.has(m.id)), ...state.messages]
      renderMessages(false)
      box.scrollTop = box.scrollHeight - before
    }
  } finally {
    loadingOlder = false
  }
})

function markReadIfVisible() {
  const c = state.chats.get(state.selected)
  if (c && c.unread && document.hasFocus()) {
    api('/api/read', { account: c.account, chat: c.id }).catch(() => {})
  }
}
window.addEventListener('focus', markReadIfVisible)

// ---------- escrever ----------
const input = $('input')
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`
})
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('composer').requestSubmit()
  }
})
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault()
  const c = state.chats.get(state.selected)
  const text = input.value.trim()
  if (!c || !text) return
  const btn = $('composer').querySelector('button')
  btn.disabled = true
  try {
    await api('/api/send', { account: c.account, chat: c.id, text })
    input.value = ''
    input.style.height = 'auto'
  } catch (err) {
    alertError(err)
  } finally {
    btn.disabled = false
    input.focus()
  }
})

// ---------- atalhos e filtros ----------
// E arquiva ou desarquiva a conversa aberta. Setas trocam de conversa.
document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)
  if (e.key === 'Escape' && typing) document.activeElement.blur()
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    openPalette()
    return
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || $('dialog').open || state.tab === 'notes') return
  if (e.key.toLowerCase() === 'e') archiveSelected()
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const rows = visibleChats()
    const i = rows.findIndex((x) => keyOf(x) === state.selected)
    const next = rows[e.key === 'ArrowDown' ? i + 1 : i - 1]
    if (next) {
      e.preventDefault()
      openChat(keyOf(next))
    }
  }
})

for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    state.tab = b.dataset.tab
    for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('on', x === b)
    renderList()
    renderMain()
  }
}
// ---------- busca (⌘K) ----------
// Procura em todas as conversas, arquivadas ou não, pelo nome.
const palette = { results: [], index: 0 }

function openPalette() {
  if (!$('palette').hidden) return $('palette-input').select()
  hideMenu()
  $('palette').hidden = false
  $('palette-input').value = ''
  renderPalette()
  $('palette-input').focus()
}

function closePalette() {
  $('palette').hidden = true
  if (state.selected) $('input').focus()
}

function renderPalette() {
  const term = $('palette-input').value.trim().toLowerCase()
  const all = [...state.chats.values()].sort((a, b) => b.lastTs - a.lastTs)
  palette.results = (term ? all.filter((c) => c.name.toLowerCase().includes(term)) : all).slice(0, 50)
  palette.index = Math.min(palette.index, Math.max(0, palette.results.length - 1))
  const box = $('palette-list')
  box.replaceChildren()
  if (!palette.results.length) {
    box.append(el('div', 'list-empty', 'No conversation with that name.'))
    return
  }
  palette.results.forEach((c, i) => {
    const row = el('div', `p-row${i === palette.index ? ' on' : ''}`)
    const av = el('div', 'avatar small')
    paintAvatar(av, c)
    row.append(av)
    row.append(el('span', 'name', c.name))
    if (c.archived) row.append(el('span', 'p-note', 'Archived'))
    row.onmouseenter = () => {
      palette.index = i
      for (const [j, r] of [...box.children].entries()) r.classList.toggle('on', j === i)
    }
    row.onclick = () => pickPalette(i)
    box.append(row)
  })
}

function pickPalette(i) {
  const c = palette.results[i]
  if (!c) return
  closePalette()
  // Abre na aba certa, para a conversa aparecer marcada na lista.
  const tab = c.archived ? 'archived' : 'inbox'
  if (state.tab !== tab) document.querySelector(`#tabs button[data-tab="${tab}"]`).click()
  openChat(keyOf(c))
}

$('palette-input').addEventListener('input', () => {
  palette.index = 0
  renderPalette()
})
$('palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    closePalette()
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const n = palette.results.length
    if (!n) return
    palette.index = (palette.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
    renderPalette()
    $('palette-list').children[palette.index]?.scrollIntoView({ block: 'nearest' })
  } else if (e.key === 'Enter') {
    e.preventDefault()
    pickPalette(palette.index)
  }
})
$('palette').addEventListener('mousedown', (e) => {
  if (e.target === $('palette')) closePalette()
})

// ---------- avisos do sistema ----------
function notify(m) {
  if (m.fromMe || document.hasFocus() || !('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  const c = state.chats.get(`${m.account}|${m.chatId}`)
  const body = m.kind === 'text' ? m.text : c?.lastText || 'New message'
  const n = new Notification(c?.name || 'New message', { body })
  n.onclick = () => {
    window.focus()
    openChat(`${m.account}|${m.chatId}`)
  }
}
document.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
}, { once: true })

// ---------- dados ----------
async function load() {
  const s = await api('/api/state')
  state.accounts = s.accounts
  state.demo = s.demo
  state.chats = new Map(s.chats.map((c) => [keyOf(c), c]))
  if (state.selected && !state.chats.has(state.selected)) closeChat()
  renderEmpty()
  renderList()
  if (state.selected) renderChatHead()
}

let reloadTimer = null
let listTimer = null
const renderListSoon = () => {
  clearTimeout(listTimer)
  listTimer = setTimeout(renderList, 60)
}

function onEvent(ev) {
  if (ev.type === 'accounts') {
    state.accounts = ev.accounts
    renderEmpty()
    if (state.dialog) renderDialog()
    if (state.selected) renderChatHead()
  } else if (ev.type === 'chat') {
    state.chats.set(keyOf(ev.chat), ev.chat)
    renderListSoon()
    if (keyOf(ev.chat) === state.selected) renderChatHead()
  } else if (ev.type === 'chat-removed') {
    const k = `${ev.account}|${ev.id}`
    state.chats.delete(k)
    if (state.selected === k) closeChat()
    else renderListSoon()
  } else if (ev.type === 'message') {
    const m = ev.message
    if (`${m.account}|${m.chatId}` === state.selected) {
      const i = state.messages.findIndex((x) => x.id === m.id)
      if (i >= 0) state.messages[i] = m
      else if (!ev.updated) state.messages.push(m)
      renderMessages(m.fromMe && !ev.updated)
      if (ev.live) setTimeout(markReadIfVisible, 50)
    }
    if (ev.live && !ev.updated) setTimeout(() => notify(m), 60)
  } else if (ev.type === 'reload') {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(async () => {
      await load()
      const c = state.chats.get(state.selected)
      if (c) {
        const { messages } = await api(`/api/messages?${q(c)}`)
        state.messages = messages
        renderMessages(false)
      }
    }, 300)
  }
}

function listen() {
  const es = new EventSource('/api/events')
  es.onmessage = (e) => onEvent(JSON.parse(e.data))
  es.onerror = () => {
    // O navegador reconecta sozinho. Ao voltar, recarrega o estado inteiro.
    es.onopen = () => load().catch(() => {})
  }
}

// Comandos chamados pelo menu do app (ver electron/main.cjs).
window.wc = {
  connectNew,
  showAccounts: () => showDialog({ mode: 'accounts' }),
  openPalette,
  archiveSelected,
}

// ---------- notas ----------
// Cada nota tem um título e um texto livre com negrito, listas e tarefas.
// O texto é guardado como HTML limpo: só as marcas da lista ALLOWED passam.
const curNote = () => state.notes.find((n) => n.id === state.selectedNote)
const editor = $('note-editor')
document.execCommand('defaultParagraphSeparator', false, 'div')

const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'UL', 'OL', 'LI', 'P', 'DIV', 'BR'])
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH'])

function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html')
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue
      if (child.nodeType !== 1 || DROP.has(child.tagName)) {
        child.remove()
        continue
      }
      walk(child)
      if (!ALLOWED.has(child.tagName)) {
        child.replaceWith(...child.childNodes)
        continue
      }
      for (const a of [...child.attributes]) {
        const keep =
          (child.tagName === 'UL' && a.name === 'class' && a.value === 'checklist') ||
          (child.tagName === 'LI' && a.name === 'data-checked' && (a.value === 'true' || a.value === 'false'))
        if (!keep) child.removeAttribute(a.name)
      }
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}

// Mantém as listas de tarefas coerentes depois de cada comando do editor.
function normalizeLists() {
  for (const l of editor.querySelectorAll('ol.checklist')) l.removeAttribute('class')
  for (const l of editor.querySelectorAll('ul:not(.checklist)[class]')) l.removeAttribute('class')
  for (const li of editor.querySelectorAll('li')) {
    if (!li.parentElement?.matches('ul.checklist')) li.removeAttribute('data-checked')
    else if (li.dataset.checked !== 'true') li.dataset.checked = 'false'
  }
}

function caretEl() {
  const sel = getSelection()
  if (!sel.rangeCount) return null
  const n = sel.getRangeAt(0).startContainer
  if (!editor.contains(n)) return null
  return n.nodeType === 1 ? n : n.parentElement
}
function caretList() {
  const l = caretEl()?.closest('ul, ol')
  return l && editor.contains(l) ? l : null
}

function format(kind) {
  editor.focus()
  const list = caretList()
  if (kind === 'bold') document.execCommand('bold')
  else if (kind === 'bullet') {
    if (list?.matches('ul.checklist')) list.classList.remove('checklist')
    else document.execCommand('insertUnorderedList')
  } else if (kind === 'number') {
    document.execCommand('insertOrderedList')
  } else if (kind === 'text') {
    // Tira a linha da lista e volta a ser texto comum.
    if (list?.matches('ol')) document.execCommand('insertOrderedList')
    else if (list) document.execCommand('insertUnorderedList')
  } else if (kind === 'check') {
    if (list?.matches('ul.checklist')) document.execCommand('insertUnorderedList')
    else {
      if (!list?.matches('ul')) document.execCommand('insertUnorderedList')
      caretList()?.classList.add('checklist')
    }
  }
  normalizeLists()
  updateBubble()
  saveNoteSoon()
}

// ---------- barrinha ao selecionar texto ----------
// Selecione um trecho da nota e aparece uma barrinha com negrito e listas.
const bubble = $('bubble')

function updateBubble() {
  const sel = getSelection()
  const range = sel.rangeCount ? sel.getRangeAt(0) : null
  if (!range || sel.isCollapsed || !editor.contains(range.commonAncestorContainer) || !$('slash').hidden) {
    bubble.hidden = true
    return
  }
  const list = caretList()
  const on = {
    bold: document.queryCommandState('bold'),
    bullet: !!list?.matches('ul:not(.checklist)'),
    number: !!list?.matches('ol'),
    check: !!list?.matches('ul.checklist'),
  }
  for (const b of bubble.querySelectorAll('button')) b.classList.toggle('on', on[b.dataset.fmt])
  bubble.hidden = false
  const r = range.getBoundingClientRect()
  const x = Math.max(8, Math.min(r.left + r.width / 2 - bubble.offsetWidth / 2, innerWidth - bubble.offsetWidth - 8))
  const y = r.top - bubble.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - bubble.offsetHeight - 8
  bubble.style.left = `${x}px`
  bubble.style.top = `${y}px`
}
document.addEventListener('selectionchange', updateBubble)
$('note-body').addEventListener('scroll', () => (bubble.hidden = true))

for (const b of bubble.querySelectorAll('button')) {
  b.addEventListener('mousedown', (e) => e.preventDefault()) // não perde a seleção
  b.addEventListener('click', () => format(b.dataset.fmt))
}

// ---------- menu "/" (como no Notion) ----------
// Digite / e aparece um menu. O que você digita depois da barra filtra o menu.
const SLASH_ITEMS = [
  { kind: 'text', label: 'Text', hint: 'Plain text', words: 'text plain paragraph normal' },
  { kind: 'bullet', label: 'Bullet list', hint: '-', words: 'bullet list unordered ul dot' },
  { kind: 'number', label: 'Numbered list', hint: '1.', words: 'numbered list ordered ol number' },
  { kind: 'check', label: 'To-do list', hint: '[]', words: 'todo to-do checklist check task box' },
  { kind: 'bold', label: 'Bold', hint: '⌘B', words: 'bold strong b' },
]
const slash = { open: false, node: null, offset: 0, items: [], index: 0 }

function slashQuery() {
  const sel = getSelection()
  if (!sel.rangeCount || !sel.isCollapsed) return null
  const r = sel.getRangeAt(0)
  if (r.startContainer !== slash.node || r.startOffset <= slash.offset) return null
  if (slash.node.data[slash.offset] !== '/') return null
  const q = slash.node.data.slice(slash.offset + 1, r.startOffset)
  return q.length > 20 || q.startsWith(' ') ? null : q.toLowerCase()
}

function renderSlash() {
  const q = slashQuery()
  if (q === null) return closeSlash()
  slash.items = SLASH_ITEMS.filter((it) => !q || it.words.split(' ').some((w) => w.startsWith(q)) || it.label.toLowerCase().includes(q))
  if (!slash.items.length) return closeSlash()
  slash.index = Math.min(slash.index, slash.items.length - 1)
  const box = $('slash')
  box.replaceChildren()
  slash.items.forEach((it, i) => {
    const row = el('div', `s-row${i === slash.index ? ' on' : ''}`)
    row.append(el('span', null, it.label))
    row.append(el('span', 's-hint', it.hint))
    row.onmousedown = (e) => {
      e.preventDefault()
      pickSlash(i)
    }
    row.onmouseenter = () => {
      slash.index = i
      for (const [j, x] of [...box.children].entries()) x.classList.toggle('on', j === i)
    }
    box.append(row)
  })
  box.hidden = false
  bubble.hidden = true
  const caret = getSelection().getRangeAt(0).getBoundingClientRect()
  const base = caret.height ? caret : slash.node.parentElement.getBoundingClientRect()
  const below = base.bottom + 6
  box.style.left = `${Math.max(8, Math.min(base.left, innerWidth - box.offsetWidth - 8))}px`
  box.style.top = `${below + box.offsetHeight > innerHeight - 8 ? base.top - box.offsetHeight - 6 : below}px`
}

function closeSlash() {
  slash.open = false
  $('slash').hidden = true
}

function pickSlash(i) {
  const it = slash.items[i]
  if (!it) return closeSlash()
  // Apaga o "/texto" digitado e aplica a escolha.
  const sel = getSelection()
  const end = sel.getRangeAt(0)
  const r = document.createRange()
  r.setStart(slash.node, slash.offset)
  r.setEnd(end.startContainer, end.startOffset)
  sel.removeAllRanges()
  sel.addRange(r)
  document.execCommand('delete')
  closeSlash()
  format(it.kind)
}

editor.addEventListener('input', (e) => {
  if (e.inputType === 'insertText' && e.data?.endsWith('/')) {
    const r = getSelection().getRangeAt(0)
    const node = r.startContainer
    const at = r.startOffset - 1
    // Abre só no começo da linha ou depois de um espaço, para não atrapalhar "e/ou".
    if (node.nodeType === 3 && node.data[at] === '/' && (at === 0 || /\s/.test(node.data[at - 1]))) {
      Object.assign(slash, { open: true, node, offset: at, index: 0 })
    }
  }
  if (slash.open) renderSlash()
})
editor.addEventListener('keydown', (e) => {
  if (!slash.open) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const n = slash.items.length
    slash.index = (slash.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
    renderSlash()
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    pickSlash(slash.index)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeSlash()
  }
})
document.addEventListener('selectionchange', () => {
  if (slash.open && slashQuery() === null) closeSlash()
})
editor.addEventListener('blur', closeSlash)

// Atalhos de texto no começo da linha: "- " lista, "1. " numerada, "[] " tarefa.
const SHORTCUTS = { '-': 'bullet', '*': 'bullet', '1.': 'number', '[]': 'check', '[ ]': 'check' }
editor.addEventListener('beforeinput', (e) => {
  // e.data pode trazer mais de uma letra (texto colado de uma vez ou ditado).
  if (e.inputType !== 'insertText' || !e.data?.startsWith(' ')) return
  const sel = getSelection()
  if (!sel.rangeCount || !sel.isCollapsed || caretEl()?.closest('li')) return
  const saved = sel.getRangeAt(0).cloneRange()
  sel.modify('extend', 'backward', 'lineboundary')
  const kind = SHORTCUTS[sel.toString()]
  if (!kind) {
    sel.removeAllRanges()
    sel.addRange(saved)
    return
  }
  e.preventDefault()
  document.execCommand('delete')
  format(kind)
  if (e.data.length > 1) document.execCommand('insertText', false, e.data.slice(1))
})

editor.addEventListener('input', (e) => {
  // Enter numa tarefa cria a próxima tarefa desmarcada.
  if (e.inputType === 'insertParagraph') {
    const li = caretEl()?.closest('ul.checklist > li')
    if (li) li.dataset.checked = 'false'
  }
  if (!editor.textContent && !editor.querySelector('li')) editor.innerHTML = ''
  normalizeLists()
  saveNoteSoon()
})

// Clique na caixinha da tarefa marca ou desmarca.
editor.addEventListener('mousedown', (e) => {
  const li = e.target.closest?.('ul.checklist > li')
  if (!li || !editor.contains(li)) return
  if (e.clientX - li.getBoundingClientRect().left > 24) return
  e.preventDefault()
  li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true'
  saveNoteSoon()
})

// Colar entra como texto simples, sem a formatação de outro app.
editor.addEventListener('paste', (e) => {
  e.preventDefault()
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
})

async function loadNotes() {
  const { notes } = await api('/api/notes')
  state.notes = notes
}

function noteSummary(n) {
  const doc = new DOMParser().parseFromString(`<body>${n.body || ''}</body>`, 'text/html')
  const tasks = [...doc.querySelectorAll('ul.checklist > li')].filter((li) => li.textContent.trim())
  if (tasks.length) return `${tasks.filter((li) => li.dataset.checked === 'true').length} of ${tasks.length} done`
  for (const b of doc.querySelectorAll('div, p, li, br')) {
    b.before('\n')
    b.after('\n')
  }
  const line = doc.body.textContent.split('\n').map((t) => t.trim()).find(Boolean)
  return line ? line.slice(0, 80) : 'Empty'
}

function renderNotesList() {
  const box = $('list')
  box.replaceChildren()
  if (!state.notes.length) {
    box.append(el('div', 'list-empty', 'No notes yet. Press ⌘N to create one.'))
    return
  }
  for (const n of [...state.notes].sort((a, b) => b.updated - a.updated)) {
    const row = el('div', `row note-row${n.id === state.selectedNote ? ' sel' : ''}`)
    const mid = el('div', 'mid')
    mid.append(el('div', 'name', n.title.trim() || 'Untitled'))
    mid.append(el('div', 'preview', noteSummary(n)))
    row.append(mid)
    const end = el('div', 'end')
    end.append(el('span', 'time', shortTime(n.updated)))
    row.append(end)
    row.onclick = () => openNote(n.id)
    row.oncontextmenu = (e) => {
      e.preventDefault()
      showMenu(e.clientX, e.clientY, [{ label: 'Delete note', danger: true, action: () => deleteNote(n) }])
    }
    box.append(row)
  }
}

function openNote(id) {
  flushNote()
  state.selectedNote = id
  showMain('note')
  renderNoteEditor()
  renderList()
}

// ⌘N (menu File > New Note) cria uma nota, de qualquer aba.
async function newNote() {
  if (state.tab !== 'notes') document.querySelector('#tabs button[data-tab="notes"]').click()
  try {
    const { note } = await api('/api/notes/save', { title: '', body: '' })
    state.notes.push(note)
    openNote(note.id)
    $('note-title').focus()
  } catch (e) {
    alertError(e)
  }
}

function renderNoteEditor() {
  const n = curNote()
  if (!n) return
  $('note-title').value = n.title
  editor.innerHTML = cleanHtml(n.body)
  normalizeLists()
}

let noteTimer = null
let notePending = null
function saveNoteSoon() {
  const n = curNote()
  if (!n) return
  n.title = $('note-title').value
  n.body = editor.innerHTML
  n.updated = Math.floor(Date.now() / 1000)
  notePending = n
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => saveNote(n), 400)
}

async function saveNote(n) {
  if (notePending === n) notePending = null
  try {
    await api('/api/notes/save', { id: n.id, title: n.title, body: cleanHtml(n.body) })
  } catch (e) {
    alertError(e)
  }
  if (state.tab === 'notes') renderListSoon()
}

// Salva já o que está esperando (ao trocar de nota).
function flushNote() {
  if (!notePending) return
  clearTimeout(noteTimer)
  saveNote(notePending)
}

async function deleteNote(n) {
  if (!confirm(`Delete the note "${n.title.trim() || 'Untitled'}"? This cannot be undone.`)) return
  if (notePending === n) {
    clearTimeout(noteTimer)
    notePending = null
  }
  try {
    await api('/api/notes/delete', { id: n.id })
  } catch (e) {
    return alertError(e)
  }
  state.notes = state.notes.filter((x) => x.id !== n.id)
  if (state.selectedNote === n.id) state.selectedNote = null
  renderList()
  renderMain()
}

// Ao fechar o app, salva o que ainda não foi salvo.
window.addEventListener('beforeunload', () => {
  const n = notePending
  if (!n) return
  const body = JSON.stringify({ id: n.id, title: n.title, body: cleanHtml(n.body) })
  navigator.sendBeacon('/api/notes/save', new Blob([body], { type: 'text/plain' }))
})

$('note-title').addEventListener('input', saveNoteSoon)
$('note-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    editor.focus()
  }
})

// ---------- menu do clique direito ----------
function showMenu(x, y, items) {
  const m = $('ctx')
  m.replaceChildren()
  for (const it of items) {
    const b = el('button', it.danger ? 'danger' : '', it.label)
    b.onclick = () => {
      hideMenu()
      it.action()
    }
    m.append(b)
  }
  m.hidden = false
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 8)}px`
  m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`
}
function hideMenu() {
  $('ctx').hidden = true
}
document.addEventListener('mousedown', (e) => {
  if (!$('ctx').hidden && !$('ctx').contains(e.target)) hideMenu()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMenu()
})
window.addEventListener('blur', hideMenu)
$('list').addEventListener('scroll', hideMenu)

// ---------- barra lateral ----------
// Arraste a borda direita para mudar a largura. Clique duplo na borda, o
// botão ou ⌘\ escondem e mostram. A largura fica salva neste computador.
const SIDE_MIN = 240
const SIDE_MAX = 560
let sideW = 340
let sideCollapsed = false
try {
  const v = JSON.parse(localStorage.getItem('wc-side') || 'null')
  if (v?.w) sideW = Math.max(SIDE_MIN, Math.min(SIDE_MAX, v.w))
  sideCollapsed = !!v?.c
} catch {}

function applySide() {
  document.documentElement.style.setProperty('--side-w', `${sideW}px`)
  document.body.classList.toggle('side-collapsed', sideCollapsed)
  try {
    localStorage.setItem('wc-side', JSON.stringify({ w: sideW, c: sideCollapsed }))
  } catch {}
}
function toggleSidebar() {
  sideCollapsed = !sideCollapsed
  applySide()
}
$('side-toggle').onclick = toggleSidebar
$('side-open').onclick = toggleSidebar
$('side-resize').ondblclick = toggleSidebar
$('side-resize').addEventListener('pointerdown', (e) => {
  e.preventDefault()
  const handle = $('side-resize')
  handle.setPointerCapture(e.pointerId)
  document.body.classList.add('resizing')
  const move = (ev) => {
    // Arrastar bem para a esquerda esconde a barra; voltar mostra de novo.
    sideCollapsed = ev.clientX < SIDE_MIN - 80
    if (!sideCollapsed) sideW = Math.max(SIDE_MIN, Math.min(SIDE_MAX, ev.clientX))
    applySide()
  }
  const up = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    document.body.classList.remove('resizing')
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
})
applySide()
window.wc.toggleSidebar = toggleSidebar
window.wc.newNote = newNote

loadNotes().then(load).then(listen).catch((e) => {
  $('empty-text').textContent = `Could not start: ${e.message}`
})
