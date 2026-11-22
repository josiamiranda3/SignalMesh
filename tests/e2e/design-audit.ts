/**
 * Design audit.
 *
 * Runs against the real DOM in a real browser and measures the things a human
 * reviewer would otherwise check by eye:
 *
 *   - text contrast (WCAG AA) for every visible text node against its
 *     composited background
 *   - typographic hierarchy (font-size distribution, heading order)
 *   - spacing consistency (page gutters, card padding, vertical rhythm)
 *   - horizontal overflow and clipped text
 *   - interactive target sizes
 *   - button/link affordances (no dead-looking controls)
 *
 * Output is machine-readable JSON plus a readable report, so design regressions
 * are caught by the test suite rather than by a screenshot nobody opened.
 *
 *   node --experimental-transform-types tests/e2e/design-audit.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { spaRoot } from './dist-root.ts'
import { Page } from './cdp.ts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ARTIFACTS = join(process.cwd(), 'tests', 'e2e', 'artifacts')
const PORT = 8801
const BASE = `http://127.0.0.1:${PORT}`

interface RouteSpec {
  name: string
  path: string
  anchor: string
}

export interface RouteAudit {
  route: string
  viewport: string
  contrastFailures: Array<{ text: string; ratio: number; fg: string; bg: string; size: number }>
  headingOrder: string[]
  fontSizes: number[]
  overflow: string[]
  clipped: string[]
  smallTargets: string[]
  gutters: number[]
  cardPaddings: number[]
  runtimeErrors: string[]
  consoleErrors: string[]
  firstPaintMs: number
}

const ROUTES: RouteSpec[] = [
  { name: 'landing', path: '/', anchor: 'informação dispersa' },
  { name: 'login', path: '/login', anchor: 'entrar no signalmesh' },
  { name: 'dashboard', path: '/dashboard', anchor: 'visão geral' },
  { name: 'investigations', path: '/investigations', anchor: 'investigações' },
  { name: 'new-investigation', path: '/investigations/new', anchor: 'defina o que você quer descobrir' },
  { name: 'detail', path: '/investigations/ID', anchor: 'objetivo da pesquisa' },
  { name: 'research', path: '/investigations/ID/research', anchor: 'buscar fontes na web' },
  { name: 'evidence', path: '/investigations/ID/evidence', anchor: 'fontes coletadas' },
  { name: 'analysis', path: '/investigations/ID/analysis', anchor: 'síntese das evidências' },
  { name: 'validation', path: '/investigations/ID/validation', anchor: 'decidir sobre as evidências' },
  { name: 'history', path: '/history', anchor: 'trilha completa de eventos' },
  { name: 'settings', path: '/settings', anchor: 'provedores externos' },
  { name: 'not-found', path: '/rota-inexistente', anchor: 'esta rota não existe' },
]

const AUDIT_SCRIPT = `
(() => {
  const parseColor = (value) => {
    const m = value.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((part) => parseFloat(part.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  const composite = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });

  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const contrast = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const effectiveBackground = (el) => {
    const stack = [];
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const parsed = parseColor(style.backgroundColor);
      if (parsed && parsed.a > 0.02) {
        stack.push(parsed);
        if (parsed.a >= 0.995) break;
      }
    }
    let base = { r: 7, g: 9, b: 15, a: 1 };
    for (let i = stack.length - 1; i >= 0; i -= 1) base = composite(stack[i], base);
    return base;
  };

  const isVisible = (el) => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) < 0.15) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const textNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = (node.textContent || '').trim();
    if (text.length < 2) continue;
    const parent = node.parentElement;
    if (!parent || !isVisible(parent)) continue;
    if (parent.closest('svg')) continue;
    const style = getComputedStyle(parent);
    if (style.webkitTextFillColor === 'transparent' || style.color === 'rgba(0, 0, 0, 0)') continue;
    textNodes.push({ el: parent, text });
  }

  const contrastFailures = [];
  const seen = new Set();
  for (const { el, text } of textNodes) {
    const style = getComputedStyle(el);
    const fg = parseColor(style.color);
    if (!fg) continue;
    const bg = effectiveBackground(el);
    const composited = composite(fg, bg);
    const ratio = contrast(composited, bg);
    const size = parseFloat(style.fontSize);
    const weight = parseInt(style.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? 3 : 4.5;
    if (ratio + 0.01 < required) {
      const key = style.color + '|' + size + '|' + text.slice(0, 12);
      if (seen.has(key)) continue;
      seen.add(key);
      contrastFailures.push({
        text: text.slice(0, 70),
        ratio: Math.round(ratio * 100) / 100,
        fg: style.color,
        bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
        size,
      });
      if (contrastFailures.length > 12) break;
    }
  }

  const headingOrder = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .filter(isVisible)
    .map((el) => el.tagName.toLowerCase() + ':' + (el.textContent || '').trim().slice(0, 40));

  const fontSizes = [...new Set(
    [...document.querySelectorAll('h1,h2,h3,p,span,td,th,button,a,label')]
      .filter(isVisible)
      .map((el) => Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10)
  )].sort((a, b) => a - b);

  const docWidth = document.documentElement.clientWidth;
  const overflow = [];
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.right <= docWidth + 1.5) continue;
    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.visibility === 'hidden') continue;
    if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
    let inScroller = false;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden') { inScroller = true; break; }
    }
    if (inScroller) continue;
    overflow.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 60) + ' right=' + Math.round(rect.right));
    if (overflow.length > 6) break;
  }

  const clipped = [];
  for (const el of document.querySelectorAll('h1,h2,h3,p,span,td,th,button,a,label')) {
    if (el.children.length > 0) continue;
    const style = getComputedStyle(el);
    if (style.overflow !== 'visible') continue;
    if (style.textOverflow === 'ellipsis') continue;
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      clipped.push((el.textContent || '').trim().slice(0, 50));
      if (clipped.length > 6) break;
    }
  }

  const smallTargets = [];
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"]')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (!isVisible(el)) continue;
    if (el.closest('p, li, span')) continue;
    const style = getComputedStyle(el);
    if (style.display === 'inline' || style.display === 'contents') continue;
    // Inline text links are judged by their surrounding text, not their box.
    if (el.tagName === 'A' && style.display === 'inline') continue;
    const label = el.closest('label');
    if (label) {
      const lr = label.getBoundingClientRect();
      if (lr.height >= 32) continue;
    }
    if (rect.height >= 32 && rect.width >= 32) continue;
    smallTargets.push(((el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 36)) + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height));
    if (smallTargets.length > 8) break;
  }

  const main = document.querySelector('main') || document.body;
  const mainRect = main.getBoundingClientRect();
  const gutters = [];
  for (const child of [...main.querySelectorAll(':scope > div > *')].slice(0, 3)) {
    const rect = child.getBoundingClientRect();
    if (rect.width > 0) gutters.push(Math.round(rect.left - mainRect.left));
  }

  const cardPaddings = [...new Set(
    [...document.querySelectorAll('.panel')]
      .filter(isVisible)
      .slice(0, 12)
      .map((el) => getComputedStyle(el).paddingTop)
  )];

  return { contrastFailures, headingOrder, fontSizes, overflow, clipped, smallTargets, gutters, cardPaddings };
})()
`

async function main(): Promise<void> {
  rmSync(ARTIFACTS, { recursive: true, force: true })
  mkdirSync(ARTIFACTS, { recursive: true })

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
  await new Promise((resolve) => setTimeout(resolve, 500))

  const { page, close } = await Page.open({ width: 1440, height: 950 })
  const audits: RouteAudit[] = []

  try {
    const investigationId = await seed(page)

    for (const viewport of [
      { label: 'desktop', width: 1440, height: 950 },
      { label: 'tablet', width: 834, height: 1000 },
      { label: 'mobile', width: 390, height: 844 },
    ]) {
      await page.setViewport(viewport.width, viewport.height)

      for (const route of ROUTES) {
        const target = route.path.replace('ID', investigationId)
        const beforeErrors = page.pageErrors.length
        const beforeConsole = page.consoleMessages.length
        const started = Date.now()

        await page.goto(`${BASE}${target}`)
        try {
          await page.waitForText(route.anchor, 9000)
        } catch {
          console.log(`  ! âncora ausente em ${target}: "${route.anchor}"`)
        }
        const firstPaintMs = Date.now() - started
        await new Promise((resolve) => setTimeout(resolve, 420))

        const raw = await page.evaluate<{
          contrastFailures: RouteAudit['contrastFailures']
          headingOrder: string[]
          fontSizes: number[]
          overflow: string[]
          clipped: string[]
          smallTargets: string[]
          gutters: number[]
          cardPaddings: string[]
        }>(AUDIT_SCRIPT)

        audits.push({
          route: target,
          viewport: viewport.label,
          contrastFailures: raw.contrastFailures,
          headingOrder: raw.headingOrder,
          fontSizes: raw.fontSizes,
          overflow: raw.overflow,
          clipped: raw.clipped,
          smallTargets: raw.smallTargets,
          gutters: raw.gutters,
          cardPaddings: raw.cardPaddings.map((value) => parseFloat(value)),
          runtimeErrors: page.pageErrors.slice(beforeErrors),
          consoleErrors: page.consoleMessages
            .slice(beforeConsole)
            .filter((message) => message.type === 'error')
            .map((message) => message.text.slice(0, 240)),
          firstPaintMs,
        })

        if (viewport.label === 'desktop') {
          await page.screenshot(join(ARTIFACTS, `${route.name}-desktop.png`), { fullPage: true })
        } else if (viewport.label === 'mobile') {
          await page.screenshot(join(ARTIFACTS, `${route.name}-mobile.png`))
        }
      }
    }
  } finally {
    await close()
    server.close()
    built.close()
  }

  writeFileSync(join(ARTIFACTS, 'design-audit.json'), JSON.stringify(audits, null, 2))
  report(audits)
}

function report(audits: RouteAudit[]): void {
  let problems = 0

  for (const viewport of ['desktop', 'tablet', 'mobile']) {
    const view = audits.filter((audit) => audit.viewport === viewport)
    if (view.length === 0) continue
    console.log(`\n=== ${viewport.toUpperCase()} ===`)

    for (const audit of view) {
      const issues: string[] = []
      if (audit.runtimeErrors.length) issues.push(`${audit.runtimeErrors.length} erro(s) de runtime`)
      if (audit.consoleErrors.length) issues.push(`${audit.consoleErrors.length} erro(s) de console`)
      if (audit.overflow.length) issues.push(`overflow: ${audit.overflow[0]}`)
      if (audit.clipped.length) issues.push(`texto cortado: ${audit.clipped.join(' | ')}`)
      if (audit.contrastFailures.length) {
        const worst = [...audit.contrastFailures].sort((a, b) => a.ratio - b.ratio)[0]!
        issues.push(
          `${audit.contrastFailures.length} contraste(s) < AA (pior ${worst.ratio}: "${worst.text.slice(0, 34)}" ${worst.fg} sobre ${worst.bg})`,
        )
      }
      if (audit.smallTargets.length) issues.push(`alvos pequenos: ${audit.smallTargets.slice(0, 3).join(', ')}`)

      problems += issues.length
      const status = issues.length === 0 ? 'ok  ' : 'FAIL'
      console.log(
        `  [${status}] ${audit.route.padEnd(38)} ${String(audit.firstPaintMs).padStart(4)}ms  ` +
          `títulos ${audit.headingOrder.length} · tamanhos ${audit.fontSizes.length} · gutters ${audit.gutters.join('/') || '-'}`,
      )
      for (const issue of issues) console.log(`         · ${issue}`)
    }
  }

  const sizes = new Map<number, number>()
  for (const audit of audits.filter((item) => item.viewport === 'desktop')) {
    for (const size of audit.fontSizes) sizes.set(size, (sizes.get(size) ?? 0) + 1)
  }
  console.log(
    '\nEscala tipográfica (desktop): ' +
      [...sizes.keys()].sort((a, b) => a - b).map((size) => `${size}px`).join(' · '),
  )

  const paddings = new Set<number>()
  for (const audit of audits) for (const value of audit.cardPaddings) paddings.add(value)
  console.log(`Paddings de card observados: ${[...paddings].sort((a, b) => a - b).join(', ') || '—'}px`)
  console.log(`\n${problems === 0 ? 'Nenhum problema de design detectado.' : `${problems} problema(s) de design.`}`)
}

async function seed(page: Page): Promise<string> {
  await page.goto(`${BASE}/login`)
  return page.evaluate<string>(`
    (async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      const login = await fetch('/api/auth/login', {
        method: 'POST', headers: h,
        body: JSON.stringify({ email: 'audit@signalmess.test', name: 'Auditoria de Design' }),
      });
      if (!login.ok) throw new Error('login falhou: ' + login.status);
      const created = await fetch('/api/investigations', {
        method: 'POST', headers: h,
        body: JSON.stringify({
          title: 'Detecção de fraudes financeiras com aprendizado de máquina',
          description: 'Investigação sobre sistemas antifraude em operação no setor bancário brasileiro, com foco em resultados publicados e limitações metodológicas.',
          objective: 'Identificar aplicações reais de inteligência artificial na detecção de fraudes financeiras no Brasil, as instituições envolvidas, as tecnologias empregadas e os resultados publicados entre 2022 e 2025.',
          topic: 'inteligência artificial aplicada à detecção de fraudes financeiras no Brasil',
          keywords: ['fraude financeira', 'machine learning', 'antifraude', 'regulação'],
          status: 'active',
        }),
      });
      const payload = await created.json();
      const id = payload.data.id;

      const sources = [
        {
          title: 'Modelos de aprendizado supervisionado na detecção de fraude em cartões',
          url: 'https://example.org/estudos/fraude-cartoes-aprendizado-supervisionado',
          domain: 'example.org',
          snippet: 'Estudo compara gradient boosting e redes neurais em bases de transações anonimizadas, reportando redução de falsos positivos.',
          retrievedContent: 'Resumo metodológico. O estudo descreve a construção de atributos temporais e a validação cruzada temporal usada para evitar vazamento de dados.',
          publishedAt: '2024-08-12T00:00:00.000Z',
          author: 'Grupo de Pesquisa Aplicada',
          contentAvailability: ['text', 'highlights'],
        },
        {
          title: 'Requisitos regulatórios de explicabilidade em decisões automatizadas de crédito',
          url: 'https://example.org/regulacao/explicabilidade-credito',
          domain: 'example.org',
          snippet: 'Documento discute exigências de transparência para modelos usados em decisões de crédito e cobrança.',
          retrievedContent: null,
          publishedAt: '2023-11-03T00:00:00.000Z',
          author: null,
          contentAvailability: ['snippet'],
        },
        {
          title: 'Panorama de fraudes digitais no sistema financeiro',
          url: 'https://example.org/panoramas/fraudes-digitais',
          domain: 'example.org',
          snippet: 'Levantamento de incidentes reportados e vetores de ataque predominantes em canais digitais.',
          retrievedContent: null,
          publishedAt: null,
          author: 'Equipe Editorial',
          contentAvailability: ['snippet'],
        },
      ];

      for (const source of sources) {
        await fetch('/api/investigations/' + id + '/evidence', {
          method: 'POST', headers: h,
          body: JSON.stringify({ source, allowDuplicate: false }),
        });
      }

      const evidence = await (await fetch('/api/investigations/' + id + '/evidence')).json();
      const first = evidence.data[0];
      await fetch('/api/evidence/' + first.id + '/validation', {
        method: 'POST', headers: h,
        body: JSON.stringify({ status: 'accepted', justification: 'Metodologia descrita e dados primários citados.' }),
      });
      return id;
    })()
  `)
}

main().catch((error: unknown) => {
  console.error('auditoria falhou:', error)
  process.exit(1)
})
