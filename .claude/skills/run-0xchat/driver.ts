// Drives a headless Chromium against a running 0xChat server over the
// DevTools protocol. Reads one command per line from stdin; see SKILL.md.
// No dependencies: Bun's fetch/WebSocket plus whatever Chromium is installed.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BASE = process.env.BASE ?? 'http://localhost:3000'
const OUT = resolve(process.env.OUT ?? '.scratch/run')
const CHROMIUM = process.env.CHROMIUM ?? 'chromium'
// A fresh profile is a fresh burner identity; PROFILE keeps one across runs.
const profile = process.env.PROFILE ? resolve(process.env.PROFILE) : mkdtempSync(join(tmpdir(), '0xchat-run-'))
mkdirSync(OUT, { recursive: true })

const browser = Bun.spawn([CHROMIUM, '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'ignore', stderr: 'pipe' })

const browserUrl = await new Promise<string>((resolve, reject) => {
  void (async () => {
    const decoder = new TextDecoder()
    let seen = ''
    let found = false
    for await (const chunk of browser.stderr) {
      // Keep draining after the port shows up, so Chromium never blocks on a full pipe.
      if (found) continue
      seen += decoder.decode(chunk)
      const match = seen.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) { found = true; resolve(match[1]!) }
    }
    if (!found) reject(new Error(`Chromium exited before DevTools came up:\n${seen}`))
  })()
})
const targets = await (await fetch(`http://${new URL(browserUrl).host}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>
const ws = new WebSocket(targets.find(t => t.type === 'page')!.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))

let nextId = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
const logs: string[] = []
ws.addEventListener('message', event => {
  const msg = JSON.parse(String(event.data))
  if (msg.id) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p?.reject(new Error(msg.error.message))
    else p?.resolve(msg.result)
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${msg.params.type}] ${msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ')}`)
  } else if (msg.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`)
  }
})
const send = (method: string, params: object = {}) =>
  new Promise<any>((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function evaluate(expression: string): Promise<unknown> {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

// Polls rather than waiting for "load": the live event stream keeps the page
// loading forever, which is why `chromium --screenshot` hangs on this app.
async function waitFor(condition: string, what: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!(await evaluate(condition))) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout}ms waiting for ${what}`)
    await sleep(100)
  }
}
const query = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`
const waitForSelector = (selector: string) => waitFor(`!!${query(selector)}`, selector)

async function size(width: number, height = 640) {
  // Below 640px (Tailwind's sm breakpoint) the app switches to its phone layout.
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 640 })
}

// Headless pages report document.hasFocus() === false, and the app holds back
// loading and opening messages until the window is attentive. Emulate a focused
// window; the event lets listeners notice a change mid-run.
async function focus(on: boolean) {
  await send('Emulation.setFocusEmulationEnabled', { enabled: on })
  await evaluate(`window.dispatchEvent(new Event(${JSON.stringify(on ? 'focus' : 'blur')}))`)
}

const commands: Record<string, (arg: string) => Promise<void>> = {
  async size(arg) { const [w, h] = arg.split(/\s+/).map(Number); await size(w!, h) },
  async nav(arg) {
    await send('Page.navigate', { url: new URL(arg, BASE).href })
    await waitFor(`document.readyState !== 'loading'`, 'navigation')
  },
  async 'wait-for'(selector) { await waitForSelector(selector) },
  async 'wait-text'(text) { await waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, `text "${text}"`) },
  async click(selector) { await waitForSelector(selector); await evaluate(`${query(selector)}.click()`) },
  async fill(arg) {
    const [, selector, text] = arg.match(/^(\S+)\s+(.*)$/) ?? []
    if (!selector) throw new Error('usage: fill <selector> <text>')
    await waitForSelector(selector)
    // Preact listens for native input events, so set the value and fire one.
    await evaluate(`(() => { const el = ${query(selector)}; el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  },
  async text(selector) { await waitForSelector(selector); console.log(await evaluate(`${query(selector)}.innerText`)) },
  async eval(expression) { console.log(JSON.stringify(await evaluate(expression))) },
  async screenshot(name) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    const path = join(OUT, `${name || 'screenshot'}.png`)
    await Bun.write(path, Buffer.from(data, 'base64'))
    console.log(path)
  },
  async focus(arg) { await focus(arg !== 'off') },
  async sleep(ms) { await sleep(Number(ms)) },
  async logs() { console.log(logs.join('\n') || '(no console output)') },
}

// Close through DevTools, not a signal: Chromium writes localStorage to disk in
// delayed batches, and a killed browser loses the identity a short run just made.
async function closeBrowser() {
  try {
    const control = new WebSocket(browserUrl)
    await new Promise(r => control.addEventListener('open', r, { once: true }))
    control.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    await Promise.race([browser.exited, sleep(5000)])
  } finally {
    if (browser.exitCode === null) browser.kill()
    await browser.exited
  }
}

let failed = false
try {
  await send('Runtime.enable')
  await send('Page.enable')
  await size(1024, 700)
  await focus(true)
  for (const line of (await Bun.stdin.text()).split('\n').map(l => l.trim())) {
    if (!line || line.startsWith('#')) continue
    const [, name, arg = ''] = line.match(/^(\S+)\s*(.*)$/)!
    const command = commands[name!]
    if (!command) throw new Error(`Unknown command: ${name}`)
    console.error(`> ${line}`)
    await command(arg)
  }
} catch (error) {
  failed = true
  console.error(`error: ${(error as Error).message}`)
  if (logs.length) console.error(`page console:\n${logs.join('\n')}`)
  await commands.screenshot!('error').catch(() => {})
} finally {
  ws.close()
  await closeBrowser()
  if (!process.env.PROFILE) rmSync(profile, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
