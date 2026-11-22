/**
 * Final i18n audit: full-application browser sweep in both languages.
 *
 * Covers every routed page plus shared chrome (sidebar, footer, modals,
 * notifications), checks the no-reload switch, persistence, dynamic-data
 * preservation and regional formatting.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-i18n-final.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { spaRoot } from './dist-root.ts'
import { Page } from './cdp.ts'

const PORT = 8869
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
let checks = 0
function check(ok: boolean, label: string, detail = ''): void {
  checks += 1
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** Portuguese UI vocabulary. Excludes stored activity-log free text. */
const PT_MARKERS = [
  'Nenhuma', 'Nenhum', 'Pesquisar', 'Pesquisas', 'Evidências', 'Análises',
  'Análise estruturada', 'Validação', 'Solicitar', 'Adicionar', 'Justificativa',
  'Dispensar', 'Resumo executivo', 'Limitações', 'Lacunas', 'Prioridade',
  'Configurações', 'Histórico', 'Auditoria', 'Privacidade', 'Objetivo',
  'Título', 'Tema', 'Descrição', 'Buscar', 'Atualizar', 'Criar', 'Cancelar',
  'Voltar', 'Página inicial', 'Erro 404', 'Encerrar sessão', 'Investigações',
]

/**
 * English UI vocabulary. Matched as whole tokens.
 *
 * Deliberately absent, each for a documented reason:
 *  - "Evidence": the History page renders `entry.eventType` (`evidence.added`),
 *    a persisted enum identifier that must stay stable, and the Landing page
 *    renders `APP_TAGLINE` ("Research & Evidence Intelligence"), a product
 *    constant treated as a proper noun like the brand name.
 *  - "Status", "JSON", "CSV", "Exa", "Gemini": identical in both languages.
 */
const EN_MARKERS = [
  'Overview', 'Investigations', 'Analyses', 'Validation',
  'Settings', 'History', 'Refresh', 'Delete', 'Create', 'Cancel', 'Search',
  'Executive summary', 'Limitations', 'Findings', 'Pending', 'Approved',
  'Rejected', 'Sign in', 'Home page', 'Error 404', 'End session', 'Privacy',
]

/** Whole-token match, so "Cancelar" does not trip "Cancel". */
function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}])${escaped}([^\\p{L}]|$)`, 'iu').test(text)
}

const hits = (text: string, markers: string[]) => markers.filter((m) => mentions(text, m))

async function goto(page: Page, path: string): Promise<string> {
  await page.goto(`${BASE}${path}`)
  await new Promise((r) => setTimeout(r, 900))
  return page.evaluate<string>('document.body.innerText')
}

async function pickLocale(page: Page, label: string): Promise<boolean> {
  await page.goto(`${BASE}/settings`)
  await new Promise((r) => setTimeout(r, 900))
  const ok = await page.evaluate<boolean>(`
    (() => {
      const r = [...document.querySelectorAll('input[name="locale"]')]
        .find(x => (x.getAttribute('aria-label') || '') === ${JSON.stringify(label)});
      if (!r) return false;
      r.click();
      return true;
    })()`)
  await new Promise((r) => setTimeout(r, 550))
  return ok
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
    // ---- 1. First visit is English -------------------------------------
    console.log('\n=== 1. ABERTURA INICIAL (en) ===')
    await page.goto(`${BASE}/login`)
    await new Promise((r) => setTimeout(r, 700))
    const initial = await page.evaluate<Record<string, unknown>>(`
      (() => ({ lang: document.documentElement.lang, stored: localStorage.getItem('signalmess.locale') }))()`)
    check(initial['lang'] === 'en', 'html lang = en por padrão', String(initial['lang']))
    check(initial['stored'] === null, 'sem preferência salva na primeira visita')

    // Seed data (no external calls).
    const seed = await page.evaluate<{ id: string; evidenceId: string }>(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      await fetch('/api/auth/login', { method: 'POST', headers: h,
        body: JSON.stringify({ email: 'audit@signalmess.test', name: 'Audit User' }) });
      const inv = await fetch('/api/investigations', { method: 'POST', headers: h, body: JSON.stringify({
        title: 'Cross-border payment fraud',
        description: 'Documents on payment fraud controls across jurisdictions.',
        objective: 'Identify documented controls and their published outcomes.',
        topic: 'payment fraud', keywords: ['fraud', 'payments'], status: 'active' }) });
      const p = await inv.json();
      const id = p.data.id;
      const ev = await fetch('/api/investigations/' + id + '/evidence', { method: 'POST', headers: h,
        body: JSON.stringify({ source: {
          title: 'European Central Bank — fraud report',
          url: 'https://example.org/ecb-fraud-report',
          domain: 'example.org',
          snippet: 'Documented controls for cross-border payment fraud.' } }) });
      const ep = await ev.json();
      return { id, evidenceId: ep.data?.id ?? '' };
    })()`)
    const id = seed.id

    const PAGES = [
      { name: 'dashboard', path: '/dashboard' },
      { name: 'investigations', path: '/investigations' },
      { name: 'detail', path: `/investigations/${id}` },
      { name: 'research', path: `/investigations/${id}/research` },
      { name: 'evidence', path: `/investigations/${id}/evidence` },
      { name: 'analysis', path: `/investigations/${id}/analysis` },
      { name: 'validation', path: `/investigations/${id}/validation` },
      { name: 'new', path: '/investigations/new' },
      { name: 'history', path: '/history' },
      { name: 'settings', path: '/settings' },
      { name: 'landing', path: '/' },
      { name: '404', path: '/nao-existe' },
    ]

    // ---- 2. Every page in English --------------------------------------
    console.log('\n=== 2. TODAS AS PÁGINAS EM INGLÊS ===')
    for (const target of PAGES) {
      const text = await goto(page, target.path)
      const found = hits(text, PT_MARKERS)
      check(found.length === 0, `${target.name}: sem texto em português`, found.join(', '))
      check(text.trim().length > 80, `${target.name}: renderizou conteúdo`)
    }

    // ---- 3. Dynamic data preserved in English --------------------------
    console.log('\n=== 3. DADOS DINÂMICOS (en) ===')
    const detailEn = await goto(page, `/investigations/${id}`)
    check(detailEn.includes('Cross-border payment fraud'), 'título da investigação preservado')
    const evEn = await goto(page, `/investigations/${id}/evidence`)
    check(evEn.includes('European Central Bank — fraud report'), 'título da fonte preservado')
    check(evEn.includes('example.org'), 'domínio da fonte preservado')

    // ---- 4. Modals and empty states in English -------------------------
    console.log('\n=== 4. MODAIS E ESTADOS VAZIOS (en) ===')
    await page.goto(`${BASE}/investigations/${id}`)
    await new Promise((r) => setTimeout(r, 900))
    const modalText = await page.evaluate<string>(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => /Delete|Excluir/i.test(b.textContent || ''));
        if (!btn) return '';
        btn.click();
        return new Promise(r => setTimeout(() => r(document.body.innerText), 500));
      })()`)
    if (modalText) {
      const found = hits(modalText, PT_MARKERS)
      check(found.length === 0, 'modal de exclusão em inglês', found.join(', '))
      await page.press('Escape')
    } else {
      check(false, 'modal de exclusão abriu')
    }

    // ---- 5. Switch to Portuguese without reload ------------------------
    console.log('\n=== 5. TROCA PARA PORTUGUÊS ===')
    check(await pickLocale(page, 'Português (Brasil)'), 'seletor operante')
    const langAfter = await page.evaluate<string>('document.documentElement.lang')
    check(langAfter === 'pt-BR', 'html lang = pt-BR', langAfter)

    // ---- 6. Every page in Portuguese -----------------------------------
    console.log('\n=== 6. TODAS AS PÁGINAS EM PORTUGUÊS ===')
    for (const target of PAGES) {
      const text = await goto(page, target.path)
      const found = hits(text, EN_MARKERS)
      check(found.length === 0, `${target.name}: sem texto em inglês`, found.join(', '))
    }

    // ---- 7. Dynamic data preserved in Portuguese -----------------------
    console.log('\n=== 7. DADOS DINÂMICOS (pt-BR) ===')
    const detailPt = await goto(page, `/investigations/${id}`)
    check(detailPt.includes('Cross-border payment fraud'), 'título da investigação preservado (PT)')
    check(!detailPt.includes('Fraude em pagamentos transfronteiriços'), 'título NÃO foi traduzido')
    const evPt = await goto(page, `/investigations/${id}/evidence`)
    check(evPt.includes('European Central Bank — fraud report'), 'título da fonte preservado (PT)')

    // ---- 8. Regional formatting ----------------------------------------
    console.log('\n=== 8. FORMATAÇÃO REGIONAL ===')
    const settingsPt = await goto(page, '/settings')
    check(/\d{2}\/\d{2}\/\d{4}|\d{2} de [a-zç]+\.? de \d{4}/i.test(settingsPt), 'data formatada em pt-BR')
    const historyPt = await goto(page, '/history')
    check(/[a-zç]{3,},?\s+\d{2}\s+de\s+[a-zç]+/i.test(historyPt) || /\d{2}\s+de\s+[a-zç]+/i.test(historyPt), 'cabeçalho de dia em pt-BR')

    // ---- 9. Persistence -------------------------------------------------
    console.log('\n=== 9. PERSISTÊNCIA ===')
    await page.goto(`${BASE}/dashboard`)
    await new Promise((r) => setTimeout(r, 500))
    // Reload by navigating to the same URL again: the driver has no reload helper.
    await page.goto(`${BASE}/dashboard`)
    await new Promise((r) => setTimeout(r, 900))
    const persisted = await page.evaluate<Record<string, unknown>>(`
      (() => ({ lang: document.documentElement.lang, stored: localStorage.getItem('signalmess.locale') }))()`)
    check(persisted['lang'] === 'pt-BR', 'idioma persiste após recarregar', String(persisted['lang']))
    check(persisted['stored'] === 'pt-BR', 'preferência no storage', String(persisted['stored']))

    // ---- 10. Back to English -------------------------------------------
    console.log('\n=== 10. VOLTA PARA INGLÊS ===')
    check(await pickLocale(page, 'English'), 'seletor volta para inglês')
    const backEn = await goto(page, '/settings')
    check(hits(backEn, PT_MARKERS).length === 0, 'settings volta ao inglês')

    // ---- 11. Responsiveness --------------------------------------------
    console.log('\n=== 11. RESPONSIVIDADE ===')
    for (const width of [390, 768, 1024]) {
      await page.evaluate(`window.resizeTo?.(${width}, 800)`)
      await new Promise((r) => setTimeout(r, 250))
      const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth')
      check(overflow <= 2, `sem overflow horizontal em ${width}px`, `overflow=${overflow}px`)
    }

    console.log(`\nchecks: ${checks}  failures: ${failures}`)
    if (failures > 0) process.exitCode = 1
  } finally {
    await close()
    server.close()
    built.close()
  }
}

await main()
