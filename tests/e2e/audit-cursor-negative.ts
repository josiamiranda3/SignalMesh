/**
 * Negative cursor check.
 *
 * The first audit proves clickable things are `pointer`. This one proves the
 * opposite failure did not happen: that the fix did not scatter `pointer` onto
 * elements that are purely informational, and that text entry keeps `text`.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-cursor-negative.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { spaRoot } from './dist-root.ts'
import { Page } from './cdp.ts'

const PORT = 8831
const BASE = `http://127.0.0.1:${PORT}`

const CHECK = `
(() => {
  const bad = [];
  const isVisible = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  // 1. Informational text must not be a hand.
  for (const el of document.querySelectorAll('p, span, h1, h2, h3, h4, li, td, th, div')) {
    if (!isVisible(el)) continue;
    if (el.closest('a, button, label, summary, [role="button"], [role="tab"]')) continue;
    if (el.hasAttribute('role') || el.hasAttribute('onclick') || el.tabIndex >= 0) continue;
    const s = getComputedStyle(el);
    if (s.cursor === 'pointer') {
      bad.push({ kind: 'informational-is-pointer', tag: el.tagName.toLowerCase(),
                 cls: String(el.className).slice(0, 50), text: (el.textContent||'').trim().slice(0, 30) });
    }
  }

  // 2. Text fields must be a caret, never a hand.
  for (const el of document.querySelectorAll('input, textarea')) {
    if (!isVisible(el)) continue;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (['checkbox','radio','file','submit','reset','button'].includes(type)) continue;
    const s = getComputedStyle(el);
    if (s.cursor === 'pointer') {
      bad.push({ kind: 'text-field-is-pointer', tag: el.tagName.toLowerCase(),
                 text: el.getAttribute('aria-label') || el.getAttribute('placeholder') || '' });
    }
    if (!el.disabled && s.cursor !== 'text' && s.cursor !== 'auto') {
      bad.push({ kind: 'text-field-lost-caret', tag: el.tagName.toLowerCase(),
                 cursor: s.cursor, text: el.getAttribute('aria-label') || '' });
    }
  }

  // 3. Disabled native controls must not invite a click.
  for (const el of document.querySelectorAll('button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled="true"]')) {
    if (!isVisible(el)) continue;
    const s = getComputedStyle(el);
    if (s.cursor === 'pointer') {
      bad.push({ kind: 'disabled-is-pointer', tag: el.tagName.toLowerCase(),
                 text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30) });
    }
  }

  // 4. Non-interactive decorative elements.
  for (const el of document.querySelectorAll('svg, img, hr, [aria-hidden="true"]')) {
    if (!isVisible(el)) continue;
    if (el.closest('a, button, label, [role="button"], [role="tab"]')) continue;
    const s = getComputedStyle(el);
    if (s.cursor === 'pointer') {
      bad.push({ kind: 'decorative-is-pointer', tag: el.tagName.toLowerCase(),
                 cls: String(el.className.baseVal !== undefined ? el.className.baseVal : el.className).slice(0, 40) });
    }
  }

  return bad;
})()
`

async function main(): Promise<void> {
  const built = await buildApp({
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: ':memory:',
      PORT: String(PORT),
      APP_ORIGIN: BASE,
      ENABLE_EXTERNAL_APIS: 'false',
      SEED_DEMO_DATA: 'false',
    },
  })
  const spa = spaRoot()
  built.app.use('*', serveStatic({ root: spa.root }))
  built.app.get('*', serveStatic({ path: spa.index }))
  const server = serve({ fetch: built.app.fetch, port: PORT, hostname: '127.0.0.1' })
  await new Promise((r) => setTimeout(r, 500))

  const { page, close } = await Page.open({ width: 1440, height: 950 })
  try {
    await page.goto(`${BASE}/login`)
    const id = await page.evaluate<string>(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      await fetch('/api/auth/login', { method: 'POST', headers: h,
        body: JSON.stringify({ email: 'neg@signalmess.test', name: 'Neg' }) });
      const res = await fetch('/api/investigations', { method: 'POST', headers: h,
        body: JSON.stringify({ title: 'Checagem negativa de cursor', description: 'Negativa',
          objective: 'Garantir que elementos informativos não recebam cursor de ponteiro.',
          topic: 'cursor', keywords: ['cursor'], status: 'active' }) });
      const payload = await res.json();
      return payload.data.id;
    })()`)

    const routes = [
      '/', '/login', '/dashboard', '/investigations', '/investigations/new',
      `/investigations/${id}`, `/investigations/${id}/research`,
      `/investigations/${id}/evidence`, `/investigations/${id}/analysis`,
      `/investigations/${id}/validation`, '/history', '/settings', '/rota-inexistente',
    ]

    const all: Array<Record<string, unknown>> = []
    for (const vp of [
      { label: 'desktop', w: 1440, h: 950 },
      { label: 'mobile', w: 390, h: 844 },
    ]) {
      await page.setViewport(vp.w, vp.h)
      for (const route of routes) {
        await page.goto(`${BASE}${route}`)
        await new Promise((r) => setTimeout(r, 340))
        const bad = await page.evaluate<Array<Record<string, unknown>>>(CHECK)
        for (const b of bad) all.push({ route, viewport: vp.label, ...b })
      }
    }

    console.log('\n=== NEGATIVE CHECKS (pointer must NOT be here) ===')
    if (all.length === 0) {
      console.log('  none — no informational, text-entry, disabled or decorative element is a hand')
    } else {
      const byKind = new Map<string, Array<Record<string, unknown>>>()
      for (const b of all) {
        const k = String(b['kind'])
        const list = byKind.get(k) ?? []
        list.push(b)
        byKind.set(k, list)
      }
      for (const [kind, list] of byKind) {
        console.log(`\n  ${kind}: ${list.length}`)
        const seen = new Set<string>()
        for (const b of list) {
          const sig = String(b['tag']) + String(b['cls'] ?? '') + String(b['text'] ?? '')
          if (seen.has(sig)) continue
          seen.add(sig)
          console.log(`    ${String(b['viewport']).padEnd(8)} ${String(b['route']).padEnd(40)} ${String(b['tag'])} "${String(b['text'] ?? b['cls'] ?? '').slice(0, 34)}"${b['cursor'] ? ` cursor=${b['cursor']}` : ''}`)
          if (seen.size >= 5) break
        }
      }
    }
    console.log(`\ntotal: ${all.length}`)
  } finally {
    await close()
    server.close()
    built.close()
  }
}

await main()
