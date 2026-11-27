// Tests for the connection report that paired devices exchange: the route
// /sync/diag in server/sync.js, the route /api/diag/peers in server/index.js
// and the helpers in server/diag.js.
//
// Part 3 starts four copies of the app's server. Each copy gets its own new
// data folder and an empty home folder, so the test never opens the real
// database. No copy connects to WhatsApp: two have no account, one runs in
// demo mode with made-up accounts, and one has an account folder whose login
// file says "not linked".
//
// The test needs Tailscale on, because the sync port answers only Tailscale
// addresses. It talks to this computer's own Tailscale address. It takes about
// 25 seconds.
//
// Run from the repo root: npm test
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = (file) => pathToFileURL(path.join(root, file)).href
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const keys = (o) => Object.keys(o || {}).join(',')

let pass = 0
let fail = 0
const ok = (cond, name) => {
  if (cond) pass++
  else {
    fail++
    console.log('FAIL', name)
  }
}

// Ports used only by this test. The real app uses 4318 and 4319.
const PORT = {
  mac: 47331, phone: 47332, old: 47333, odd: 47334, dead: 47335, starting: 47336, slow: 47337,
  big: 47338, stranger: 47339, redirect: 47340, target: 47341, bomb: 47342, empty: 47343,
}
const COPY = { mac: [47321, 47328], phone: [47322, 47329], demo: [47323, 47330], late: [47324, 47327] }
{
  // A port counts as free only when nothing listens on it, on this computer's
  // own address or on all addresses.
  const busy = new Set()
  const free = (port, host) =>
    new Promise((done) => {
      const s = net.createServer()
      s.once('error', () => done(busy.add(port)))
      s.listen(port, host, () => s.close(done))
    })
  for (const p of [...Object.values(PORT), ...Object.values(COPY).flat()]) {
    await free(p, '127.0.0.1')
    await free(p, '0.0.0.0')
  }
  if (busy.size) {
    console.log(`Not run: port ${[...busy].join(', ')} is in use. A copy from an earlier run may still be open.`)
    process.exit(2)
  }
}

// ---------- Part 1: the helpers in diag.js ----------
const { accountState, numberTag, cleanReport, createDiag } = await import(at('server/diag.js'))
const { openStore } = await import(at('server/store.js'))
// A made-up number, as the app shows it and as a WhatsApp id holds it.
const SHOWN = '+55 11 90000-0001'
const RAW = '5511900000001'
const OTHER = '5511900000002'
const ACCOUNT_KEYS = 'id,status,linked,error,newestChat,numberTag'
const STATE_KEYS = 'now,startedAt,upSec,mobile,starting,accounts'
const REPORT_KEYS = `${STATE_KEYS},pending,lines`

const tag = numberTag(RAW, 'SECRETONE234')
ok(/^[a-f0-9]{4}$/.test(tag), 'a number code is four hex digits')
ok(numberTag(SHOWN, 'SECRETONE234') === tag, 'the same number written in two ways gives the same code')
ok(numberTag(RAW, 'SECRETTWO234') !== tag, 'another pairing secret gives another code')
ok(numberTag(OTHER, 'SECRETONE234') !== tag, 'another number gives another code')
ok(numberTag('', 'SECRETONE234') === null && numberTag(RAW, null) === null && numberTag('abc', 'x') === null, 'no number or no secret gives no code')

const linked = accountState(
  { id: 'a1', status: 'open', me: SHOWN, error: null, qr: 'data:image/png;base64,AAAA', pairCode: 'ABCD1234' },
  { newestChat: 1764012345, number: OTHER, secret: 'SECRETONE234' }
)
ok(keys(linked) === ACCOUNT_KEYS, 'an account state has only the six allowed fields')
ok(linked.id === 'a1' && linked.status === 'open' && linked.linked === true && linked.newestChat === 1764012345, 'a linked account keeps its id, status and newest message time')
ok(linked.numberTag === tag, "a linked account's code comes from the number it has now, not from an older saved one")
ok(!JSON.stringify(linked).includes('90000') && !JSON.stringify(linked).includes('ABCD1234') && !JSON.stringify(linked).includes('AAAA'), 'the number, the QR code and the pairing code stay out')
const unlinked = accountState({ id: 'a2', status: 'idle', me: null, error: `Refused ${RAW}@s.whatsapp.net` }, { number: RAW, secret: 'SECRETONE234' })
ok(unlinked.linked === false && unlinked.newestChat === 0, 'an account without a number shows as not linked')
ok(unlinked.numberTag === tag, 'an account that is not linked gets the code of the number it last had')
ok(accountState({ id: 'a5', status: 'idle' }).numberTag === null, 'an account with no number at all gets no code')
ok(!unlinked.error.includes(RAW) && unlinked.error.includes('<n>'), 'a number inside the error text is replaced')
const crashed = accountState({ id: 'a3', status: 'idle', error: "Could not start: ENOENT: no such file, open '/Users/somebody/Library/x 90000-0001'" })
ok(crashed.error === 'Could not start', 'the exception text after the colon, with its file path, is cut')
ok(accountState({ id: 'a4', error: 'WhatsApp refused this connection (code 403).' }).error === 'WhatsApp refused this connection (code 403).', 'a fixed error text stays whole')

const dirty = cleanReport({
  now: 5,
  startedAt: 4,
  upSec: 3,
  mobile: true,
  starting: true,
  extra: 'x',
  error: 'boom',
  peer: 'not-me',
  accounts: [
    { id: 'p1', status: 'open', linked: true, me: SHOWN, qr: 'QRDATA', error: `Could not start: ${RAW}`, newestChat: 7, numberTag: 'ab12' },
    { id: 'p2', numberTag: 'ab123' },
    { id: 'p3', numberTag: 'AB12' },
    { id: SHOWN, status: SHOWN, newestChat: 1e308 },
    { id: 'p5', newestChat: -5 },
    'junk',
    null,
  ],
  pending: { p1: { 'rx message': 3, bad: 'x', huge: 1e308 }, junk: 5 },
  lines: ['a', 5, null, 'b'.repeat(30000)],
})
ok(keys(dirty) === REPORT_KEYS, 'a received report keeps only the eight allowed fields')
ok(dirty.accounts.length === 7 && dirty.accounts.every((a) => keys(a) === ACCOUNT_KEYS), 'each received account keeps only the six allowed fields')
ok(!JSON.stringify(dirty).includes('90000') && !JSON.stringify(dirty).includes('QRDATA') && !JSON.stringify(dirty).includes(RAW), 'a number or a QR code sent by the other device is dropped')
ok(dirty.starting === true && dirty.accounts[0].error === 'Could not start' && dirty.accounts[0].numberTag === 'ab12' && dirty.accounts[0].newestChat === 7, 'the allowed values of a received report stay')
ok(dirty.accounts[1].numberTag === null && dirty.accounts[2].numberTag === null, 'a number code in another shape is dropped')
ok(dirty.accounts[3].id === '' && dirty.accounts[3].status === '', 'an id or a status in another shape is dropped')
ok(dirty.accounts[3].newestChat === 1e15 && dirty.accounts[4].newestChat === 0 && dirty.pending.p1.huge === 1e15, 'a number out of range is brought into range')
ok(JSON.stringify(dirty.pending) === '{"p1":{"rx message":3,"bad":0,"huge":1000000000000000},"junk":{}}', 'received counters are numbers only')
ok(dirty.lines.length === 2 && dirty.lines[0] === 'a' && dirty.lines[1] === '{"k":"line-too-long","len":30000}', 'received lines are text only, and a line over the limit is replaced by a short valid one')
const wrong = cleanReport({ now: 'x', startedAt: null, upSec: {}, mobile: 'yes', starting: 1, accounts: 'no', pending: [1], lines: 'no' })
ok(JSON.stringify(wrong) === '{"now":0,"startedAt":0,"upSec":0,"mobile":false,"starting":false,"accounts":[],"pending":{},"lines":[]}', 'values of the wrong kind become empty ones')
ok(keys(cleanReport(null)) === REPORT_KEYS && cleanReport({ lines: Array(7000).fill('x') }).lines.length === 6000, 'an empty answer gives an empty report, and at most 6000 lines pass')
{
  const many = (n, make) => Object.fromEntries(Array.from({ length: n }, (_, i) => [make(i), 1]))
  const wide = cleanReport({
    accounts: Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, error: 'e'.repeat(500) })),
    pending: { ...many(25, (i) => `g${i}`), ['n'.repeat(60)]: many(400, (i) => `c${i}`), long: { ['k'.repeat(500)]: 1 } },
  })
  const groups = Object.keys(wide.pending)
  ok(wide.accounts.length === 20 && wide.accounts[0].error.length === 120, 'at most 20 accounts pass, each error text cut at 120 characters')
  ok(groups.length === 20, 'at most 20 counter groups pass')
  const big = cleanReport({ pending: { ['n'.repeat(60)]: many(400, (i) => `c${i}`), long: { ['k'.repeat(500)]: 1 } } })
  ok(Object.keys(big.pending)[0].length === 40 && Object.keys(Object.values(big.pending)[0]).length === 300, 'a group name is cut at 40 characters and a group holds at most 300 counters')
  ok(Object.keys(big.pending.long)[0].length === 200, 'a counter name is cut at 200 characters')
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-test-recorder-'))
  const rec = createDiag(dir)
  rec.log('a1', 'conn', { s: 'open' })
  rec.count('a1', 'rx message', 3)
  rec.count('a1', 'rx message', 2)
  const before = rec.tail(100).length
  const size = fs.statSync(path.join(dir, 'diag.log')).size
  const p = rec.pending()
  ok(JSON.stringify(p) === '{"a1":{"rx message":5}}', 'the counters not yet written can be read')
  p.a1['rx message'] = 99
  ok(rec.pending().a1['rx message'] === 5, 'changing what was read does not change the counters')
  ok(rec.tail(100).length === before && fs.statSync(path.join(dir, 'diag.log')).size === size, 'reading the counters writes nothing')
  rec.flush()
  ok(keys(rec.pending()) === '' && rec.tail(100).some((l) => JSON.parse(l).k === 'stat'), 'writing them empties them')
  fs.unlinkSync(path.join(dir, 'diag.log'))
  fs.rmdirSync(dir)
}

// ---------- Part 2: the checks of the sync port ----------
const load = async (port, name) => {
  process.env.WC_SYNC_PORT = String(port)
  return import(`${at('server/sync.js')}?${name}`)
}
const fakeStore = (settings) => {
  const s = new Map(Object.entries(settings))
  return {
    getSetting: (k) => s.get(k) ?? null,
    setSetting: (k, v) => void s.set(k, v),
    mergeNotes: () => 0,
    exportNotes: () => [],
  }
}
const SECRET = 'TESTSECRET23'
const device = async (name, report, extra = {}) =>
  (await load(PORT[name], name)).startSync({ store: fakeStore({ sync_secret: SECRET, ...extra.settings }), onNotesChanged() {}, report, ...extra.options })
const first = await load(PORT.phone, 'phone')
const ip = first.tailscaleIp()
if (!ip) {
  console.log('Not run: this computer has no Tailscale address. Turn Tailscale on and run again.')
  process.exit(2)
}
// The phone: it has a report. The report also carries things no report should.
first.startSync({
  store: fakeStore({ sync_secret: SECRET }),
  onNotesChanged() {},
  report: (n) => ({
    now: 5,
    mobile: true,
    peer: 'not-me',
    error: 'not an error',
    accounts: [{ id: 'p1', status: 'open', linked: true, me: SHOWN, qr: 'QRDATA' }],
    lines: Array.from({ length: n }, (_, i) => `line ${i}`),
  }),
})
// A device with the app from before this change: no report.
await device('old', undefined)
// A device that answers something that is not a report.
await device('odd', () => ({ now: 1 }))
// A device that is still starting: it says so and still sends its lines.
await device('starting', () => ({ starting: true, accounts: [], lines: ['{"k":"boot"}'] }))
// A device paired with some other device: it has another secret.
await device('stranger', () => ({ lines: ['not for you'] }), { settings: { sync_secret: 'OTHERSECRET2' } })
// Servers that are not the app: one never finishes its answer, one answers
// 9 MB, one answers a small text that costs a lot to parse, one answers
// nothing, and one sends the request on to another server.
const rawServers = []
const raw = (name, handler) =>
  new Promise((done) => {
    const s = http.createServer((req, res) => (req.resume(), handler(req, res)))
    rawServers.push(s)
    s.listen(PORT[name], '0.0.0.0', done)
  })
const jsonHead = { 'content-type': 'application/json' }
await raw('slow', (req, res) => (res.writeHead(200, jsonHead), res.write('{"lines":["a"')))
await raw('big', (req, res) => (res.writeHead(200, jsonHead), res.end(JSON.stringify({ lines: ['x'.repeat(9_000_000)] }))))
await raw('bomb', (req, res) => (res.writeHead(200, jsonHead), res.end(`{"lines":[],"x":${'['.repeat(150_000)}${']'.repeat(150_000)}}`)))
await raw('empty', (req, res) => (res.writeHead(204), res.end()))
const sentOn = new Set() // routes the redirecting server was asked for
let wrongServerHits = 0 // requests that reached the server it points to
let codeAtWrongServer = false
await raw('redirect', (req, res) => {
  sentOn.add(req.url)
  res.writeHead(307, { location: `http://${ip}:${PORT.target}${req.url}` })
  res.end()
})
await raw('target', (req, res) => {
  wrongServerHits++
  if (req.headers['x-wc-sync']) codeAtWrongServer = true
  res.writeHead(200, jsonHead)
  res.end(JSON.stringify({ lines: ['from the wrong server'], notes: [] }))
})
// The Mac: paired with all of them and with one that is off. It waits 1.5
// seconds for a report. Its own notes sync, 3 seconds after its start, asks
// the same devices in this order (the redirecting one early).
const order = ['phone', 'redirect', 'old', 'odd', 'starting', 'stranger', 'dead', 'big', 'bomb', 'empty', 'slow']
const peerList = order.map((name) => `${ip}:${PORT[name]}`)
const mac = await device('mac', () => ({ now: 1, lines: [] }), {
  settings: { sync_peers: JSON.stringify(peerList) },
  options: { reportWaitMs: 1500 },
})
await wait(400)

const ask = async (host, port, { method = 'POST', key, body = {} } = {}) => {
  const r = await fetch(`http://${host}:${port}/sync/diag`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-wc-sync': key } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  })
  return { code: r.status, data: await r.json().catch(() => ({})) }
}

let r = await ask('127.0.0.1', PORT.phone, { key: SECRET })
ok(r.code === 403 && !r.data.lines, 'an address outside Tailscale gets no report, even with the right code')
r = await ask(ip, PORT.phone, { key: 'WRONGSECRET2' })
ok(r.code === 403 && !r.data.lines, 'a wrong code gets no report')
r = await ask(ip, PORT.phone)
ok(r.code === 403 && !r.data.lines, 'a request without the code gets no report')
r = await ask(ip, PORT.phone, { method: 'GET', key: SECRET })
ok(r.code === 404 && !r.data.lines, 'a GET request gets no report')
r = await ask(ip, PORT.phone, { key: SECRET, body: { n: 5 } })
ok(r.code === 200 && r.data.lines?.length === 5, 'the right code from a Tailscale address gets the number of lines asked for')
r = await ask(ip, PORT.phone, { key: SECRET })
ok(r.code === 200 && r.data.lines?.length === 800, 'without a number it sends 800 lines')
r = await ask(ip, PORT.old, { key: SECRET })
ok(r.code === 404 && !r.data.lines, 'a device without a report answers 404')

const began = Date.now()
const reports = await mac.peerReports(3)
const took = Date.now() - began
ok(reports.length === order.length && reports.every((x, i) => x.peer === peerList[i]), 'one entry per paired device, each under its own address')
const from = Object.fromEntries(order.map((name, i) => [name, reports[i]]))
ok(from.phone.lines?.length === 3 && from.phone.mobile === true && !from.phone.error, 'the report of a paired device arrives')
ok(keys(from.phone) === `${REPORT_KEYS},peer` && keys(from.phone.accounts[0]) === ACCOUNT_KEYS, 'only the allowed fields of that report are passed on')
ok(!JSON.stringify(from.phone).includes('90000') && !JSON.stringify(from.phone).includes('QRDATA'), 'a number or a QR code in that report is not passed on')
ok(from.starting.starting === true && from.starting.lines?.length === 1 && !from.starting.error, 'a device that is still starting says so and still sends its lines')
ok(/older version/.test(from.old.error || '') && !from.old.lines, 'an older app gives a plain reason and no lines')
ok(from.odd.error === 'The answer is not a report.' && !from.odd.lines, 'an answer that is not a report is refused')
ok(/^That device refused the request \(answer 403\)/.test(from.stranger.error || '') && !from.stranger.lines, 'a device with another pairing secret gives the reason "refused"')
ok(/^The connection failed \(/.test(from.dead.error || '') && !from.dead.lines, 'a device that is off gives a reason')
ok(/^No complete answer in 1\.5 seconds/.test(from.slow.error || '') && !from.slow.lines, 'a device that never finishes its answer gives the waiting time as the reason')
ok(/larger than 8 MB/.test(from.big.error || '') && !from.big.lines, 'an answer over the size limit is not read')
ok(/more objects than a report/.test(from.bomb.error || '') && !from.bomb.lines, 'a small answer that would cost a lot to parse is not parsed')
ok(from.empty.error === 'The answer is not a report.' && !from.empty.lines, 'an empty answer (204) is refused')
ok(from.redirect.error === 'That device answered 307.' && !from.redirect.lines && sentOn.has('/sync/diag'), 'an answer that points to another server is refused')
ok(took < 4000, `the slow device does not hold the others past the waiting time (took ${took} ms)`)
// Only the two servers of the redirect check stay open, until the end of the test.
for (const s of rawServers.slice(0, 4)) s.closeAllConnections?.(), s.close()

// ---------- Part 3: copies of the whole server ----------
const copies = []
async function startCopy(name, extra = {}, nodeArgs = [], prepare = null) {
  const [port, syncPort] = COPY[name]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-test-${name}-`))
  const data = path.join(dir, 'data')
  const copy = { name, dir, data, child: null, port, syncPort, out: '', cookie: '' }
  copies.push(copy)
  if (prepare) await prepare(data)
  copy.child = spawn(process.execPath, [...nodeArgs, path.join(root, 'server/index.js')], {
    // A fresh environment: no setting of the real app, and an empty home
    // folder, so the real data folder cannot be opened even by mistake.
    env: { PATH: process.env.PATH, HOME: dir, WC_DATA: data, WC_PORT: String(port), WC_SYNC_PORT: String(syncPort), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  copy.child.stdout.on('data', (c) => (copy.out += c))
  copy.child.stderr.on('data', (c) => (copy.out += c))
  copy.gone = new Promise((done) => copy.child.on('exit', done))
  return copy
}
const running = (copy) => !!copy.child && copy.child.exitCode === null && copy.child.signalCode === null
async function ready(copy) {
  for (let i = 0; i < 100 && running(copy); i++) {
    try {
      const page = await fetch(`http://127.0.0.1:${copy.port}/`, { signal: AbortSignal.timeout(2000) })
      const m = /wc=([a-f0-9]+)/.exec(page.headers.get('set-cookie') || '')
      if (m) return (copy.cookie = `wc=${m[1]}`)
    } catch {}
    await wait(200)
  }
  throw new Error(`The ${copy.name} copy did not start:\n${copy.out}`)
}
const api = async (copy, route, { body, cookie = copy.cookie } = {}) => {
  const res = await fetch(`http://127.0.0.1:${copy.port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25000),
  })
  return { code: res.status, data: await res.json().catch(() => ({})) }
}
async function stop(copy) {
  if (!running(copy)) return
  copy.child.kill('SIGCONT')
  copy.child.kill('SIGTERM')
  await Promise.race([copy.gone, wait(5000)])
  if (running(copy)) copy.child.kill('SIGKILL')
}
// Deletes only the files this test knows the app or the test creates, one by
// one. A folder that holds anything else is left in place and named.
function tidy(copy) {
  const files = ['app.db', 'app.db-wal', 'app.db-shm', 'app.db-journal', 'diag.log', 'diag.log.1', 'auth/x1/creds.json']
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(copy.data, f))
    } catch {}
  }
  for (const d of ['app.db.lock', 'auth/x1', 'auth', '.'].map((d) => path.join(copy.data, d)).concat(copy.dir)) {
    try {
      fs.rmdirSync(d)
    } catch {}
  }
  if (fs.existsSync(copy.dir)) console.log(`Left in place, not empty: ${copy.dir}`)
}
// Stopped from outside (Ctrl+C, kill): close the copies and their folders too.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    for (const c of copies) if (running(c)) c.child.kill('SIGKILL')
    for (const c of copies) tidy(c)
    process.exit(130)
  })
}

try {
  // The phone copy uses the database engine the phone uses (node-sqlite3-wasm),
  // when this Node can switch its built-in SQLite off.
  const phoneDb = process.allowedNodeEnvironmentFlags.has('--no-experimental-sqlite') ? ['--no-experimental-sqlite'] : []
  if (!phoneDb.length) console.log('Note: this Node cannot switch off its built-in SQLite, so the phone copy uses the same engine as the Mac copy.')
  const macApp = await startCopy('mac')
  const phoneApp = await startCopy('phone', { WC_MOBILE: '1' }, phoneDb)
  const demoApp = await startCopy('demo', { WC_DEMO: '1' })
  await Promise.all([ready(macApp), ready(phoneApp), ready(demoApp)])

  // Stop here if a copy is not on its own empty data folder.
  for (const c of [macApp, phoneApp]) {
    const s = await api(c, '/api/state')
    if (s.code !== 200 || s.data.accounts?.length !== 0 || !fs.existsSync(path.join(c.data, 'app.db'))) {
      throw new Error(`The ${c.name} copy is not on its empty data folder. Stopped.`)
    }
  }

  // The demo copy has accounts with made-up numbers: the real report code, with accounts in it.
  {
    const before = (await api(demoApp, '/api/state')).data
    r = await api(demoApp, '/api/diag/peers')
    const after = (await api(demoApp, '/api/state')).data
    const here = r.data.here || {}
    const newest = (state, id) => Math.max(0, ...state.chats.filter((c) => c.account === id).map((c) => c.lastTs))
    ok(r.code === 200 && r.data.peers?.length === 0 && keys(here) === STATE_KEYS, 'the demo copy answers with its own state and no other device')
    ok(before.demo === true && before.accounts.length >= 2 && here.accounts?.length === before.accounts.length, 'the state lists every account of the copy')
    ok((here.accounts || []).every((a) => keys(a) === ACCOUNT_KEYS), 'each account in the real report has only the six allowed fields')
    ok(here.starting === false && (here.accounts || []).every((a) => a.status === 'open' && a.linked === true && a.error === null && a.numberTag === null), 'a connected account shows as open and linked, with no number code when the copy has no pairing secret')
    ok((here.accounts || []).every((a) => a.newestChat > 0 && a.newestChat >= newest(before, a.id) && a.newestChat <= newest(after, a.id)), "each account's newest message time is the newest time among its chats")
    const text = JSON.stringify(here)
    ok(before.accounts.every((a) => a.me && !text.includes(a.me) && !text.includes(a.me.replace(/\D/g, ''))), 'no number of the copy is in the real report')
  }

  // A copy held in the middle of its start. Its account folder has a named
  // pipe where the login file should be, so the copy waits when it reads it.
  // The sync port already answers: the report says "starting", lists the
  // account with the code of its saved number, and has the recorder lines.
  // Then the test writes a login file that says "not linked": the copy drops
  // the account without ever connecting, and finishes its start.
  {
    const lateSecret = 'LATESECRET23'
    const late = await startCopy('late', {}, [], async (data) => {
      fs.mkdirSync(path.join(data, 'auth', 'x1'), { recursive: true })
      execFileSync('mkfifo', [path.join(data, 'auth', 'x1', 'creds.json')])
      const st = await openStore(path.join(data, 'app.db'))
      st.setSetting('sync_secret', lateSecret)
      st.setSetting('num:x1', RAW)
      st.db.close?.()
    })
    let rep = null
    for (let i = 0; i < 60 && !rep?.accounts?.length; i++) {
      await wait(200)
      const a = await ask(ip, late.syncPort, { key: lateSecret, body: { n: 50 } }).catch(() => null)
      if (a?.code === 200) rep = a.data
    }
    ok(rep?.starting === true, 'a copy held in its start reports "starting"')
    ok((rep?.lines || []).some((l) => JSON.parse(l).k === 'boot'), 'its recorder lines are served during the start')
    ok(JSON.stringify(rep?.accounts) === JSON.stringify([{ id: 'x1', status: 'idle', linked: false, error: null, newestChat: 0, numberTag: numberTag(RAW, lateSecret) }]), 'its account shows as not linked, with the code of its saved number and of its own pairing secret')
    const screen = await fetch(`http://127.0.0.1:${late.port}/`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)
    ok(screen === false, 'its own screen is not served before the start ends')
    // Opening the pipe for writing fails until the copy is reading it.
    let pipe = null
    for (let i = 0; i < 50 && pipe === null; i++) {
      try {
        pipe = fs.openSync(path.join(late.data, 'auth', 'x1', 'creds.json'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      } catch {
        await wait(200)
      }
    }
    if (pipe === null) throw new Error('The late copy never read its login file.')
    fs.writeSync(pipe, '{}')
    fs.closeSync(pipe)
    await ready(late)
    r = await api(late, '/api/diag/peers')
    ok(r.data.here?.starting === false && r.data.here.accounts?.length === 0, 'after the start it no longer reports "starting", and the account that was not linked is gone')
    await stop(late)
  }

  r = await api(macApp, '/api/diag/peers')
  ok(r.code === 200 && r.data.peers?.length === 0 && r.data.here?.mobile === false, 'before pairing, the Mac lists no other device')
  r = await api(macApp, '/api/diag/peers', { cookie: '' })
  ok(r.code === 401 && !r.data.peers, 'without the access cookie the Mac route gives nothing')

  // Pair the Mac with the phone, as the Accounts screen does.
  const shown = (await api(phoneApp, '/api/sync')).data.code || ''
  const [host, secret] = shown.split('/')
  ok(host === ip && !!secret, 'the phone copy shows a pairing code')
  r = await api(macApp, '/api/sync/pair', { body: { code: `${host}:${phoneApp.syncPort}/${secret}` } })
  ok(r.code === 200 && r.data.peers?.[0] === `${ip}:${phoneApp.syncPort}`, 'the Mac copy pairs with the phone copy')

  r = await api(macApp, '/api/diag/peers?n=50')
  let seen = r.data.peers?.[0] || {}
  const rows = (seen.lines || []).map((l) => JSON.parse(l))
  ok(r.code === 200 && r.data.peers?.length === 1 && seen.peer === `${ip}:${phoneApp.syncPort}` && !seen.error, 'the Mac gets one report, from the phone')
  ok(keys(seen) === `${REPORT_KEYS},peer` && keys(r.data.here) === STATE_KEYS, "the phone's report has the eight allowed fields and its address")
  ok(seen.mobile === true && r.data.here?.mobile === false, 'the report says it comes from a phone, and this device says it is not one')
  ok(rows.some((x) => x.k === 'boot' && x.mobile === true), "the phone's recorder lines arrive, with its start line")
  ok(seen.starting === false && Array.isArray(seen.accounts) && seen.accounts.length === 0, "the phone's account list arrives, and it is not starting")
  ok(Math.abs(seen.now - Date.now()) < 10000 && seen.startedAt <= seen.now && seen.now - seen.startedAt < 120000 && seen.upSec >= 0, "the phone's clock, start time and running time arrive")
  r = await api(macApp, '/api/diag/peers?n=1')
  ok(r.data.peers?.[0]?.lines?.length === 1, 'the number of lines asked for is passed on')
  r = await api(phoneApp, '/api/diag/peers?n=50')
  ok(r.data.peers?.length === 1 && r.data.peers[0].peer === `${ip}:${macApp.syncPort}` && r.data.peers[0].mobile === false, 'the phone can read the Mac the same way')

  r = await ask('127.0.0.1', phoneApp.syncPort, { key: secret })
  ok(r.code === 403 && !r.data.lines, 'the real server also refuses an address outside Tailscale')
  r = await ask(ip, phoneApp.syncPort, { key: 'WRONGSECRET2' })
  ok(r.code === 403 && !r.data.lines, 'the real server also refuses a wrong code')

  // Notes still travel on the same link.
  const title = `test note ${Date.now()}`
  await api(macApp, '/api/notes/save', { body: { title, body: '<p>x</p>' } })
  let arrived = false
  for (let i = 0; i < 40 && !arrived; i++) {
    await wait(250)
    arrived = ((await api(phoneApp, '/api/notes')).data.notes || []).some((n) => n.title === title)
  }
  ok(arrived, 'a note written on the Mac copy still reaches the phone copy')

  // Freeze the phone copy for 9 seconds. Its recorder counts that as one sleep,
  // in a counter not yet written. Reading the report shows the counter and
  // writes nothing: two reads give the same lines.
  phoneApp.child.kill('SIGSTOP')
  await wait(9000)
  phoneApp.child.kill('SIGCONT')
  await wait(3000)
  seen = (await api(macApp, '/api/diag/peers?n=6000')).data.peers?.[0] || {}
  const again = (await api(macApp, '/api/diag/peers?n=6000')).data.peers?.[0] || {}
  ok(seen.pending?.['-']?.sleeps >= 1 && seen.pending['-'].sleptSec >= 5, "the phone's counters not yet written arrive (one sleep counted)")
  ok(seen.lines?.length > 0 && again.lines?.length === seen.lines.length && again.pending?.['-']?.sleeps === seen.pending?.['-']?.sleeps, 'reading the report twice adds no line to the recorder and keeps the counters')
  ok(!(again.lines || []).some((l) => JSON.parse(l).k === 'stat'), 'no counter line was written by the reads')

  // The phone goes off: the Mac still answers, with a reason.
  await stop(phoneApp)
  r = await api(macApp, '/api/diag/peers')
  ok(r.code === 200 && /^The connection failed \(/.test(r.data.peers?.[0]?.error || '') && !r.data.peers[0].lines, 'with the phone off, the Mac answers with a reason')

  // By now the fake Mac of Part 2 has also run its notes sync through the
  // redirecting server. Nothing went on to the server that one points to.
  ok(sentOn.has('/sync/notes'), 'the notes sync also met the redirecting server')
  ok(wrongServerHits === 0 && !codeAtWrongServer, 'no request, and so no pairing code and no note, went on to the other server')
} catch (e) {
  fail++
  console.log('FAIL', e.message)
} finally {
  for (const c of copies) await stop(c)
  for (const c of copies) tidy(c)
}

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
