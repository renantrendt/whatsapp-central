// Janela do app no Mac. Ela sobe o servidor local dentro do próprio app e
// abre a tela. Fechar a janela não encerra o app: ele continua recebendo.
const { app, BrowserWindow, Menu, shell, session, systemPreferences } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const PORT = 4319
const ORIGIN = `http://127.0.0.1:${PORT}`
let win = null
let quitting = false

app.setName('Whatsapp Central')

// Chama um comando da tela (definidos em ui/app.js, no objeto window.wc).
function ui(command) {
  if (!win) return
  win.show()
  win.webContents.executeJavaScript(`window.wc && window.wc.${command}()`).catch(() => {})
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Connect New Account…', click: () => ui('connectNew') },
          { label: 'Accounts…', click: () => ui('showAccounts') },
          { label: 'Show Calls Windows', click: () => callWindows.forEach((w) => !w.isDestroyed() && w.show()) },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [
          { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => ui('newNote') },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'Conversation',
        submenu: [{ label: 'Archive or Unarchive (press E)', click: () => ui('archiveSelected') }],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => ui('toggleSidebar') },
          { label: 'Find Conversation', accelerator: 'CmdOrCtrl+K', click: () => ui('openPalette') },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ])
  )
}

// ---------- ligações ----------
// Para ligar e atender, cada número tem uma "janela de ligações" com o WhatsApp
// Web oficial (web.whatsapp.com), com microfone e câmera liberados. É a mesma
// ideia do Volt. Cada número guarda o próprio login numa sessão separada. A
// janela fica aberta escondida, para tocar quando chega uma ligação.
const callWindows = new Map() // conta -> janela
const callsFile = () => path.join(app.getPath('userData'), 'calls.json')

function readCallAccounts() {
  try {
    return JSON.parse(fs.readFileSync(callsFile(), 'utf8'))
  } catch {
    return {}
  }
}

function rememberCallAccount(account, label) {
  const all = readCallAccounts()
  all[account] = label
  fs.writeFileSync(callsFile(), JSON.stringify(all))
}

// O WhatsApp Web só aceita navegadores conhecidos. Monta a mesma identificação
// que o Chrome do Mac usa, com a versão do Chrome que vem dentro do app. Sem isso
// o Electron acrescenta o nome do app e o WhatsApp mostra "atualize o Chrome".
function chromeUserAgent() {
  const major = String(process.versions.chrome).split('.')[0]
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

function callWindow(account, label) {
  let w = callWindows.get(account)
  if (w && !w.isDestroyed()) return w
  const ses = session.fromPartition(`persist:calls-${account}`)
  ses.setUserAgent(chromeUserAgent())
  // Só microfone, câmera e tela cheia. Sem avisos de mensagem: o Whatsapp Central já avisa.
  ses.setPermissionRequestHandler((_wc, permission, done, details) => {
    if (permission === 'media') {
      const kinds = details.mediaTypes?.length ? details.mediaTypes : ['audio']
      Promise.all(kinds.map((k) => systemPreferences.askForMediaAccess(k === 'video' ? 'camera' : 'microphone')))
        .then((ok) => done(ok.every(Boolean)), () => done(false))
    } else {
      done(permission === 'fullscreen')
    }
  })
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'fullscreen')

  w = new BrowserWindow({
    width: 1040,
    height: 740,
    show: false,
    title: `Calls - ${label}`,
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  })
  w.on('page-title-updated', (e) => e.preventDefault()) // mantém "Calls - número" no título
  w.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      w.hide() // continua rodando escondida, para a próxima ligação tocar
    }
  })
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.setUserAgent(chromeUserAgent())
  w.loadURL('https://web.whatsapp.com').catch(() => {})
  if (process.env.WC_DEBUG_CALLS) {
    w.webContents.on('did-finish-load', () => setTimeout(() => {
      w.webContents.executeJavaScript('JSON.stringify({ url: location.pathname, ua: navigator.userAgent, brands: navigator.userAgentData && navigator.userAgentData.brands, text: document.body.innerText.slice(0, 80) })')
        .then((t) => console.log('[calls]', JSON.stringify(t)), () => {})
    }, 9000))
  }
  callWindows.set(account, w)
  return w
}

function setupCalls(bridge) {
  if (!bridge) return
  // Números que já têm a janela de ligações configurada abrem escondidos.
  for (const [account, label] of Object.entries(readCallAccounts())) callWindow(account, label)

  // Pedido da tela: configurar (ler o QR code) ou ligar para um contato.
  bridge.on('open', ({ account, label, phone }) => {
    rememberCallAccount(account, label)
    const w = callWindow(account, label)
    if (phone) w.loadURL(`https://web.whatsapp.com/send?phone=${encodeURIComponent(phone)}`).catch(() => {})
    w.show()
    w.focus()
  })
  // Ligação chegando: mostra a janela do número que está tocando.
  bridge.on('incoming', ({ account }) => {
    const w = callWindows.get(account)
    if (!w || w.isDestroyed()) return
    w.show()
    w.focus()
    app.focus({ steal: true })
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 480,
    title: 'Whatsapp Central',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  const load = () => win && win.loadURL(ORIGIN).catch(() => {})
  win.webContents.on('did-fail-load', () => setTimeout(load, 400))
  load()

  // Links de mensagens abrem no navegador padrão, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
    }
  })

  // O título da página traz o total de não lidas, por exemplo "(3) Whatsapp Central".
  win.on('page-title-updated', (_e, title) => {
    const m = /^\((\d+)\)/.exec(title)
    if (app.dock) app.dock.setBadge(m ? m[1] : '')
  })

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show()
      win.focus()
    }
  })
  app.on('before-quit', () => (quitting = true))
  app.on('activate', () => {
    if (win) win.show()
  })
  app.whenReady().then(async () => {
    process.env.WC_PORT = String(PORT)
    // A pasta mantém o nome antigo para não perder os dados de quem já usava o app.
    process.env.WC_DATA = path.join(app.getPath('appData'), 'WhatsCentral')
    process.env.WC_CALLS = '1' // liga o botão de ligar na tela
    const server = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.js')).href)
    setupCalls(server.calls)
    // Microfone para mensagens de voz: o macOS pergunta uma vez se o app pode usar.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) => {
      if (permission === 'media' && details.mediaTypes?.includes('audio') && process.platform === 'darwin') {
        systemPreferences.askForMediaAccess('microphone').then(done, () => done(false))
      } else {
        done(true) // o mesmo comportamento de antes para as outras permissões
      }
    })
    buildMenu()
    createWindow()
  })
}
