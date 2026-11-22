// Tira os prints do README usando o modo de demonstração (contas e conversas falsas).
// Uso: npm run screenshots   (salva em docs/screenshots/)
const { app, BrowserWindow, nativeTheme } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const out = path.join(root, 'docs', 'screenshots')
const PORT = 4399
const URL = `http://127.0.0.1:${PORT}/`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const NOTE = `<div><b>Before Friday</b></div>
<ul class="checklist"><li data-checked="true">Send the invoice to Marina</li><li data-checked="false">Sign the tax form</li><li data-checked="false">Reply to Sam about the review</li></ul>
<div>Shopping</div><ul><li>Coffee</li><li>Bread</li></ul>
<div>Trip plan</div><ol><li>Book flights</li><li>Pick the hotel</li></ol>`

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'
  fs.mkdirSync(out, { recursive: true })
  const server = spawn('node', ['server/index.js'], {
    cwd: root,
    env: { ...process.env, WC_DEMO: '1', WC_PORT: String(PORT) },
    stdio: 'ignore',
  })
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(URL)).ok) break
      } catch {}
      await wait(200)
    }
    const win = new BrowserWindow({ width: 1200, height: 760, show: false, webPreferences: { offscreen: false } })
    await win.loadURL(URL)
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`)
    const shot = async (name) => {
      await wait(500)
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(out, name), img.toPNG())
      console.log('saved', name)
    }

    // A demonstração faz uma conversa arquivada voltar para a caixa de entrada depois de 6 s.
    await wait(7000)
    await js(`[...document.querySelectorAll('.row')].find((r) => r.textContent.includes('Marina')).click()`)
    await shot('inbox.png')

    await js(`window.wc.openPalette(); const i = document.getElementById('palette-input'); i.value = 'a'; i.dispatchEvent(new Event('input'))`)
    await shot('search.png')
    await js(`document.getElementById('palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)

    await js(`
      await fetch('/api/notes/save', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Week plan', body: ${JSON.stringify(NOTE)} }) })
      location.reload()`)
    await wait(1500)
    await js(`document.querySelector('#tabs button[data-tab="notes"]').click(); await new Promise((r) => setTimeout(r, 200)); document.querySelector('.note-row').click()`)
    await shot('notes.png')
  } finally {
    server.kill()
    app.quit()
  }
})
