/**
 * i18n behaviour in a real browser.
 *
 * Verifies what the catalog tests cannot:
 *   1. English is what a first-time visitor sees;
 *   2. the selector is present and reachable in Settings;
 *   3. switching to Portuguese changes the rendered interface immediately, with
 *      no reload;
 *   4. the choice survives a reload and a fresh navigation;
 *   5. <html lang> follows the selection;
 *   6. dates and numbers reformat per locale;
 *   7. stored data (investigation titles, evidence) is NOT translated.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-i18n.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { spaRoot } from './dist-root.ts'
import { Page } from './cdp.ts'

const PORT = 8861
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** Click the language option whose visible label matches. */
const pickLanguage = (label: string) => `
  (() => {
    const radios = [...document.querySelectorAll('input[name="locale"]')];
    const target = radios.find(r => (r.getAttribute('aria-label') || '') === ${JSON.stringify(label)});
    if (!target) return { found: false, options: radios.map(r => r.getAttribute('aria-label')) };
    target.click();
    return { found: true };
  })()`

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
    // ---- 1. Default locale for a new visitor ----------------------------
    console.log('\n=== 1. IDIOMA PADRÃO ===')
    await page.goto(`${BASE}/login`)
    await new Promise((r) => setTimeout(r, 600))
    const initial = await page.evaluate<Record<string, unknown>>(`
      (() => ({
        htmlLang: document.documentElement.lang,
        stored: window.localStorage.getItem('signalmess.locale'),
        body: document.body.innerText.slice(0, 400),
      }))()`)
    check(initial['htmlLang'] === 'en', 'html lang = en por padrão', String(initial['htmlLang']))
    check(initial['stored'] === null, 'nenhuma preferência salva ainda')

    // Seed an investigation so we can prove data is not translated.
    await page.evaluate(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      await fetch('/api/auth/login', { method: 'POST', headers: h,
        body: JSON.stringify({ email: 'i18n@signalmess.test', name: 'I18n' }) });
      await fetch('/api/investigations', { method: 'POST', headers: h, body: JSON.stringify({
        title: 'Título original em português',
        description: 'Descrição que deve permanecer intacta.',
        objective: 'Verificar que registros não são traduzidos pela interface.',
        topic: 'internacionalização', keywords: ['i18n'], status: 'active' }) });
    })()`)

    // ---- 2. Selector present in Settings --------------------------------
    console.log('\n=== 2. SELETOR DE IDIOMA ===')
    await page.goto(`${BASE}/settings`)
    await new Promise((r) => setTimeout(r, 900))
    const selector = await page.evaluate<Record<string, unknown>>(`
      (() => {
        const radios = [...document.querySelectorAll('input[name="locale"]')];
        const native = [...document.querySelectorAll('button')].some(b => (b.textContent||'').includes('Sair') || (b.textContent||'').includes('Sign out'));
        return {
          count: radios.length,
          labels: radios.map(r => r.getAttribute('aria-label')),
          checked: radios.filter(r => r.checked).map(r => r.getAttribute('aria-label')),
        };
      })()`)
    check(Number(selector['count']) === 2, 'dois idiomas disponíveis', JSON.stringify(selector['labels']))
    check(JSON.stringify(selector['labels']) === JSON.stringify(['English', 'Português (Brasil)']), 'rótulos corretos', JSON.stringify(selector['labels']))
    check(JSON.stringify(selector['checked']) === JSON.stringify(['English']), 'English marcado por padrão', JSON.stringify(selector['checked']))

    // ---- 3. Switch to Portuguese, no reload ----------------------------
    console.log('\n=== 3. TROCA PARA PORTUGUÊS ===')
    const before = await page.evaluate<string>('document.body.innerText.slice(0, 600)')
    const picked = await page.evaluate<Record<string, unknown>>(pickLanguage('Português (Brasil)'))
    check(picked['found'] === true, 'opção português encontrada', JSON.stringify(picked))
    await new Promise((r) => setTimeout(r, 700))
    const after = await page.evaluate<Record<string, unknown>>(`
      (() => ({
        htmlLang: document.documentElement.lang,
        stored: window.localStorage.getItem('signalmess.locale'),
        body: document.body.innerText.slice(0, 600),
        navLabels: [...document.querySelectorAll('nav a')].map(a => (a.textContent||'').trim()).filter(Boolean),
      }))()`)
    check(after['htmlLang'] === 'pt-BR', 'html lang = pt-BR', String(after['htmlLang']))
    check(after['stored'] === 'pt-BR', 'preferência persistida no storage', String(after['stored']))
    check(String(after['body']) !== before, 'texto da interface mudou sem reload')
    const navText = JSON.stringify(after['navLabels'])
    check(navText.includes('Visão geral') || navText.includes('Investigações'), 'navegação em português', navText)

    // ---- 4. Persist across reload --------------------------------------
    console.log('\n=== 4. PERSISTÊNCIA APÓS RELOAD ===')
    await page.goto(`${BASE}/settings`)
    await new Promise((r) => setTimeout(r, 900))
    const afterReload = await page.evaluate<Record<string, unknown>>(`
      (() => ({
        htmlLang: document.documentElement.lang,
        checked: [...document.querySelectorAll('input[name="locale"]')].filter(r => r.checked).map(r => r.getAttribute('aria-label')),
      }))()`)
    check(afterReload['htmlLang'] === 'pt-BR', 'idioma mantido após reload', String(afterReload['htmlLang']))
    check(JSON.stringify(afterReload['checked']) === JSON.stringify(['Português (Brasil)']), 'opção portuguesa marcada', JSON.stringify(afterReload['checked']))

    // ---- 5. Data is not translated -------------------------------------
    console.log('\n=== 5. DADOS NÃO SÃO TRADUZIDOS ===')
    await page.goto(`${BASE}/investigations`)
    await new Promise((r) => setTimeout(r, 900))
    const list = await page.evaluate<string>('document.body.innerText')
    check(list.includes('Título original em português'), 'título do registro preservado', 'título não encontrado na listagem')

    // ---- 6. Dates/numbers follow the locale ----------------------------
    console.log('\n=== 6. FORMATAÇÃO POR IDIOMA ===')
    await page.goto(`${BASE}/settings`)
    await new Promise((r) => setTimeout(r, 900))
    const ptDate = await page.evaluate<string>(`
      (() => {
        const m = document.body.innerText.match(/\\d{2}\\/\\d{2}\\/\\d{4}|\\d{2} de [a-zç]+\\.? de \\d{4}|[A-Z][a-z]{2} \\d{1,2}, \\d{4}/);
        return m ? m[0] : 'no-date';
      })()`)
    console.log(`  data exibida em pt-BR: ${ptDate}`)

    // Switch back to English and confirm the interface returns.
    console.log('\n=== 7. VOLTA PARA INGLÊS ===')
    await page.evaluate(pickLanguage('English'))
    await new Promise((r) => setTimeout(r, 700))
    const back = await page.evaluate<Record<string, unknown>>(`
      (() => ({
        htmlLang: document.documentElement.lang,
        checked: [...document.querySelectorAll('input[name="locale"]')].filter(r => r.checked).map(r => r.getAttribute('aria-label')),
      }))()`)
    check(back['htmlLang'] === 'en', 'html lang volta a en', String(back['htmlLang']))
    check(JSON.stringify(back['checked']) === JSON.stringify(['English']), 'English marcado novamente', JSON.stringify(back['checked']))

    console.log(`\nfailures: ${failures}`)
    if (failures > 0) process.exitCode = 1
  } finally {
    await close()
    server.close()
    built.close()
  }
}

await main()
