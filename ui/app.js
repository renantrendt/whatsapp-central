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
// No celular (app Android) a tela mostra uma coisa por vez: a lista ou a conversa.
const isPhone = /Android|iPhone/i.test(navigator.userAgent)
const narrow = () => matchMedia('(max-width: 700px)').matches

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
  document.body.classList.toggle('show-main', which !== 'empty')
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
  if (isPhone) return showDialog({ mode: 'phone' })
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
    const syncBox = el('div', 'sync-box')
    body.append(syncBox)
    renderSync(syncBox)
    return
  }

  if (d.mode === 'phone') return renderPhoneForm(body, d)

  // modo "connect": mostra o QR code ou o código de uma conta nova
  const a = accountOf(d.account)
  $('dialog-title').textContent = 'Connect new account'
  if (!a) {
    body.append(el('p', null, 'Starting...'))
  } else if (a.status === 'open') {
    body.append(el('p', null, `Connected as ${a.me}. Loading conversations...`))
    setTimeout(() => state.dialog?.account === a.id && $('dialog').close(), 1500)
  } else if (a.status === 'code' && a.pairCode) {
    body.append(el('p', null, 'On the phone with this number, open WhatsApp and type this code:'))
    body.append(el('div', 'pair-code', `${a.pairCode.slice(0, 4)}-${a.pairCode.slice(4)}`))
    const ol = el('ol')
    for (const s of [
      'Go to Settings, then Linked devices.',
      'Tap Link a device.',
      'Tap Link with phone number instead and type the code above.',
    ]) ol.append(el('li', null, s))
    body.append(ol)
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
    body.append(linkButton('Link with phone number instead', () => showDialog({ mode: 'phone', account: a.id })))
  } else if (a.status === 'connecting') {
    body.append(el('p', null, 'Connecting...'))
  } else {
    if (a.error) body.append(el('p', 'err', a.error))
    const b = el('button', 'primary', 'Try again')
    b.onclick = () => api('/api/connect', { account: a.id }).catch(alertError)
    body.append(b)
    body.append(linkButton('Link with phone number instead', () => showDialog({ mode: 'phone', account: a.id })))
  }
}

// Sincronização das notas com o outro aparelho, pelo Tailscale.
async function renderSync(box) {
  box.replaceChildren(el('h3', null, 'Notes sync'))
  let s
  try {
    s = await api('/api/sync')
  } catch {
    box.append(el('p', null, 'Not available.'))
    return
  }
  if (s.peers.length) {
    box.append(el('p', 'ok', `Syncing with ${s.peers.map((p) => p.split(':')[0]).join(', ')}`))
    box.append(el('small', null, s.lastSync ? `Last sync at ${clock(s.lastSync / 1000)}` : 'Not synced yet'))
    if (s.error) box.append(el('p', 'err', s.error))
    box.append(linkButton('Stop syncing', async () => {
      if (!confirm('Stop syncing notes with the other device? Notes already copied stay on both.')) return
      await api('/api/sync/unpair', {}).catch(alertError)
      renderSync(box)
    }))
    return
  }
  if (s.error) box.append(el('p', 'err', s.error))
  if (s.code) {
    box.append(el('p', null, 'Code of this device. Type it on the other device:'))
    box.append(el('div', 'pair-code small', s.code))
  } else {
    box.append(el('p', null, 'Turn on Tailscale on this device to sync notes.'))
  }
  box.append(el('p', null, 'Or type the code shown on the other device:'))
  const input = el('input', 'phone-input')
  input.placeholder = '100.101.150.56/ABCD2345EFGH'
  input.autocapitalize = 'characters'
  input.spellcheck = false
  const go = el('button', 'primary', 'Pair')
  go.onclick = async () => {
    go.disabled = true
    try {
      await api('/api/sync/pair', { code: input.value })
      await reloadNotes()
      renderSync(box)
    } catch (e) {
      go.disabled = false
      alertError(e)
    }
  }
  box.append(input, go)
}

function linkButton(text, onclick) {
  const b = el('button', 'link-btn', text)
  b.type = 'button'
  b.onclick = onclick
  return b
}

// Ligação por número: o WhatsApp mostra um código de 8 letras para digitar no
// celular. É o único jeito quando o app roda no mesmo celular do WhatsApp.
function renderPhoneForm(body, d) {
  $('dialog-title').textContent = 'Connect new account'
  body.append(el('p', null, 'Type the WhatsApp number with country code.'))
  const input = el('input', 'phone-input')
  input.type = 'tel'
  input.placeholder = '+55 11 91234-5678'
  input.autocomplete = 'tel'
  const go = el('button', 'primary', 'Get code')
  const submit = async () => {
    const phone = input.value.replace(/\D/g, '')
    if (phone.length < 8) return alert('Type the full number with country code.')
    go.disabled = true
    try {
      if (d.account) {
        await api('/api/connect', { account: d.account, phone })
        showDialog({ mode: 'connect', account: d.account })
      } else {
        const { id } = await api('/api/connect-new', { phone })
        showDialog({ mode: 'connect', account: id })
      }
    } catch (e) {
      go.disabled = false
      alertError(e)
    }
  }
  go.onclick = submit
  // addEventListener, não onkeydown: um onkeydown que devolve false cancela a tecla.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit()
  })
  body.append(input, go)
  body.append(linkButton('Use a QR code instead', async () => {
    try {
      if (d.account) {
        await api('/api/connect', { account: d.account, phone: null })
        showDialog({ mode: 'connect', account: d.account })
      } else {
        const { id } = await api('/api/connect-new', {})
        showDialog({ mode: 'connect', account: id })
      }
    } catch (e) {
      alertError(e)
    }
  }))
  setTimeout(() => input.focus(), 50)
}

$('dialog-close').onclick = () => $('dialog').close()
$('dialog').addEventListener('close', () => {
  const d = state.dialog
  state.dialog = null
  // Fechou a janela do QR code sem ligar: desiste dessa conta nova.
  if ((d?.mode === 'connect' || d?.mode === 'phone') && d.account && !state.dialog) {
    api('/api/cancel', { account: d.account }).catch(() => {})
  }
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
  if (!state.accounts.length && !state.demo) {
    box.append(el('div', 'list-empty', 'No WhatsApp account connected yet.'))
    const b = el('button', 'primary', 'Connect account')
    b.onclick = connectNew
    const wrap = el('div', 'list-empty')
    wrap.append(b)
    box.append(wrap)
    return
  }
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
    // Clique direito (ou toque longo no celular) arquiva ou desarquiva.
    row.oncontextmenu = (e) => {
      e.preventDefault()
      showMenu(e.clientX, e.clientY, [
        { label: c.archived ? 'Unarchive' : 'Archive', action: () => setArchived(c, !c.archived) },
      ])
    }
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
  if (state.selected !== k) {
    stopRecording(true)
    clearStaged()
  }
  state.selected = k
  state.messages = []
  showMain('chat')
  try {
    window.Android?.chatOpened(k) // apaga o aviso dessa conversa no Android
  } catch {}
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

// Texto da mensagem com os endereços de site clicáveis, como no WhatsApp:
// "https://...", "www...." e também "site.com.br", desde que a terminação
// (.com, .br, .io...) exista na lista oficial da IANA (ui/tlds.js).
// O texto continua entrando como texto puro, nunca como HTML.
const SCHEME_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi
const DOMAIN_RE = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z][a-z0-9-]{1,62})(?::\d{2,5})?(?:[/?#][^\s<>"]*)?/gi

function trimUrl(url) {
  // Pontuação no fim da frase não faz parte do endereço.
  while (/[.,!?;:)\]}'"]$/.test(url)) url = url.slice(0, -1)
  return url
}

function findLinks(text) {
  const found = []
  for (const m of text.matchAll(SCHEME_RE)) {
    const url = trimUrl(m[0])
    if (url) found.push({ index: m.index, url, href: /^https?:\/\//i.test(url) ? url : `https://${url}` })
  }
  for (const m of text.matchAll(DOMAIN_RE)) {
    const before = text[m.index - 1] || ''
    // Fora: parte de um e-mail (fulano@site.com), de outra palavra ou de um endereço já achado.
    if (/[\w@.\/:-]/.test(before)) continue
    if (!TLDS.has(m[1].toLowerCase())) continue
    const url = trimUrl(m[0])
    if (!url.includes('.')) continue
    found.push({ index: m.index, url, href: `https://${url}` })
  }
  found.sort((a, b) => a.index - b.index)
  const out = []
  let end = 0
  for (const f of found) {
    if (f.index < end) continue // sobreposto a um link anterior
    try {
      if (!['http:', 'https:'].includes(new URL(f.href).protocol)) continue
    } catch {
      continue
    }
    out.push(f)
    end = f.index + f.url.length
  }
  return out
}

function linkify(text) {
  const box = el('div', 'text')
  let last = 0
  for (const f of findLinks(text)) {
    box.append(document.createTextNode(text.slice(last, f.index)))
    const a = el('a', null, f.url)
    a.href = f.href
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.onclick = (e) => e.stopPropagation() // não abre a barra de reações no celular
    box.append(a)
    last = f.index + f.url.length
  }
  box.append(document.createTextNode(text.slice(last)))
  return box
}

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

  if (!m.deleted && m.text) n.append(linkify(m.text))
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
  // Na tela de toque não existe "passar o mouse": um toque mostra os emojis.
  if (matchMedia('(hover: none)').matches) n.onclick = () => n.classList.toggle('show-react')

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
  if (!c || (!text && !staged)) return
  const btn = $('send')
  btn.disabled = true
  try {
    if (staged) {
      // Foto com legenda: o texto digitado vai junto.
      await upload(c, staged.file, { kind: 'image', mime: staged.file.type, caption: text })
      clearStaged()
    } else {
      await api('/api/send', { account: c.account, chat: c.id, text })
    }
    input.value = ''
    input.style.height = 'auto'
  } catch (err) {
    alertError(err)
  } finally {
    btn.disabled = false
    updateComposer()
    input.focus()
  }
})

// Mostra o microfone quando a caixa está vazia e "Send" quando há texto ou foto.
function updateComposer() {
  const ready = input.value.trim().length > 0 || !!staged
  $('send').hidden = !ready
  $('mic').hidden = ready || !navigator.mediaDevices?.getUserMedia
}
input.addEventListener('input', updateComposer)

// Envia um arquivo (foto ou voz). O corpo do pedido é o próprio arquivo.
async function upload(c, blob, opts) {
  const params = new URLSearchParams({ account: c.account, chat: c.id })
  for (const [k, v] of Object.entries(opts)) if (v != null && v !== '') params.set(k, v)
  const res = await fetch(`/api/send-file?${params}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: blob,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Could not send.')
}

// ---------- foto ----------
const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif)$/
let staged = null // foto escolhida, esperando o envio

function stageImage(file) {
  if (!file) return
  if (!IMAGE_TYPES.test(file.type)) return alert('Only JPEG, PNG, WebP or GIF images.')
  clearStaged()
  staged = { file, url: URL.createObjectURL(file) }
  $('staged-img').src = staged.url
  $('staged').hidden = false
  updateComposer()
  input.focus()
}

function clearStaged() {
  if (staged) URL.revokeObjectURL(staged.url)
  staged = null
  $('staged').hidden = true
  $('file').value = ''
  updateComposer()
}

$('attach').onclick = () => $('file').click()
$('file').onchange = () => stageImage($('file').files[0])
$('staged-remove').onclick = clearStaged
// Colar uma imagem (⌘V) ou arrastar para a conversa também prepara a foto.
input.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'))
  if (f) {
    e.preventDefault()
    stageImage(f)
  }
})
$('chat').addEventListener('dragover', (e) => e.preventDefault())
$('chat').addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'))
  if (f) {
    e.preventDefault()
    stageImage(f)
  }
})

// ---------- mensagem de voz ----------
// O navegador grava em WebM/Opus; o servidor converte para OGG/Opus, o formato
// das mensagens de voz do WhatsApp.
const rec = { recorder: null, stream: null, chunks: [], start: 0, timer: null, cancel: false, chat: null }

async function startRecording() {
  const c = state.chats.get(state.selected)
  if (!c || rec.recorder) return
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    return alert('The microphone is not available. Allow microphone access for Whatsapp Central in the system settings.')
  }
  const type = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t))
  if (!type) {
    stopStream()
    return alert('This device cannot record voice messages.')
  }
  Object.assign(rec, { chunks: [], cancel: false, chat: c, start: Date.now() })
  rec.recorder = new MediaRecorder(rec.stream, { mimeType: type, audioBitsPerSecond: 32000 })
  rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data)
  rec.recorder.onstop = finishRecording
  rec.recorder.start(250)
  $('composer').hidden = true
  $('recorder').hidden = false
  const tick = () => {
    const s = Math.floor((Date.now() - rec.start) / 1000)
    $('rec-time').textContent = `${Math.floor(s / 60)}:${two(s % 60)}`
    if (s >= 15 * 60) stopRecording(false) // limite de 15 minutos
  }
  tick()
  rec.timer = setInterval(tick, 250)
}

function stopStream() {
  rec.stream?.getTracks().forEach((t) => t.stop())
  rec.stream = null
}

function stopRecording(cancel) {
  if (!rec.recorder) return
  rec.cancel = cancel
  if (rec.recorder.state !== 'inactive') rec.recorder.stop()
}

async function finishRecording() {
  const recorder = rec.recorder
  rec.recorder = null
  clearInterval(rec.timer)
  stopStream()
  $('recorder').hidden = true
  $('composer').hidden = false
  const seconds = (Date.now() - rec.start) / 1000
  if (rec.cancel || seconds < 0.8) return
  const blob = new Blob(rec.chunks, { type: recorder.mimeType })
  const waveform = await computeWaveform(blob).catch(() => null)
  try {
    await upload(rec.chat, blob, { kind: 'audio', mime: blob.type, seconds: seconds.toFixed(1), waveform })
  } catch (e) {
    alertError(e)
  }
}

// As 64 barrinhas que o WhatsApp mostra na mensagem de voz (valores de 0 a 100).
async function computeWaveform(blob) {
  const ctx = new AudioContext()
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    const data = buf.getChannelData(0)
    const step = Math.max(1, Math.floor(data.length / 64))
    const vals = []
    for (let i = 0; i < 64; i++) {
      let sum = 0
      for (let j = 0; j < step; j++) sum += Math.abs(data[i * step + j] || 0)
      vals.push(sum / step)
    }
    const max = Math.max(...vals) || 1
    return btoa(String.fromCharCode(...vals.map((v) => Math.round((v / max) * 100))))
  } finally {
    ctx.close()
  }
}

$('mic').onclick = startRecording
$('rec-cancel').onclick = () => stopRecording(true)
$('rec-send').onclick = () => stopRecording(false)
updateComposer()

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
  } else if (ev.type === 'notes') {
    reloadNotes().catch(() => {})
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

// O outro aparelho mudou alguma nota. A nota que você está editando agora não é
// trocada: a sua edição é a mais recente e vai para o outro aparelho em seguida.
async function reloadNotes() {
  const { notes } = await api('/api/notes')
  const open = curNote()
  const editing = [editor, $('note-title')].includes(document.activeElement)
  state.notes = notes.map((n) => (notePending && n.id === notePending.id ? notePending : n))
  if (open && !state.notes.some((n) => n.id === open.id)) {
    state.selectedNote = null
    if (state.tab === 'notes') renderMain()
  } else if (open && state.tab === 'notes' && !editing && notePending?.id !== open.id) {
    renderNoteEditor()
  }
  if (state.tab === 'notes') renderList()
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
    box.append(el('div', 'list-empty', isPhone ? 'No notes yet. Tap ⋯ to create one.' : 'No notes yet. Press ⌘N to create one.'))
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
  document.body.classList.toggle('side-collapsed', sideCollapsed && !narrow())
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
window.addEventListener('resize', applySide)

// ---------- celular ----------
// Voltar (botão do Android ou seta no topo): da conversa ou nota para a lista.
// Devolve true quando tratou; false deixa o Android sair do app.
function back() {
  if (!$('dialog').hidden && $('dialog').open) {
    $('dialog').close()
    return true
  }
  if (!$('palette').hidden) {
    closePalette()
    return true
  }
  if (!narrow() || !document.body.classList.contains('show-main')) return false
  if (state.tab === 'notes') {
    flushNote()
    state.selectedNote = null
  } else {
    state.selected = null
    state.messages = []
  }
  showMain('empty')
  renderList()
  return true
}
for (const b of document.querySelectorAll('.back-btn')) b.onclick = back

$('side-more').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect()
  showMenu(r.left, r.bottom + 4, [
    { label: 'New note', action: newNote },
    { label: 'Find conversation', action: openPalette },
    { label: 'Connect new account', action: connectNew },
    { label: 'Accounts', action: () => showDialog({ mode: 'accounts' }) },
    ...(window.Android?.addWidget ? [{ label: 'Add widget to home screen', action: () => window.Android.addWidget() }] : []),
  ])
}

// Aberto por um aviso do Android: vai direto para a conversa.
function openChatKey(k) {
  const c = state.chats.get(k)
  if (!c) return
  const tab = c.archived ? 'archived' : 'inbox'
  if (state.tab !== tab) document.querySelector(`#tabs button[data-tab="${tab}"]`).click()
  openChat(k)
}
Object.assign(window.wc, { back, openChatKey })
window.wc.newNote = newNote

loadNotes().then(load).then(listen).catch((e) => {
  $('empty-text').textContent = `Could not start: ${e.message}`
})
