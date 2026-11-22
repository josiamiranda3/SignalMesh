/**
 * Status badge contrast, measured against the *real* rendered background.
 *
 * The first pass under-measured because the panel background is an `oklab()`
 * colour with alpha, which the naive `rgba()` parser skipped — every badge was
 * compared against the bare canvas instead of the panel it sits on. This version
 * reads the effective background with a canvas sample instead of parsing CSS
 * colours, so the ratio is the one a user actually perceives.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-status-contrast.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { spaRoot } from './dist-root.ts'
import { Page } from './cdp.ts'

const PORT = 8843
const BASE = `http://127.0.0.1:${PORT}`

/**
 * Sample the pixel just inside the badge's edge (over its own background) and
 * the text colour from the computed style, then compute the ratio in-page.
 */
const MEASURE = `
(() => {
  const LABELS = ['Rascunho', 'Em andamento', 'Concluída', 'Arquivada'];
  const ch = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const hex = (c) => '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const parseRgb = (v) => { const m = v.match(/(\\d+(?:\\.\\d+)?)\\D+(\\d+(?:\\.\\d+)?)\\D+(\\d+(?:\\.\\d+)?)/); return m ? { r: +m[1], g: +m[2], b: +m[3] } : null; };

  // Resolve an oklab()/rgba() background to sRGB by painting it on a 1x1 canvas.
  const probe = document.createElement('canvas');
  probe.width = 1; probe.height = 1;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  const resolve = (cssColor, backdrop) => {
    if (!cssColor || cssColor === 'rgba(0, 0, 0, 0)' || cssColor === 'transparent') return null;
    ctx.clearRect(0, 0, 1, 1);
    if (backdrop) { ctx.fillStyle = 'rgb(' + backdrop.r + ',' + backdrop.g + ',' + backdrop.b + ')'; ctx.fillRect(0, 0, 1, 1); }
    ctx.fillStyle = cssColor;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  };

  const out = [];
  for (const el of document.querySelectorAll('span')) {
    const text = (el.textContent || '').trim();
    if (!LABELS.includes(text)) continue;
    const cs = getComputedStyle(el);
    if (cs.borderTopWidth === '0px' || cs.borderRadius === '0px') continue;
    if (el.getBoundingClientRect().width < 10) continue;

    // Walk up compositing every background layer that is not fully transparent.
    const layers = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)') layers.push(bg);
    }
    let base = { r: 9, g: 11, b: 14 };
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const painted = resolve(layers[i], base);
      if (painted) base = painted;
    }

    const fg = parseRgb(cs.color);
    const dotEl = el.querySelector('span');
    const dot = dotEl ? parseRgb(getComputedStyle(dotEl).backgroundColor) : null;

    out.push({
      label: text,
      badgeBg: hex(base),
      textColor: hex(fg),
      textContrast: Math.round(ratio(fg, base) * 100) / 100,
      dotColor: dot ? hex(dot) : null,
      dotContrast: dot ? Math.round(ratio(dot, base) * 100) / 100 : null,
      layers: layers.length,
    });
  }
  return out;
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
    const ids = await page.evaluate<Record<string, string>>(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      await fetch('/api/auth/login', { method: 'POST', headers: h,
        body: JSON.stringify({ email: 'contrast@signalmess.test', name: 'Contrast' }) });
      const out = {};
      for (const st of ['draft','active','completed','archived']) {
        const res = await fetch('/api/investigations', { method: 'POST', headers: h,
          body: JSON.stringify({ title: 'Contraste ' + st,
            description: 'Badge sobre painel para medir contraste real.',
            objective: 'Medir o contraste real do badge de status sobre o painel.',
            topic: 'status', keywords: ['s'], status: st }) });
        const p = await res.json(); out[st] = p.data.id;
      }
      return out;
    })()`)

    // Dashboard puts the badges inside a `.panel` (the worst case).
    await page.goto(`${BASE}/dashboard`)
    await new Promise((r) => setTimeout(r, 900))
    const rows = await page.evaluate<Array<Record<string, unknown>>>(MEASURE)

    console.log('=== STATUS BADGE CONTRAST (measured over the panel) ===')
    const seen = new Set<string>()
    let fails = 0
    for (const r of rows) {
      const label = String(r['label'])
      if (seen.has(label)) continue
      seen.add(label)
      const textOk = Number(r['textContrast']) >= 4.5
      const dotOk = r['dotContrast'] === null || Number(r['dotContrast']) >= 3
      if (!textOk || !dotOk) fails += 1
      console.log(
        `  ${label.padEnd(14)} bg=${r['badgeBg']} text=${r['textColor']} ${String(r['textContrast'])}:1 ${textOk ? 'AA' : 'FAIL'}` +
          `   dot=${r['dotColor']} ${String(r['dotContrast'])}:1 ${dotOk ? 'OK' : 'FAIL'}`,
      )
    }
    console.log(`\nstatuses measured: ${seen.size}, failures: ${fails}`)

    // Detail page, to confirm the same values there.
    console.log('\n=== DETAIL PAGE (spot check) ===')
    for (const st of ['draft', 'active', 'completed', 'archived']) {
      await page.goto(`${BASE}/investigations/${ids[st]}`)
      await new Promise((r) => setTimeout(r, 480))
      const d = await page.evaluate<Array<Record<string, unknown>>>(MEASURE)
      const row = d.find((x) => String(x['label']) === labelOf(st))
      console.log(
        `  ${st.padEnd(10)} ${row ? `${row['textColor']} on ${row['badgeBg']} = ${row['textContrast']}:1` : 'badge not found'}`,
      )
    }
  } finally {
    await close()
    server.close()
    built.close()
  }
}

function labelOf(status: string): string {
  return { draft: 'Rascunho', active: 'Em andamento', completed: 'Concluída', archived: 'Arquivada' }[status] as string
}

await main()
