/**
 * Minimal Chrome DevTools Protocol driver.
 *
 * Playwright cannot install browsers in this environment (no network access to
 * the browser CDN, and postinstall scripts are blocked by the sandbox), so the
 * end-to-end suite drives the locally installed Chrome through CDP directly.
 * This file contains only what the tests need: navigation, evaluation, real
 * input events, screenshots and console/error capture.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface ConsoleMessage {
  type: string
  text: string
}

export interface BrowserOptions {
  executablePath?: string
  width?: number
  height?: number
  headless?: boolean
}

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

export function findBrowser(): string {
  for (const candidate of CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error('Nenhum navegador Chromium encontrado. Defina CHROME_PATH.')
}

interface CdpClient {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on(event: string, listener: (params: any) => void): void
  close(): void
}

async function connect(wsUrl: string): Promise<CdpClient> {
  const socket = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error(`Falha ao conectar em ${wsUrl}`)), { once: true })
  })

  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Array<(params: any) => void>>()

  socket.addEventListener('message', (event: MessageEvent) => {
    const payload = JSON.parse(String(event.data)) as {
      id?: number
      result?: unknown
      error?: { message: string }
      method?: string
      params?: unknown
    }
    if (payload.id !== undefined) {
      const entry = pending.get(payload.id)
      if (!entry) return
      pending.delete(payload.id)
      if (payload.error) entry.reject(new Error(payload.error.message))
      else entry.resolve(payload.result)
      return
    }
    if (payload.method) {
      for (const listener of listeners.get(payload.method) ?? []) listener(payload.params)
    }
  })

  return {
    send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
    },
    close() {
      socket.close()
    },
  }
}

export class Page {
  private constructor(
    private readonly client: CdpClient,
    readonly consoleMessages: ConsoleMessage[],
    readonly pageErrors: string[],
    readonly failedRequests: string[],
  ) {}

  static async open(options: BrowserOptions = {}): Promise<{ page: Page; close: () => Promise<void> }> {
    const executable = options.executablePath ?? findBrowser()
    const profileDir = mkdtempSync(join(tmpdir(), 'signalmess-chrome-'))
    const width = options.width ?? 1440
    const height = options.height ?? 900
    const debugPort = 9200 + Math.floor(Math.random() * 500)

    const args = [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      `--window-size=${width},${height}`,
      'about:blank',
    ]
    if (process.env.CHROME_NO_SANDBOX === '1') args.unshift('--no-sandbox')

    // stdio must be ignored: the sandbox forbids piped child stdio, so the
    // DevTools endpoint is discovered over HTTP instead of by parsing stderr.
    const child: ChildProcess = spawn(executable, args, { stdio: 'ignore' })

    const wsUrl = await waitForDevTools(debugPort, child)
    const client = await connect(wsUrl)

    const consoleMessages: ConsoleMessage[] = []
    const pageErrors: string[] = []
    const failedRequests: string[] = []

    client.on('Runtime.consoleAPICalled', (params: any) => {
      const text = (params.args ?? [])
        .map((arg: any) => arg.value ?? arg.description ?? arg.type)
        .join(' ')
      consoleMessages.push({ type: String(params.type), text })
    })
    client.on('Runtime.exceptionThrown', (params: any) => {
      const detail = params.exceptionDetails
      pageErrors.push(detail?.exception?.description ?? detail?.text ?? 'exceção desconhecida')
    })
    client.on('Network.loadingFailed', (params: any) => {
      if (params.errorText === 'net::ERR_ABORTED') return
      failedRequests.push(`${params.errorText}: ${params.requestId}`)
    })

    await client.send('Runtime.enable')
    await client.send('Network.enable')
    await client.send('Page.enable')
    await client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    })

    const page = new Page(client, consoleMessages, pageErrors, failedRequests)

    return {
      page,
      close: async () => {
        try {
          client.close()
        } catch {
          /* ignore */
        }
        child.kill()
        await new Promise((resolve) => setTimeout(resolve, 150))
        try {
          rmSync(profileDir, { recursive: true, force: true })
        } catch {
          /* Windows may hold a handle briefly; not fatal for tests */
        }
      },
    }
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 700,
    })
  }

  async goto(url: string, waitUntil: 'load' | 'networkIdle' = 'load'): Promise<void> {
    await this.client.send('Page.navigate', { url })
    await this.waitFor(() => this.evaluate<boolean>('document.readyState !== "loading"'), 15_000)
    if (waitUntil === 'networkIdle') {
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.client.send<{
      result: { value?: T; description?: string }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate falhou',
      )
    }
    return result.result.value as T
  }

  async waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000, label = 'condição'): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await condition()) return
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    throw new Error(`Tempo esgotado aguardando ${label}`)
  }

  async waitForText(text: string, timeoutMs = 10_000): Promise<void> {
    const needle = text.toLowerCase()
    await this.waitFor(
      async () => (await this.evaluate<string>('document.body.innerText')).toLowerCase().includes(needle),
      timeoutMs,
      `texto "${text}"`,
    )
  }

  async waitForSelector(selector: string, timeoutMs = 10_000): Promise<void> {
    await this.waitFor(
      async () => this.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),
      timeoutMs,
      `seletor ${selector}`,
    )
  }

  /** Click by visible text within an optional container selector. */
  async clickText(text: string, selector = 'button, a'): Promise<void> {
    const clicked = await this.evaluate<boolean>(`
      (() => {
        const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const target = nodes.find((node) => (node.innerText || node.textContent || '').trim().includes(${JSON.stringify(text)}));
        if (!target) return false;
        target.scrollIntoView({ block: 'center' });
        target.click();
        return true;
      })()
    `)
    if (!clicked) throw new Error(`Nenhum elemento "${selector}" com o texto "${text}"`)
    await new Promise((resolve) => setTimeout(resolve, 220))
  }

  async fill(selector: string, value: string): Promise<void> {
    const ok = await this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `)
    if (!ok) throw new Error(`Campo não encontrado: ${selector}`)
  }

  async press(key: string): Promise<void> {
    const map: Record<string, { code: string; keyCode: number }> = {
      Enter: { code: 'Enter', keyCode: 13 },
      Escape: { code: 'Escape', keyCode: 27 },
      Tab: { code: 'Tab', keyCode: 9 },
    }
    const info = map[key] ?? { code: key, keyCode: 0 }
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
    })
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
    })
  }

  /** Click at viewport coordinates (for canvas/screenshot interaction checks). */
  async clickAt(x: number, y: number): Promise<void> {
    await this.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  async text(): Promise<string> {
    return this.evaluate<string>('document.body.innerText')
  }

  async url(): Promise<string> {
    return this.evaluate<string>('location.href')
  }

  async screenshot(path: string, options: { fullPage?: boolean } = {}): Promise<void> {
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
    if (options.fullPage) {
      const size = await this.evaluate<{ width: number; height: number }>(`({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      })`)
      const maxHeight = 8000
      clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, maxHeight), scale: 1 }
      await this.setViewport(size.width, Math.min(size.height, maxHeight))
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const result = await this.client.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip } : {}),
      captureBeyondViewport: true,
    })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from(result.data, 'base64'))
  }

  /** Detect elements that overflow the viewport horizontally. */
  async horizontalOverflow(): Promise<string[]> {
    return this.evaluate<string[]>(`
      (() => {
        const docWidth = document.documentElement.clientWidth;
        const offenders = [];
        const inScrollContainer = (el) => {
          for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'hidden') {
              return true;
            }
          }
          return false;
        };
        for (const el of document.querySelectorAll('body *')) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.right <= docWidth + 1.5) continue;
          const style = getComputedStyle(el);
          if (style.position === 'fixed' || style.visibility === 'hidden' || style.display === 'none') continue;
          if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
          if (inScrollContainer(el)) continue;
          offenders.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 70) + ' [right=' + Math.round(rect.right) + ' > ' + docWidth + ']');
          if (offenders.length > 6) break;
        }
        return offenders;
      })()
    `)
  }

  /** Interactive controls smaller than the 40px comfortable target. */
  async smallTargets(): Promise<string[]> {
    return this.evaluate<string[]>(`
      (() => {
        const out = [];
        for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"]')) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (el.closest('[aria-hidden="true"]')) continue;
          if (rect.height >= 30 && rect.width >= 30) continue;
          const label = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40);
          out.push(label + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height));
          if (out.length > 8) break;
        }
        return out;
      })()
    `)
  }

  /** Elements whose text is clipped without an ellipsis/overflow rule. */
  async clippedText(): Promise<string[]> {
    return this.evaluate<string[]>(`
      (() => {
        const out = [];
        for (const el of document.querySelectorAll('h1, h2, h3, p, span, td, th')) {
          if (el.children.length > 0) continue;
          const style = getComputedStyle(el);
          if (style.overflow === 'visible' && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
            out.push((el.textContent || '').slice(0, 50));
            if (out.length > 6) break;
          }
        }
        return out;
      })()
    `)
  }
}

/** Poll the DevTools HTTP endpoint until the browser is ready, then attach to a page. */
async function waitForDevTools(port: number, child: ChildProcess): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < 20_000) {
    if (child.exitCode !== null) {
      throw new Error(`Navegador encerrou antes de expor o DevTools (código ${child.exitCode}).`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = (await response.json()) as Array<{
          type: string
          webSocketDebuggerUrl?: string
        }>
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl

        // No page target yet: ask the browser to open one.
        const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
        if (created.ok) {
          const target = (await created.json()) as { webSocketDebuggerUrl?: string }
          if (target.webSocketDebuggerUrl) return target.webSocketDebuggerUrl
        }
      }
    } catch {
      /* browser not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('O navegador não expôs o endpoint do DevTools a tempo.')
}
