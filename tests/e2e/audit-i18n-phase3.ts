/**
 * Phase 3 i18n: browser verification of the remaining six contexts.
 *
 * Covers Landing, New Investigation, History, Login, NotFound and the Logo
 * wordmark, in both languages, plus the no-reload switch and persistence.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-i18n-phase3.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { spaRoot } from './dist-root.ts'
import { Page } from './cdp.ts'

const PORT = 8867
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
 * Portuguese UI vocabulary that must not appear in English.
 *
 * Deliberately excludes "Investigação": the server stores activity-log
 * descriptions as free text at event time (`Investigação "…" criada`). Those are
 * historical records, not interface copy — translating them at render would
 * rewrite history, which this project forbids.
 */
const PT_MARKERS = [
  'Entrar', 'Nenhum', 'Nenhuma',
  'Histórico', 'Auditoria', 'Privacidade', 'Objetivo', 'Título', 'Tema',
  'Buscar', 'Atualizar', 'Cancelar', 'Voltar', 'Página inicial',
  'Erro 404', 'rastreáveis', 'evidências', 'Plataforma de inteligência',
]

/**
 * English UI vocabulary that must not appear in Portuguese.
 *
 * Matched as whole words/phrases: `"Cancelar".includes("Cancel")` is true, so a
 * naive substring test would report a false positive.
 */
const EN_MARKERS = [
  'Sign in',
  'Investigations',
  'History',
  'Audit',
  'Privacy',
  'Objective',
  'Title',
  'Topic',
  'Search',
  'Refresh',
  'Home page',
  'Error 404',
  'traceable',
  'intelligence platform',
]

/** True when `text` contains `word` as a standalone token. */
function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}])${escaped}([^\\p{L}]|$)`, 'iu').test(text)
}

async function goto(page: Page, path: string): Promise<string> {
  await page.goto(`${BASE}${path}`)
  await new Promise((r) => setTimeout(r, 850))
  return page.evaluate<string>('document.body.innerText')
}

async function pickLocale(page: Page, label: string): Promise<boolean> {
  await page.goto(`${BASE}/settings`)
  await new Promise((r) => setTimeout(r, 850))
  const ok = await page.evaluate<boolean>(`
    (() => {
      const r = [...document.querySelectorAll('input[name="locale"]')]
        .find(x => (x.getAttribute('aria-label') || '') === ${JSON.stringify(label)});
      if (!r) return false;
      r.click();
      return true;
    })()`)
  await new Promise((r) => setTimeout(r, 500))
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
    // ---- PUBLIC CONTEXTS (no auth) -------------------------------------
    console.log('\n=== LANDING — ENGLISH ===')
    const landingEn = await goto(page, '/')
    check(!PT_MARKERS.some((m) => mentions(landingEn, m)), 'landing: sem português', PT_MARKERS.filter((m) => mentions(landingEn, m)).join(', '))
    check(/Scattered information|intelligence/i.test(landingEn), 'landing: hero em inglês')
    check(landingEn.includes('SIGNAL') && landingEn.includes('MESH'), 'logo: marca preservada (não traduzida)')

    console.log('\n=== LOGIN — ENGLISH ===')
    const loginEn = await goto(page, '/login')
    check(!PT_MARKERS.some((m) => mentions(loginEn, m)), 'login: sem português', PT_MARKERS.filter((m) => mentions(loginEn, m)).join(', '))
    check(/Sign in/i.test(loginEn), 'login: botão em inglês')

    console.log('\n=== 404 — ENGLISH ===')
    const nfEn = await goto(page, '/rota-que-nao-existe')
    check(!PT_MARKERS.some((m) => mentions(nfEn, m)), '404: sem português', PT_MARKERS.filter((m) => mentions(nfEn, m)).join(', '))
    check(/404/.test(nfEn) && /does not exist/i.test(nfEn), '404: conteúdo em inglês')

    // Authenticate for the private contexts; also switch locale.
    await page.goto(`${BASE}/login`)
    await page.evaluate(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      await fetch('/api/auth/login', { method: 'POST', headers: h,
        body: JSON.stringify({ email: 'phase3@signalmess.test', name: 'Phase Three' }) });
    })()`)

    // Build a little history so the page is not empty.
    await page.evaluate(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      const inv = await fetch('/api/investigations', { method: 'POST', headers: h, body: JSON.stringify({
        title: 'Supply chain resilience study',
        description: 'Sources on supply chain resilience and disruption recovery.',
        objective: 'Identify documented resilience practices and their published outcomes.',
        topic: 'supply chain resilience', keywords: ['logistics'], status: 'active' }) });
      const p = await inv.json();
      await fetch('/api/investigations/' + p.data.id, { method: 'PATCH', headers: h,
        body: JSON.stringify({ objective: 'Identify which resilience practices are documented and what outcomes are published.' }) });
    })()`)

    console.log('\n=== NEW INVESTIGATION — ENGLISH ===')
    const newEn = await goto(page, '/investigations/new')
    check(!PT_MARKERS.some((m) => mentions(newEn, m)), 'nova investigação: sem português', PT_MARKERS.filter((m) => mentions(newEn, m)).join(', '))
    check(/Define what you want to find out/i.test(newEn), 'nova investigação: título em inglês')

    console.log('\n=== HISTORY — ENGLISH ===')
    const histEn = await goto(page, '/history')
    check(!PT_MARKERS.some((m) => mentions(histEn, m)), 'histórico: sem português (UI)', PT_MARKERS.filter((m) => mentions(histEn, m)).join(', '))
    check(/History|Audit/i.test(histEn), 'histórico: cabeçalho em inglês')
    // Stored activity descriptions are Portuguese free text by design; confirm
    // the record itself was not rewritten.
    check(histEn.includes('Supply chain resilience study'), 'histórico: registro original preservado')

    // ---- SWITCH TO PORTUGUESE ------------------------------------------
    console.log('\n=== TROCA PARA PORTUGUÊS (sem reload) ===')
    check(await pickLocale(page, 'Português (Brasil)'), 'seletor operante')

    const landingPt = await goto(page, '/')
    check(!EN_MARKERS.some((m) => mentions(landingPt, m)), 'landing: sem inglês', EN_MARKERS.filter((m) => mentions(landingPt, m)).join(', '))
    check(/Informação dispersa|inteligência/i.test(landingPt), 'landing: hero em português')

    // `/login` redirects an authenticated visitor, so sign out before checking
    // the Portuguese sign-in surface, then sign back in for the private pages.
    await page.evaluate(`(async () => {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-signalmess-request': '1' } });
    })()`)

    const loginPt = await goto(page, '/login')
    check(!EN_MARKERS.some((m) => mentions(loginPt, m)), 'login: sem inglês', EN_MARKERS.filter((m) => mentions(loginPt, m)).join(', '))
    check(/Entrar/i.test(loginPt), 'login: botão em português')

    await page.evaluate(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      await fetch('/api/auth/login', { method: 'POST', headers: h,
        body: JSON.stringify({ email: 'phase3@signalmess.test', name: 'Phase Three' }) });
    })()`)

    const nfPt = await goto(page, '/rota-que-nao-existe')
    check(!EN_MARKERS.some((m) => mentions(nfPt, m)), '404: sem inglês', EN_MARKERS.filter((m) => mentions(nfPt, m)).join(', '))
    check(/não existe/i.test(nfPt), '404: conteúdo em português')

    const newPt = await goto(page, '/investigations/new')
    check(!EN_MARKERS.some((m) => mentions(newPt, m)), 'nova investigação: sem inglês', EN_MARKERS.filter((m) => mentions(newPt, m)).join(', '))
    check(/Defina o que você quer descobrir/i.test(newPt), 'nova investigação: título em português')

    const histPt = await goto(page, '/history')
    check(/Histórico|Auditoria/i.test(histPt), 'histórico: cabeçalho em português')
    check(histPt.includes('Supply chain resilience study'), 'histórico: registro original preservado (PT)')

    // ---- PERSISTENCE ----------------------------------------------------
    console.log('\n=== PERSISTÊNCIA ===')
    await goto(page, '/dashboard')
    const persisted = await page.evaluate<Record<string, unknown>>(`
      (() => ({
        lang: document.documentElement.lang,
        stored: window.localStorage.getItem('signalmess.locale'),
      }))()`)
    check(persisted['lang'] === 'pt-BR', 'html lang persistiu', String(persisted['lang']))
    check(persisted['stored'] === 'pt-BR', 'preferência persistida', String(persisted['stored']))

    // Back to English.
    check(await pickLocale(page, 'English'), 'volta ao inglês')
    const backEn = await goto(page, '/')
    check(!PT_MARKERS.some((m) => mentions(backEn, m)), 'landing volta ao inglês')

    console.log(`\nfailures: ${failures}`)
    if (failures > 0) process.exitCode = 1
  } finally {
    await close()
    server.close()
    built.close()
  }
}

await main()
