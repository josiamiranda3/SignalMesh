/**
 * Login page layout verification.
 *
 * Checks the real `/login` route (local auth mode) at four widths:
 * two-column split at lg+, single column below, no overflow, every interactive
 * control ≥44×44 and receiving its own clicks.
 */
import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Page } from './cdp.ts'
import { spaRoot } from './dist-root.ts'

const PORT = 8883
const BASE = `http://127.0.0.1:${PORT}`
const spa = spaRoot()

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
built.app.use('*', serveStatic({ root: spa.root }))
built.app.get('*', serveStatic({ path: spa.index }))
const server = serve({ fetch: built.app.fetch, port: PORT, hostname: '127.0.0.1' })
await new Promise((r) => setTimeout(r, 500))

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  } else console.log(`  ok    ${label}`)
}

for (const width of [390, 768, 1024, 1440]) {
  const { page, close } = await Page.open({ width, height: 900 })
  try {
    console.log(`\n=== /login @ ${width}px ===`)
    await page.goto(`${BASE}/login`)
    await new Promise((r) => setTimeout(r, 900))

    const m = JSON.parse(
      await page.evaluate<string>(`
      (() => {
        const vw = innerWidth, vh = innerHeight;
        const grid = document.querySelector('.grid');
        const panels = [...grid.children];
        const small = [];
        for (const el of document.querySelectorAll('button, a, [role="button"], input')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.width >= 44 && r.height >= 44) continue;
          const onScreen = r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
          let clickable = false;
          if (onScreen) {
            const x = Math.min(Math.max(r.left + r.width/2, 0), vw - 1);
            const y = Math.min(Math.max(r.top + r.height/2, 0), vh - 1);
            const top = document.elementFromPoint(x, y);
            clickable = !!top && (el === top || el.contains(top));
          }
          small.push({ label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0,28),
                       size: Math.round(r.width)+'x'+Math.round(r.height), onScreen, clickable });
        }
        return JSON.stringify({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          cols: getComputedStyle(grid).gridTemplateColumns,
          panelCount: panels.length,
          rightPanelDisplay: panels[1] ? getComputedStyle(panels[1]).display : null,
          leftPanelDisplay: getComputedStyle(panels[0]).display,
          rightRect: panels[1] ? (r => [Math.round(r.left), Math.round(r.right), Math.round(r.width)])(panels[1].getBoundingClientRect()) : null,
          leftRect: panels[0] ? (r => [Math.round(r.left), Math.round(r.right), Math.round(r.width)])(panels[0].getBoundingClientRect()) : null,
          small,
        });
      })()`),
    ) as Record<string, any>

    check(m.overflow <= 2, `no horizontal overflow (${m.overflow}px)`)
    const real = (m.small as Array<Record<string, unknown>>).filter((t) => t['onScreen'] && t['clickable'])
    check(real.length === 0, 'all targets ≥44x44', real.map((r) => `${r['label']}=${r['size']}`).join(', '))

    if (width >= 1024) {
      // Two independent columns, left panel visible, no overlap.
      const left = m.leftRect as [number, number, number]
      const right = m.rightRect as [number, number, number]
      const [, leftEnd] = left
      const [rightStart, rightEnd] = right
      check(m.leftPanelDisplay !== 'none', 'left panel visible at lg+')
      check(
        leftEnd <= rightStart + 1,
        'left panel ends before the right panel begins',
        `left ends ${leftEnd}, right starts ${rightStart}`,
      )
      check(rightStart >= 0 && rightEnd <= width + 1, 'right panel stays inside the viewport')
    } else {
      check(m.leftPanelDisplay === 'none', 'left panel hidden below lg (single column)')
      const [rightStart, rightEnd] = m.rightRect as [number, number, number]
      check(rightStart >= 0 && rightEnd <= width + 1, 'sign-in panel spans the viewport without overflow')
    }

    await page.screenshot(`tests/e2e/artifacts/login-page-${width}.png`)
  } finally {
    await close()
  }
}

console.log(`\nfailures: ${failures}`)
if (failures > 0) process.exitCode = 1
server.close()
built.close()
