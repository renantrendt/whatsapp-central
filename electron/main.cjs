// Janela do app no Mac. Ela sobe o servidor local dentro do próprio app e
// abre a tela. Fechar a janela não encerra o app: ele continua recebendo.
const { app, BrowserWindow, Menu, shell, session, systemPreferences } = require('electron')
const path = require('node:path')
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
    await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.js')).href)
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
