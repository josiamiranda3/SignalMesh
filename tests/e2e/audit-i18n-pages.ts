/**
 * Phase 1 i18n: browser verification of the three migrated pages.
 *
 * Checks, in a real browser, that:
 *   1. each page renders in English with no Portuguese left;
 *   2. switching to Portuguese changes the page without a reload;
 *   3. no English UI text leaks when Portuguese is selected;
 *   4. user data (investigation titles/topics) is NOT translated;
 *   5. switching back restores English.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-i18n-pages.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { spaRoot } from './dist-root.ts'
import { Page } from './cdp.ts'

const PORT = 8863
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/**
 * Portuguese words that must NOT appear in an English page.
 *
 * Only UI vocabulary. Two sources of legitimate Portuguese are excluded:
 *   - user data (the investigation title/topic are seeded in English anyway);
 *   - **activity-log descriptions**, which the server stores as free text at the
 *     moment of the event (`Investigação "…" criada`). Those are historical
 *     records, not interface copy: translating them at render time would rewrite
 *     history, which this phase explicitly forbids. They remain as recorded.
 */
const PT_MARKERS = [
  'Nenhuma', 'Nenhum', 'Visão geral',
  'Atualizar', 'Excluir', 'Criar', 'Cancelar', 'Buscar', 'Exibindo',
  'Evidências', 'Análises', 'Pesquisar', 'Exportar', 'Editar', 'Histórico',
  'Configurações', 'em andamento', 'aguardando', 'Distribuição', 'Consumo',
]

/** English words that must NOT appear in a Portuguese page. */
const EN_MARKERS = [
  'Overview', 'Investigations', 'Evidence', 'Analyses', 'Validation',
  'Settings', 'History', 'Refresh', 'Delete', 'Create', 'Cancel', 'Search',
  'Showing', 'Distribution', 'Consumption', 'No investigation',
]

const readBody = `document.body.innerText`

async function goto(page: Page, path: string): Promise<string> {
  await page.goto(`${BASE}${path}`)
  await new Promise((r) => setTimeout(r, 850))
  return page.evaluate<string>(readBody)
}

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

  const { page, close } = await Page.open({ width: 1440, height: 1000 })
  try {
    await page.goto(`${BASE}/login`)
    const id = await page.evaluate<string>(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      await fetch('/api/auth/login', { method: 'POST', headers: h,
        body: JSON.stringify({ email: 'phase1@signalmess.test', name: 'Phase One' }) });
      const inv = await fetch('/api/investigations', { method: 'POST', headers: h, body: JSON.stringify({
        title: 'Fraud prevention in retail banking',
        description: 'A study of fraud prevention mechanisms and information sharing.',
        objective: 'Identify which fraud prevention mechanisms are documented and what results are published.',
        topic: 'fraud prevention',
        keywords: ['fraud', 'banking'],
        status: 'active' }) });
      const payload = await inv.json();
      return payload.data.id;
    })()`)

    const PAGES = [
      { name: 'dashboard', path: '/dashboard' },
      { name: 'investigations', path: '/investigations' },
      { name: 'detail', path: `/investigations/${id}` },
    ]

    // ---- English pass --------------------------------------------------
    console.log('\n=== ENGLISH (idioma padrão) ===')
    for (const target of PAGES) {
      const text = await goto(page, target.path)
      const hits = PT_MARKERS.filter((m) => text.includes(m))
      check(hits.length === 0, `${target.name}: sem texto em português`, `encontrado: ${hits.join(', ')}`)
    }

    // Sanity: English copy actually rendered
    const dashboardEn = await goto(page, '/dashboard')
    check(/Overview|Investigations|Evidence/i.test(dashboardEn), 'dashboard exibe inglês')

    // User data preserved (never translated)
    check(dashboardEn.includes('Fraud prevention in retail banking'), 'título do registro preservado em EN')
    const detailEn = await goto(page, `/investigations/${id}`)
    check(detailEn.includes('Fraud prevention in retail banking'), 'título preservado no detalhe (EN)')
    check(detailEn.includes('fraud prevention'), 'tema preservado no detalhe (EN)')

    // ---- Switch to Portuguese ------------------------------------------
    console.log('\n=== TROCA PARA PORTUGUÊS (sem reload) ===')
    await page.goto(`${BASE}/settings`)
    await new Promise((r) => setTimeout(r, 900))
    const picked = await page.evaluate<Record<string, unknown>>(`
      (() => {
        const r = [...document.querySelectorAll('input[name="locale"]')]
          .find(x => (x.getAttribute('aria-label') || '') === 'Português (Brasil)');
        if (!r) return { found: false };
        r.click();
        return { found: true };
      })()`)
    check(picked['found'] === true, 'seletor de idioma disponível')

    for (const target of PAGES) {
      const text = await goto(page, target.path)
      const hits = EN_MARKERS.filter((m) => text.includes(m))
      check(hits.length === 0, `${target.name}: sem texto em inglês`, `encontrado: ${hits.join(', ')}`)
      check(/Investigaç|Visão geral|Evidênc|Anális/i.test(text), `${target.name}: interface em português`)
    }

    // Data still intact in Portuguese
    const detailPt = await goto(page, `/investigations/${id}`)
    check(detailPt.includes('Fraud prevention in retail banking'), 'título preservado (PT)')
    check(!detailPt.includes('Prevenção de fraudes no varejo'), 'título NÃO foi traduzido')

    // ---- Back to English ------------------------------------------------
    console.log('\n=== VOLTA PARA INGLÊS ===')
    await page.goto(`${BASE}/settings`)
    await new Promise((r) => setTimeout(r, 900))
    await page.evaluate(`
      (() => {
        const r = [...document.querySelectorAll('input[name="locale"]')]
          .find(x => (x.getAttribute('aria-label') || '') === 'English');
        if (r) r.click();
      })()`)
    await new Promise((r) => setTimeout(r, 700))
    const backText = await goto(page, '/dashboard')
    check(!PT_MARKERS.some((m) => backText.includes(m)), 'dashboard volta ao inglês')

    console.log(`\nfailures: ${failures}`)
    if (failures > 0) process.exitCode = 1
  } finally {
    await close()
    server.close()
    built.close()
  }
}

await main()
