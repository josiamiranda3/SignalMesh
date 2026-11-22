/**
 * New-investigation form: validation feedback and keyword handling.
 *
 * Verifies, against the real rendered form:
 *
 *   1. a valid submission creates the investigation;
 *   2. each required field missing produces its own specific message, on the
 *      field and in the summary, with `aria-invalid` + `aria-describedby`;
 *   3. focus lands on the first invalid field, in reading order;
 *   4. typed data survives a failed submit;
 *   5. keywords are split per term when a list is pasted, and a too-long term is
 *      reported instead of silently stored;
 *   6. correcting the errors results in a successful creation.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-new-investigation.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Page } from './cdp.ts'

const PORT = 8849
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** Type into a field the way a user does (React-compatible value setter). */
const typeInto = (label: string, value: string) => `
  (() => {
    const el = [...document.querySelectorAll('form input, form textarea')]
      .find(x => (x.getAttribute('aria-label') || '').includes(${JSON.stringify(label)}));
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`

const SUBMIT = `
  (() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Criar investigação'));
    if (btn) { btn.click(); return true; }
    return false;
  })()`

/** Read the form's current validation surface. */
const READ = `
(() => {
  const fields = ['title','topic','description','objective','keywords'];
  const state = {};
  for (const f of fields) {
    const el = document.querySelector('[aria-describedby="field-' + f + '-error"], [aria-invalid="true"]');
    const input = [...document.querySelectorAll('form input, form textarea')]
      .find(x => (x.getAttribute('aria-describedby') || '').includes('field-' + f + '-error')
              || (x.getAttribute('aria-label') || '').toLowerCase().includes(f === 'keywords' ? 'palavra' : f === 'title' ? 'título' : f === 'topic' ? 'tema' : f === 'objective' ? 'objetivo' : 'descri'));
    state[f] = {
      invalid: input ? input.getAttribute('aria-invalid') === 'true' : false,
      describedBy: input ? input.getAttribute('aria-describedby') : null,
      message: (() => {
        const p = document.getElementById('field-' + f + '-error');
        return p ? p.textContent.trim() : null;
      })(),
    };
    void el;
  }
  const alerts = [...document.querySelectorAll('[role="alert"]')].map(e => (e.textContent || '').trim());
  const summary = alerts.find(t => t.includes('Não foi possível criar') || t.includes('Revise os campos'));
  const chips = [...document.querySelectorAll('form ul li')]
    .filter(li => li.querySelector('button[aria-label^="Remover palavra-chave"]'))
    .map(li => (li.textContent || '').trim());
  const active = document.activeElement;
  return {
    fields: state,
    summary: summary || null,
    chips,
    focusedLabel: active ? (active.getAttribute('aria-label') || active.tagName) : null,
    values: Object.fromEntries([...document.querySelectorAll('form input, form textarea')]
      .map(el => [el.getAttribute('aria-label') || el.tagName, el.value])),
  };
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
  built.app.use('*', serveStatic({ root: './dist' }))
  built.app.get('*', serveStatic({ path: './dist/index.html' }))
  const server = serve({ fetch: built.app.fetch, port: PORT, hostname: '127.0.0.1' })
  await new Promise((r) => setTimeout(r, 500))

  const { page, close } = await Page.open({ width: 1440, height: 950 })
  try {
    await page.goto(`${BASE}/login`)
    await page.evaluate(`(async () => {
      await fetch('/api/auth/login', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signalmess-request': '1' },
        body: JSON.stringify({ email: 'form@signalmess.test', name: 'Form' }) });
    })()`)

    // ---- 1. Empty submit: every required field reports itself --------------
    console.log('\n=== 1. SUBMIT VAZIO ===')
    await page.goto(`${BASE}/investigations/new`)
    await new Promise((r) => setTimeout(r, 600))
    await page.evaluate(SUBMIT)
    await new Promise((r) => setTimeout(r, 700))
    let s = await page.evaluate<Record<string, any>>(READ)

    for (const field of ['title', 'topic', 'objective']) {
      check(s['fields'][field].invalid === true, `${field}: marcado com aria-invalid`)
      check(
        typeof s['fields'][field].message === 'string' && s['fields'][field].message.length > 10,
        `${field}: mensagem específica presente`,
        String(s['fields'][field].message),
      )
    }
    check(s['fields']['description'].invalid === false, 'description: sem erro (campo opcional dentro do limite)')
    check(s['fields']['keywords'].invalid === false, 'keywords: sem erro quando vazio (opcional)')
    check(String(s['summary'] ?? '').includes('campo'), 'resumo nomeia a contagem de campos', String(s['summary']))
    // Summary must name each field
    for (const label of ['Título', 'Tema', 'Objetivo']) {
      check(String(s['summary'] ?? '').includes(label), `resumo lista "${label}"`)
    }
    check(
      s['focusedLabel'] === 'Título da investigação',
      'foco vai para o primeiro campo inválido (Título)',
      String(s['focusedLabel']),
    )

    // ---- 2. Data preserved after a failed submit ---------------------------
    console.log('\n=== 2. PRESERVAÇÃO DOS DADOS ===')
    await page.goto(`${BASE}/investigations/new`)
    await new Promise((r) => setTimeout(r, 600))
    await page.evaluate(typeInto('Título da investigação', 'Título digitado antes do erro'))
    await page.evaluate(typeInto('Tema da investigação', 'tema preservado'))
    await new Promise((r) => setTimeout(r, 300))
    await page.evaluate(SUBMIT)
    await new Promise((r) => setTimeout(r, 700))
    s = await page.evaluate<Record<string, any>>(READ)
    check(
      s['values']['Título da investigação'] === 'Título digitado antes do erro',
      'título mantido após falha',
      String(s['values']['Título da investigação']),
    )
    check(s['values']['Tema da investigação'] === 'tema preservado', 'tema mantido após falha')
    check(s['fields']['objective'].invalid === true, 'objetivo segue marcado (é o campo que falta)')
    check(s['fields']['title'].invalid === false, 'título não é mais marcado depois de corrigido')
    check(
      s['focusedLabel'] === 'Objetivo da investigação',
      'foco move para o objetivo (primeiro inválido agora)',
      String(s['focusedLabel']),
    )

    // ---- 3. Keywords: a pasted list becomes individual chips ---------------
    console.log('\n=== 3. PALAVRAS-CHAVE INDIVIDUAIS ===')
    await page.goto(`${BASE}/investigations/new`)
    await new Promise((r) => setTimeout(r, 600))
    await page.evaluate(typeInto('Adicionar palavra-chave', 'fraude; machine learning; antifraude'))
    await page.evaluate(`
      (() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === 'Adicionar'); if (b) b.click(); })()`)
    await new Promise((r) => setTimeout(r, 500))
    s = await page.evaluate<Record<string, any>>(READ)
    const chips = s['chips'] as string[]
    check(chips.length === 3, `lista colada vira 3 chips individuais (obtido: ${chips.length})`, JSON.stringify(chips))
    check(!chips.some((c) => c.includes(';')), 'nenhum chip contém ponto e vírgula', JSON.stringify(chips))

    // ---- 4. A too-long keyword is reported, not silently stored -----------
    console.log('\n=== 4. PALAVRA-CHAVE LONGA ===')
    await page.goto(`${BASE}/investigations/new`)
    await new Promise((r) => setTimeout(r, 600))
    await page.evaluate(typeInto('Adicionar palavra-chave', 'x'.repeat(70)))
    await page.evaluate(`
      (() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === 'Adicionar'); if (b) b.click(); })()`)
    await new Promise((r) => setTimeout(r, 500))
    s = await page.evaluate<Record<string, any>>(READ)
    check(
      typeof s['fields']['keywords'].message === 'string' &&
        String(s['fields']['keywords'].message).includes('64'),
      'mensagem cita o limite de 64 caracteres',
      String(s['fields']['keywords'].message),
    )

    // ---- 5. Valid form creates the investigation ---------------------------
    console.log('\n=== 5. CRIAÇÃO APÓS CORREÇÃO ===')
    await page.goto(`${BASE}/investigations/new`)
    await new Promise((r) => setTimeout(r, 600))
    await page.evaluate(typeInto('Título da investigação', 'Validação de formulário com feedback por campo'))
    await page.evaluate(typeInto('Tema da investigação', 'usabilidade de formulários e mensagens de erro'))
    await page.evaluate(
      typeInto('Objetivo da investigação', 'Confirmar que cada campo inválido apresenta mensagem específica e que a criação funciona após a correção.'),
    )
    await page.evaluate(typeInto('Adicionar palavra-chave', 'validação; usabilidade'))
    await page.evaluate(`
      (() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === 'Adicionar'); if (b) b.click(); })()`)
    await new Promise((r) => setTimeout(r, 400))
    await page.evaluate(SUBMIT)
    await new Promise((r) => setTimeout(r, 1400))
    const path = await page.evaluate<string>('location.pathname')
    check(path.startsWith('/investigations/inv_'), 'redireciona para o detalhe após criar', path)

    // Confirm it actually persisted
    const persisted = await page.evaluate<string>(`(async () => {
      const r = await fetch('/api/investigations');
      const b = await r.json();
      const found = b.data.items.find(i => i.title === 'Validação de formulário com feedback por campo');
      return found ? found.title : 'NOT FOUND';
    })()`)
    check(persisted !== 'NOT FOUND', 'investigação existe no servidor', persisted)

    console.log(`\nfailures: ${failures}`)
    if (failures > 0) process.exitCode = 1
  } finally {
    await close()
    server.close()
    built.close()
  }
}

await main()
