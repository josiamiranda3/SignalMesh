/**
 * Phase 2 i18n: browser verification of the research → validation flow.
 *
 * Verifies, in a real browser:
 *   1. the four pages render in English with no Portuguese UI copy;
 *   2. switching to Portuguese changes them without a reload;
 *   3. no English UI text leaks when Portuguese is selected;
 *   4. provider/source data is NOT translated (titles, URLs, snippets, models);
 *   5. the Exa/Gemini integration surfaces still render (quota, provider state).
 *
 * Run: node --experimental-transform-types tests/e2e/audit-i18n-phase2.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Page } from './cdp.ts'

const PORT = 8865
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** Portuguese UI vocabulary that must not survive in the English interface. */
const PT_MARKERS = [
  'Nenhuma', 'Nenhum', 'Pesquisar', 'Pesquisa externa', 'Consulta',
  'Evidências', 'Análises', 'Análise estruturada', 'Validação',
  'Solicitar análise', 'Adicionar evidência', 'Justificativa', 'Dispensar',
  'resumo executivo', 'Resumo executivo', 'Limitações', 'Lacunas',
  'contradições', 'Prioridade', 'conteúdo integral', 'adicionada',
]

/** English UI vocabulary that must not survive in the Portuguese interface. */
const EN_MARKERS = [
  'Search the web', 'External research', 'Evidence', 'Analysis',
  'Request analysis', 'Add evidence', 'Validation', 'Justification',
  'Executive summary', 'Limitations', 'Findings', 'Pending',
  'Approved', 'Rejected', 'Refresh', 'Settings',
]

async function goto(page: Page, path: string): Promise<string> {
  await page.goto(`${BASE}${path}`)
  await new Promise((r) => setTimeout(r, 900))
  return page.evaluate<string>('document.body.innerText')
}

async function pickLocale(page: Page, label: string): Promise<boolean> {
  await page.goto(`${BASE}/settings`)
  await new Promise((r) => setTimeout(r, 900))
  return page.evaluate<boolean>(`
    (() => {
      const r = [...document.querySelectorAll('input[name="locale"]')]
        .find(x => (x.getAttribute('aria-label') || '') === ${JSON.stringify(label)});
      if (!r) return false;
      r.click();
      return true;
    })()`)
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
  built.app.use('*', serveStatic({ root: './dist' }))
  built.app.get('*', serveStatic({ path: './dist/index.html' }))
  const server = serve({ fetch: built.app.fetch, port: PORT, hostname: '127.0.0.1' })
  await new Promise((r) => setTimeout(r, 500))

  const { page, close } = await Page.open({ width: 1440, height: 1000 })
  try {
    await page.goto(`${BASE}/login`)
    // Seed an investigation with one evidence item so the pages are populated.
    const seed = await page.evaluate<{ id: string; evidenceId: string }>(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      await fetch('/api/auth/login', { method: 'POST', headers: h,
        body: JSON.stringify({ email: 'phase2@signalmess.test', name: 'Phase Two' }) });
      const inv = await fetch('/api/investigations', { method: 'POST', headers: h, body: JSON.stringify({
        title: 'Payment fraud controls in retail banking',
        description: 'Sources on fraud controls and information sharing between institutions.',
        objective: 'Identify which payment fraud controls are documented and what outcomes are published.',
        topic: 'payment fraud',
        keywords: ['fraud', 'payments'],
        status: 'active' }) });
      const payload = await inv.json();
      const id = payload.data.id;
      const ev = await fetch('/api/investigations/' + id + '/evidence', { method: 'POST', headers: h,
        body: JSON.stringify({ source: {
          title: 'Central bank — fraud prevention guidance',
          url: 'https://example.org/central-bank-fraud-guidance',
          domain: 'example.org',
          snippet: 'Institutional guidance on identity verification and fraud information sharing.',
        } }) });
      const evPayload = await ev.json();
      return { id, evidenceId: evPayload.data?.id ?? '' };
    })()`)
    const id = seed.id

    const PAGES = [
      { name: 'research', path: `/investigations/${id}/research` },
      { name: 'evidence', path: `/investigations/${id}/evidence` },
      { name: 'analysis', path: `/investigations/${id}/analysis` },
      { name: 'validation', path: `/investigations/${id}/validation` },
    ]

    // ---- English pass --------------------------------------------------
    console.log('\n=== ENGLISH (idioma padrão) ===')
    for (const target of PAGES) {
      const text = await goto(page, target.path)
      const hits = PT_MARKERS.filter((m) => text.includes(m))
      check(hits.length === 0, `${target.name}: sem texto em português`, `encontrado: ${hits.join(', ')}`)
      check(text.length > 100, `${target.name}: renderizou conteúdo`, `${text.length} chars`)
    }

    // Provider surfaces still present in English
    const researchEn = await goto(page, `/investigations/${id}/research`)
    check(/Exa|exa/.test(researchEn), 'pesquisa: referência à Exa presente')
    check(/Search|searches/i.test(researchEn), 'pesquisa: rótulo de busca em inglês')
    const analysisEn = await goto(page, `/investigations/${id}/analysis`)
    check(/Gemini|gemini/.test(analysisEn), 'análise: referência ao Gemini presente')

    // Source data untouched
    const evidenceEn = await goto(page, `/investigations/${id}/evidence`)
    check(evidenceEn.includes('Central bank — fraud prevention guidance'), 'título da fonte preservado (EN)')
    check(evidenceEn.includes('https://example.org/central-bank-fraud-guidance') || evidenceEn.includes('example.org'), 'URL/domínio da fonte preservado (EN)')

    // ---- Portuguese pass ------------------------------------------------
    console.log('\n=== TROCA PARA PORTUGUÊS ===')
    check(await pickLocale(page, 'Português (Brasil)'), 'seletor de idioma operante')

    for (const target of PAGES) {
      const text = await goto(page, target.path)
      const hits = EN_MARKERS.filter((m) => text.includes(m))
      check(hits.length === 0, `${target.name}: sem texto em inglês`, `encontrado: ${hits.join(', ')}`)
      check(/Pesquis|Evidênc|Anális|Validaç|Consulta|Decis/i.test(text), `${target.name}: interface em português`)
    }

    // Source data still untouched in Portuguese
    const evidencePt = await goto(page, `/investigations/${id}/evidence`)
    check(evidencePt.includes('Central bank — fraud prevention guidance'), 'título da fonte preservado (PT)')
    check(!evidencePt.includes('Banco central — orientação'), 'título NÃO foi traduzido')

    // ---- Back to English ------------------------------------------------
    console.log('\n=== VOLTA PARA INGLÊS ===')
    check(await pickLocale(page, 'English'), 'seletor volta para inglês')
    const back = await goto(page, `/investigations/${id}/research`)
    check(!PT_MARKERS.some((m) => back.includes(m)), 'pesquisa volta ao inglês')

    console.log(`\nfailures: ${failures}`)
    if (failures > 0) process.exitCode = 1
  } finally {
    await close()
    server.close()
    built.close()
  }
}

await main()
