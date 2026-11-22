/**
 * Visual verification: the DeepSpace AuthOverlay inside the login shell.
 *
 * ## Why a harness
 *
 * The real overlay renders only when `authMode === 'deepspace'`, which the
 * runtime derives (`worker` → deepspace, `node` → local). The Node dev server
 * cannot produce it, and auth logic must not be edited to fake it.
 *
 * So the overlay's **exact markup and class names** are injected into the live
 * page (copied from `node_modules/deepspace/dist/index.js`: `AuthOverlay`,
 * `OAuthButton`, `Divider`). It renders against the real compiled stylesheet, so
 * any class the build failed to emit shows up exactly as it does in production.
 *
 * The classes are built from string fragments at runtime, deliberately: the
 * source of this file must not contain them literally, or Tailwind's scanner
 * would emit them and the test would pass on its own pollution. That mistake was
 * made and caught during the investigation.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-auth-overlay.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Page } from './cdp.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 8881
const BASE = `http://127.0.0.1:${PORT}`
const ARTIFACTS = join(process.cwd(), 'tests/e2e/artifacts')

/**
 * Build the SDK's overlay markup from fragments.
 *
 * Every class list is joined at runtime so the literal Tailwind strings never
 * appear in this file. `bg` + `-card` yields `bg-card` in the DOM while keeping
 * the token out of the scanner's view.
 */
function overlayMarkup(): string {
  const cls = {
    backdrop: ['fixed', 'inset-0', 'z-[99999]', 'flex', 'items-center', 'justify-center', 'backdrop-blur-2xl'].join(' '),
    card: ['relative', 'mx-6', 'w-full', 'max-w-[380px]', 'rounded-2xl', 'border', 'border-border', 'bg-card', 'p-8', 'text-center', 'shadow-card-hover'].join(' '),
    close: ['absolute', 'right-3', 'top-3', 'inline-flex', 'h-7', 'w-7', 'items-center', 'justify-center', 'rounded-full', 'bg-secondary', 'text-muted-foreground'].join(' '),
    title: ['mb-2', 'text-[22px]', 'font-bold', 'leading-snug', 'text-foreground'].join(' '),
    subtitle: ['mb-6', 'text-sm', 'leading-snug', 'text-muted-foreground'].join(' '),
    stack: ['flex', 'flex-col', 'gap-2'].join(' '),
    oauth: ['flex', 'w-full', 'items-center', 'justify-center', 'gap-2.5', 'rounded-lg', 'border', 'border-border', 'bg-secondary', 'px-4', 'py-2.5', 'text-sm', 'font-semibold', 'text-foreground'].join(' '),
    divider: ['my-5', 'flex', 'items-center', 'gap-3', 'text-xs', 'text-muted-foreground'].join(' '),
    dividerLine: ['h-px', 'flex-1', 'bg-border'].join(' '),
    email: ['flex', 'w-full', 'items-center', 'justify-center', 'gap-2.5', 'rounded-lg', 'border', 'border-border', 'bg-transparent', 'px-4', 'py-2.5', 'text-sm', 'font-semibold', 'text-muted-foreground'].join(' '),
  }
  const icon = '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="7"/></svg>'

  return [
    `<div data-testid="auth-overlay" class="${cls.backdrop}">`,
    `  <div class="${cls.card}">`,
    `    <button data-testid="auth-overlay-close" aria-label="Close" class="${cls.close}">&#10005;</button>`,
    `    <h2 class="${cls.title}">Sign in to SignalMesh</h2>`,
    `    <p class="${cls.subtitle}">Sync your data across devices</p>`,
    `    <div class="${cls.stack}">`,
    `      <button type="button" data-testid="oauth-github" class="${cls.oauth}">${icon}Continue with GitHub</button>`,
    `      <button type="button" data-testid="oauth-google" class="${cls.oauth}">${icon}Continue with Google</button>`,
    `    </div>`,
    `    <div class="${cls.divider}"><div class="${cls.dividerLine}"></div>or<div class="${cls.dividerLine}"></div></div>`,
    `    <button type="button" data-testid="auth-email-toggle" class="${cls.email}">Sign in with email</button>`,
    `  </div>`,
    `</div>`,
  ].join('\n')
}

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
built.app.use('*', serveStatic({ root: './dist/client' }))
built.app.get('*', serveStatic({ path: './dist/client/index.html' }))
const server = serve({ fetch: built.app.fetch, port: PORT, hostname: '127.0.0.1' })
await new Promise((r) => setTimeout(r, 500))

mkdirSync(ARTIFACTS, { recursive: true })
const report: Array<Record<string, unknown>> = []
let failures = 0

function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

for (const width of [390, 768, 1024, 1440]) {
  const height = width < 768 ? 844 : 900
  const { page, close } = await Page.open({ width, height })
  try {
    console.log(`\n=== ${width}x${height} ===`)
    await page.goto(`${BASE}/login`)
    await new Promise((r) => setTimeout(r, 900))
    await page.evaluate(`(() => {
      window.localStorage.setItem('signalmess.locale','en');
      const host = document.createElement('div');
      host.id = 'overlay-harness';
      host.innerHTML = ${JSON.stringify(overlayMarkup())};
      document.body.appendChild(host);
    })()`)
    await new Promise((r) => setTimeout(r, 700))

    const metrics = await page.evaluate<string>(`
      (() => {
        const card = document.querySelector('#overlay-harness [data-testid="auth-overlay"] > div');
        const buttons = [...document.querySelectorAll('#overlay-harness button[data-testid^="oauth-"], #overlay-harness [data-testid="auth-email-toggle"]')];
        const cs = (el, p) => getComputedStyle(el).getPropertyValue(p);
        const r = card.getBoundingClientRect();
        const circles = [...document.querySelectorAll('#overlay-harness svg')].map(s => {
          const sr = s.getBoundingClientRect();
          return { top: Math.round(sr.top), bottom: Math.round(sr.bottom), left: Math.round(sr.left), right: Math.round(sr.right) };
        });
        const btns = buttons.map(b => {
          const br = b.getBoundingClientRect();
          return {
            label: b.textContent.trim().slice(0, 24),
            top: Math.round(br.top), bottom: Math.round(br.bottom),
            left: Math.round(br.left), right: Math.round(br.right),
            width: Math.round(br.width), height: Math.round(br.height),
            bg: cs(b, 'background-color'),
            borderColor: cs(b, 'border-top-color'),
            color: cs(b, 'color'),
          };
        });
        // Any pair of buttons overlapping vertically or horizontally?
        let overlaps = 0;
        for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) {
          const a = btns[i], b = btns[j];
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 1 && oy > 1) overlaps++;
        }
        return JSON.stringify({
          viewport: innerWidth,
          cardWidth: Math.round(r.width),
          cardLeft: Math.round(r.left),
          cardRight: Math.round(r.right),
          cardBg: cs(card, 'background-color'),
          cardBorder: cs(card, 'border-top-color'),
          cardPadding: cs(card, 'padding'),
          cardMaxWidth: cs(card, 'max-width'),
          cardRadius: cs(card, 'border-radius'),
          buttons: btns,
          overlaps,
          // Does the card stay inside the viewport?
          withinViewport: r.left >= 0 && r.right <= innerWidth + 0.5,
          // Are the two columns still separate? (login shell divider intact)
          dividerVisible: !!document.querySelector('.lg\\\\:grid-cols-\\\\[1\\\\.05fr_1fr\\\\]'),
        });
      })()`)

    const m = JSON.parse(metrics) as Record<string, any>
    report.push({ width, ...m })

    // --- assertions -----------------------------------------------------
    check(m.cardWidth <= 380, `card is ≤380px wide (got ${m.cardWidth})`)
    check(m.cardMaxWidth === '380px', `max-width applied (got ${m.cardMaxWidth})`)
    check(m.cardPadding !== '0px', `card has padding (got ${m.cardPadding})`)
    check(m.cardBg !== 'rgba(0, 0, 0, 0)', `card has a background (${m.cardBg})`)
    check(m.cardBorder !== 'rgb(236, 240, 246)', `border is themed, not white (${m.cardBorder})`)
    check(m.withinViewport === true, 'card stays inside the viewport')
    check(m.overlaps === 0, `no button overlaps (${m.overlaps})`)
    check(m.buttons.length === 3, `three auth buttons (${m.buttons.length})`)

    // Buttons must be inside the card horizontally.
    for (const b of m.buttons) {
      check(
        b.left >= m.cardLeft && b.right <= m.cardRight + 1,
        `"${b.label}" stays inside the card`,
        `button ${b.left}..${b.right} vs card ${m.cardLeft}..${m.cardRight}`,
      )
    }
    // No horizontal rule crossing a button: the divider lines sit between buttons.
    const sorted = [...m.buttons].sort((a, b) => a.top - b.top)
    let crossing = 0
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].bottom > sorted[i + 1].top + 1) crossing += 1
    }
    check(crossing === 0, 'no button is crossed by another element')
    // Each button has an independent hit area (distinct vertical bands).
    const distinct = new Set(sorted.map((b) => `${b.top}-${b.bottom}`))
    check(distinct.size === sorted.length, 'each auth button has its own vertical band')

    // --- clickability: hit-test the centre of every auth button -------------
    // A control can be visible and still unusable if something transparent sits
    // on top of it. `elementFromPoint` answers "what would receive this click?".
    const hits = await page.evaluate<string>(`
      (() => {
        const out = [];
        for (const b of document.querySelectorAll('#overlay-harness button[data-testid]')) {
          const r = b.getBoundingClientRect();
          const x = Math.round(r.left + r.width / 2);
          const y = Math.round(r.top + r.height / 2);
          const top = document.elementFromPoint(x, y);
          out.push({
            id: b.getAttribute('data-testid'),
            receives: !!top && (b === top || b.contains(top)),
            blockedBy: top && !(b === top || b.contains(top))
              ? (top.getAttribute('data-testid') || top.tagName + '.' + (top.className || '').toString().slice(0, 30))
              : null,
          });
        }
        return JSON.stringify(out);
      })()`)
    for (const h of JSON.parse(hits) as Array<Record<string, unknown>>) {
      check(
        h['receives'] === true,
        `${h['id']} receives its own clicks`,
        h['blockedBy'] ? `blocked by ${h['blockedBy']}` : '',
      )
    }

    // --- page-level: the login shell itself must not overflow ---------------
    const shell = await page.evaluate<string>(`
      (() => {
        const doc = document.documentElement;
        const grid = document.querySelector('main, .grid');
        return JSON.stringify({
          horizontalOverflow: doc.scrollWidth - doc.clientWidth,
          verticalOverflow: doc.scrollHeight - doc.clientHeight,
          bodyBg: getComputedStyle(document.body).backgroundColor,
        });
      })()`)
    const s = JSON.parse(shell) as Record<string, any>
    check(s.horizontalOverflow <= 2, `no horizontal overflow with the overlay (${s.horizontalOverflow}px)`)

    // Screenshot for the record.
    await page.screenshot(join(ARTIFACTS, `login-overlay-${width}.png`))
  } finally {
    await close()
  }
}

writeFileSync(join(ARTIFACTS, 'auth-overlay-report.json'), JSON.stringify(report, null, 2))

console.log('\n=== summary ===')
for (const r of report as Array<Record<string, any>>) {
  console.log(
    `${String(r.width).padStart(4)}px  card=${r.cardWidth}px  maxw=${r.cardMaxWidth}  pad=${r.cardPadding}  ` +
      `overlaps=${r.overlaps}  within=${r.withinViewport}`,
  )
}
console.log(`\nfailures: ${failures}`)
if (failures > 0) process.exitCode = 1

server.close()
built.close()
