/**
 * Edit modal: keyword editing, end to end in the browser.
 *
 * Covers the full checklist: load, add, edit, remove, save, reload, save
 * without changes, the 20-term limit, an investigation with no keywords, the
 * other fields still working, and evidence/analysis surviving a metadata edit.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-edit-keywords.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Page } from './cdp.ts'

const PORT = 8855
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const OPEN_EDIT = `
(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Editar');
  if (b) { b.click(); return true; }
  return false;
})()`

/** Read the keyword chips inside the open modal. */
const READ_CHIPS = `
(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return { open: false, chips: [] };
  const chips = [...dialog.querySelectorAll('li')]
    .filter(li => li.querySelector('button[aria-label^="Remover palavra-chave"]'))
    .map(li => (li.textContent || '').trim());
  const counter = [...dialog.querySelectorAll('p')]
    .map(p => (p.textContent || '').trim())
    .find(t => /^[0-9]+ de 20 termos/.test(t));
  return { open: true, chips, counter: counter || null };
})()`

const TYPE_KEYWORD = (value: string) => `
  (() => {
    const dialog = document.querySelector('[role="dialog"]');
    const el = dialog && [...dialog.querySelectorAll('input')]
      .find(x => (x.getAttribute('aria-label') || '').includes('Adicionar palavra-chave'));
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const add = [...dialog.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Adicionar');
    if (add) add.click();
    return true;
  })()`

const SAVE = `
(() => {
  const dialog = document.querySelector('[role="dialog"]');
  const b = dialog && [...dialog.querySelectorAll('button')].find(x => (x.textContent || '').includes('Salvar alterações'));
  if (b) { b.click(); return true; }
  return false;
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
  built.app.use('*', serveStatic({ root: './dist' }))
  built.app.get('*', serveStatic({ path: './dist/index.html' }))
  const server = serve({ fetch: built.app.fetch, port: PORT, hostname: '127.0.0.1' })
  await new Promise((r) => setTimeout(r, 500))

  const { page, close } = await Page.open({ width: 1440, height: 1000 })
  try {
    await page.goto(`${BASE}/login`)
    const seed = await page.evaluate<{ id: string; emptyId: string }>(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      await fetch('/api/auth/login', { method: 'POST', headers: h,
        body: JSON.stringify({ email: 'edit@signalmess.test', name: 'Edit' }) });

      const make = async (body) => {
        const r = await fetch('/api/investigations', { method: 'POST', headers: h, body: JSON.stringify(body) });
        const p = await r.json();
        if (!p.success) throw new Error(JSON.stringify(p));
        return p.data.id;
      };

      const withKw = await make({
        title: 'Investigação com palavras-chave existentes',
        description: 'Descrição original preservada durante a edição.',
        objective: 'Verificar se o modal carrega, edita, adiciona e remove palavras-chave corretamente.',
        topic: 'edição de metadados',
        keywords: ['fraude', 'machine learning', 'antifraude'],
        status: 'active',
      });
      const noKw = await make({
        title: 'Investigação sem palavras-chave',
        description: 'Sem termos.',
        objective: 'Verificar o estado vazio do editor de palavras-chave no modal.',
        topic: 'estado vazio',
        keywords: [],
        status: 'draft',
      });
      return { id: withKw, emptyId: noKw };
    })()`)
    const { id, emptyId } = seed

    // Add one evidence item so we can prove it survives a metadata edit.
    await page.evaluate(`(async () => {
      await fetch('/api/investigations/${id}/evidence', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signalmess-request': '1' },
        body: JSON.stringify({ source: {
          title: 'Fonte de teste para verificar preservação',
          url: 'https://example.org/fonte-preservada',
          domain: 'example.org',
          snippet: 'Trecho de teste.',
        } }),
      });
    })()`)

    // ---- 1. Load existing keywords individually ---------------------------
    console.log('\n=== 1. CARREGAR PALAVRAS-CHAVE EXISTENTES ===')
    await page.goto(`${BASE}/investigations/${id}`)
    await new Promise((r) => setTimeout(r, 700))
    await page.evaluate(OPEN_EDIT)
    await new Promise((r) => setTimeout(r, 500))
    let s = await page.evaluate<Record<string, any>>(READ_CHIPS)
    check(s['open'] === true, 'modal abriu')
    check(
      JSON.stringify(s['chips']) === JSON.stringify(['fraude', 'machine learning', 'antifraude']),
      '3 termos carregados individualmente',
      JSON.stringify(s['chips']),
    )

    // ---- 2. Add a term ----------------------------------------------------
    console.log('\n=== 2. ADICIONAR TERMO ===')
    await page.evaluate(TYPE_KEYWORD('regulação'))
    await new Promise((r) => setTimeout(r, 400))
    s = await page.evaluate<Record<string, any>>(READ_CHIPS)
    check((s['chips'] as string[]).includes('regulação'), 'termo adicionado', JSON.stringify(s['chips']))
    check((s['chips'] as string[]).length === 4, 'total 4 termos')

    // ---- 3. Remove a term -------------------------------------------------
    console.log('\n=== 3. REMOVER TERMO ===')
    await page.evaluate(`
      (() => {
        const b = [...document.querySelectorAll('[role="dialog"] button')]
          .find(x => (x.getAttribute('aria-label') || '') === 'Remover palavra-chave antifraude');
        if (b) b.click();
      })()`)
    await new Promise((r) => setTimeout(r, 400))
    s = await page.evaluate<Record<string, any>>(READ_CHIPS)
    check(!(s['chips'] as string[]).includes('antifraude'), 'termo removido', JSON.stringify(s['chips']))

    // ---- 4. Edit a term in place -----------------------------------------
    console.log('\n=== 4. EDITAR TERMO EXISTENTE ===')
    await page.evaluate(`
      (() => {
        const b = [...document.querySelectorAll('[role="dialog"] button')]
          .find(x => (x.getAttribute('aria-label') || '') === 'Editar palavra-chave fraude');
        if (b) b.click();
      })()`)
    await new Promise((r) => setTimeout(r, 350))
    const editing = await page.evaluate<Record<string, any>>(`
      (() => {
        const dialog = document.querySelector('[role="dialog"]');
        const el = dialog && dialog.querySelector('input[aria-label^="Editar palavra-chave"]');
        if (!el) return { found: false };
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'fraude financeira');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return { found: true };
      })()`)
    check(editing['found'] === true, 'campo de edição do termo abriu')
    await new Promise((r) => setTimeout(r, 500))
    s = await page.evaluate<Record<string, any>>(READ_CHIPS)
    check(
      (s['chips'] as string[]).includes('fraude financeira') && !(s['chips'] as string[]).includes('fraude'),
      'termo editado no lugar (fraude -> fraude financeira)',
      JSON.stringify(s['chips']),
    )

    // ---- 5. Save and verify persistence on the server ---------------------
    console.log('\n=== 5. SALVAR E PERSISTIR ===')
    await page.evaluate(SAVE)
    await new Promise((r) => setTimeout(r, 1200))
    let server = await page.evaluate<Record<string, any>>(`(async () => {
      const r = await fetch('/api/investigations/${id}');
      const b = await r.json();
      return { keywords: b.data.investigation.keywords, title: b.data.investigation.title,
               evidence: b.data.evidence.length, analyses: b.data.analyses.length };
    })()`)
    check(
      JSON.stringify(server['keywords']) === JSON.stringify(['fraude financeira', 'machine learning', 'regulação']),
      'servidor persistiu a lista editada',
      JSON.stringify(server['keywords']),
    )
    check(Number(server['evidence']) === 1, 'evidência preservada após editar metadados', String(server['evidence']))

    // ---- 6. Reload the page ----------------------------------------------
    console.log('\n=== 6. RECARREGAR A PÁGINA ===')
    await page.goto(`${BASE}/investigations/${id}`)
    await new Promise((r) => setTimeout(r, 750))
    await page.evaluate(OPEN_EDIT)
    await new Promise((r) => setTimeout(r, 500))
    s = await page.evaluate<Record<string, any>>(READ_CHIPS)
    check(
      JSON.stringify(s['chips']) === JSON.stringify(['fraude financeira', 'machine learning', 'regulação']),
      'termos corretos após reload',
      JSON.stringify(s['chips']),
    )

    // ---- 7. Save without touching keywords --------------------------------
    console.log('\n=== 7. SALVAR SEM ALTERAR PALAVRAS-CHAVE ===')
    await page.evaluate(`
      (() => {
        const dialog = document.querySelector('[role="dialog"]');
        const el = dialog && [...dialog.querySelectorAll('input')]
          .find(x => (x.getAttribute('aria-label') || '').includes('Título'));
        if (!el) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Título alterado sem tocar nas palavras-chave');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`)
    await new Promise((r) => setTimeout(r, 300))
    await page.evaluate(SAVE)
    await new Promise((r) => setTimeout(r, 1200))
    server = await page.evaluate<Record<string, any>>(`(async () => {
      const r = await fetch('/api/investigations/${id}');
      const b = await r.json();
      return { keywords: b.data.investigation.keywords, title: b.data.investigation.title };
    })()`)
    check(
      JSON.stringify(server['keywords']) === JSON.stringify(['fraude financeira', 'machine learning', 'regulação']),
      'palavras-chave preservadas quando não editadas',
      JSON.stringify(server['keywords']),
    )
    check(
      String(server['title']).includes('Título alterado'),
      'título atualizado junto',
      String(server['title']),
    )

    // ---- 8. Investigation with no keywords --------------------------------
    console.log('\n=== 8. INVESTIGAÇÃO SEM PALAVRAS-CHAVE ===')
    await page.goto(`${BASE}/investigations/${emptyId}`)
    await new Promise((r) => setTimeout(r, 700))
    await page.evaluate(OPEN_EDIT)
    await new Promise((r) => setTimeout(r, 500))
    s = await page.evaluate<Record<string, any>>(READ_CHIPS)
    check(s['open'] === true && (s['chips'] as string[]).length === 0, 'abre com lista vazia', JSON.stringify(s['chips']))
    const emptyMsg = await page.evaluate<boolean>(`
      (() => {
        const d = document.querySelector('[role="dialog"]');
        return [...(d ? d.querySelectorAll('p') : [])].some(p => (p.textContent || '').includes('Nenhuma palavra-chave'));
      })()`)
    check(emptyMsg, 'mostra o estado vazio')
    await page.evaluate(TYPE_KEYWORD('primeiro termo'))
    await new Promise((r) => setTimeout(r, 400))
    await page.evaluate(SAVE)
    await new Promise((r) => setTimeout(r, 1200))
    server = await page.evaluate<Record<string, any>>(`(async () => {
      const r = await fetch('/api/investigations/${emptyId}');
      const b = await r.json();
      return { keywords: b.data.investigation.keywords };
    })()`)
    check(
      JSON.stringify(server['keywords']) === JSON.stringify(['primeiro termo']),
      'adiciona o primeiro termo a uma investigação sem palavras-chave',
      JSON.stringify(server['keywords']),
    )

    // ---- 9. The 20-term limit --------------------------------------------
    console.log('\n=== 9. LIMITE DE 20 TERMOS ===')
    await page.goto(`${BASE}/investigations/${emptyId}`)
    await new Promise((r) => setTimeout(r, 700))
    await page.evaluate(OPEN_EDIT)
    await new Promise((r) => setTimeout(r, 500))
    // Paste a list of 25 terms: the editor must accept exactly 20.
    await page.evaluate(TYPE_KEYWORD(Array.from({ length: 24 }, (_, i) => `termo${i}`).join('; ')))
    await new Promise((r) => setTimeout(r, 500))
    s = await page.evaluate<Record<string, any>>(READ_CHIPS)
    check((s['chips'] as string[]).length === 20, `para em 20 termos (obtido: ${(s['chips'] as string[]).length})`, String(s['counter']))

    console.log(`\nfailures: ${failures}`)
    if (failures > 0) process.exitCode = 1
  } finally {
    await close()
    server.close()
    built.close()
  }
}

await main()
