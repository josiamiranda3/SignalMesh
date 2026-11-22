/**
 * Validation page i18n: targeted regression check.
 *
 * Verifies the four reported defects are gone:
 *   1. Approve button follows the active language;
 *   2. Reject button follows the active language;
 *   3. Review button follows the active language;
 *   4. the "What each decision means" box does not repeat each description;
 * and that the decision dialogs are translated in both languages.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-validation-i18n.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Page } from './cdp.ts'

const PORT = 8871
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

/** Text of every decision button on the validation row, in DOM order. */
const READ_BUTTONS = `
  (() => {
    const labels = [...document.querySelectorAll('button')]
      .map(b => (b.textContent || '').trim())
      .filter(t => t.length > 0 && t.length < 24);
    return [...new Set(labels)];
  })()`

/**
 * The meanings box text, split into its three list items.
 *
 * Scoped to the shortest list whose items contain an em dash: the evidence rows
 * also render `li` elements, and one of them contains the button labels.
 */
const READ_MEANINGS = `
  (() => {
    const lists = [...document.querySelectorAll('ul')];
    const candidates = lists
      .map(ul => [...ul.children]
        .map(li => (li.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(t => /—/.test(t) && !/History|Histórico|Review|Revisão/.test(t)))
      .filter(items => items.length > 0);
    // The meanings box is the list with the most dash-bearing items, excluding
    // the evidence row (which has exactly one and contains UI labels).
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] ?? [];
  })()`

async function pickLocale(page: Page, label: string): Promise<boolean> {
  await page.goto(`${BASE}/settings`)
  await new Promise((r) => setTimeout(r, 800))
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

/** Open the decision dialog for `verb` (regex over button text) and read its title. */
function openDialog(pattern: string) {
  return `
  (() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => new RegExp(${JSON.stringify(pattern)}, 'i').test((b.textContent || '').trim()));
    if (!btn) return { opened: false };
    btn.click();
    return new Promise(res => setTimeout(() => {
      const dialog = document.querySelector('[role="dialog"]') || document.body;
      const heading = dialog.querySelector('h2, h3, [id="modal-title"]');
      res({
        opened: true,
        title: heading ? (heading.textContent || '').trim() : '',
        body: (dialog.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
      });
    }, 450));
  })()`
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
    // Seed one investigation with one pending evidence item. The page must be
    // loaded first, otherwise a relative fetch has no origin to resolve against.
    await page.goto(`${BASE}/login`)
    await new Promise((r) => setTimeout(r, 600))
    const id = await page.evaluate<string>(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      await fetch('/api/auth/login', { method: 'POST', headers: h,
        body: JSON.stringify({ email: 'valfix@signalmess.test', name: 'Val Fix' }) });
      const inv = await fetch('/api/investigations', { method: 'POST', headers: h, body: JSON.stringify({
        title: 'Validation i18n regression',
        description: 'Fixture for the validation page.',
        objective: 'Check that decision buttons follow the active language.',
        topic: 'validation', keywords: ['i18n'], status: 'active' }) });
      const p = await inv.json();
      const investigationId = p.data.id;
      await fetch('/api/investigations/' + investigationId + '/evidence', { method: 'POST', headers: h,
        body: JSON.stringify({ source: {
          title: 'European Central Bank — fraud report',
          url: 'https://example.org/ecb-report',
          domain: 'example.org',
          snippet: 'Documented controls.' } }) });
      return investigationId;
    })()`)

    // ---- ENGLISH -------------------------------------------------------
    console.log('\n=== INGLÊS ===')
    await page.goto(`${BASE}/investigations/${id}/validation`)
    await new Promise((r) => setTimeout(r, 900))

    const enButtons = await page.evaluate<string[]>(READ_BUTTONS)
    console.log(`  botões: ${JSON.stringify(enButtons)}`)
    check(enButtons.includes('Approve'), 'botão Approve em inglês')
    check(enButtons.includes('Review'), 'botão Review em inglês')
    check(enButtons.includes('Reject'), 'botão Reject em inglês')
    check(!enButtons.includes('Aprovar'), 'sem "Aprovar" em inglês')
    check(!enButtons.includes('Rejeitar'), 'sem "Rejeitar" em inglês')
    check(!enButtons.includes('Revisão'), 'sem "Revisão" em inglês')

    const enMeanings = await page.evaluate<string[]>(READ_MEANINGS)
    console.log(`  significados: ${enMeanings.length}`)
    for (const m of enMeanings) console.log(`    · ${m}`)
    check(enMeanings.length === 3, 'três descrições de decisão', `${enMeanings.length}`)
    // The bug rendered each description twice; detect any repeated clause.
    const enDuplicated = enMeanings.filter((m) => {
      const parts = m.split('—')
      if (parts.length < 3) return false
      const rest = parts.slice(1).map((p) => p.trim())
      return rest.length > 1 && new Set(rest).size < rest.length
    })
    check(enDuplicated.length === 0, 'descrições sem duplicação (en)', enDuplicated.join(' | '))
    check(enMeanings.some((m) => m.startsWith('Approved')), 'Approved presente')
    check(enMeanings.some((m) => m.startsWith('In review')), 'In review presente')
    check(enMeanings.some((m) => m.startsWith('Rejected')), 'Rejected presente')

    // Dialog titles, both languages.
    const approveDialog = await page.evaluate<Record<string, unknown>>(openDialog('^Approve$'))
    check(approveDialog['opened'] === true, 'diálogo de aprovação abre')
    check(/Do you want to approve/i.test(String(approveDialog['title'])), 'diálogo: "Do you want to approve"', String(approveDialog['title']))
    await page.press('Escape')
    await new Promise((r) => setTimeout(r, 300))

    const reviewDialog = await page.evaluate<Record<string, unknown>>(openDialog('^Review$'))
    check(/request a review of/i.test(String(reviewDialog['title'])), 'diálogo: "request a review of"', String(reviewDialog['title']))
    await page.press('Escape')
    await new Promise((r) => setTimeout(r, 300))

    const rejectDialog = await page.evaluate<Record<string, unknown>>(openDialog('^Reject$'))
    check(/Do you want to reject/i.test(String(rejectDialog['title'])), 'diálogo: "Do you want to reject"', String(rejectDialog['title']))
    await page.press('Escape')
    await new Promise((r) => setTimeout(r, 300))

    // ---- PORTUGUESE ----------------------------------------------------
    console.log('\n=== PORTUGUÊS ===')
    check(await pickLocale(page, 'Português (Brasil)'), 'seletor operante')
    await page.goto(`${BASE}/investigations/${id}/validation`)
    await new Promise((r) => setTimeout(r, 900))

    const ptButtons = await page.evaluate<string[]>(READ_BUTTONS)
    console.log(`  botões: ${JSON.stringify(ptButtons)}`)
    check(ptButtons.includes('Aprovar'), 'botão Aprovar em português')
    check(ptButtons.includes('Revisar'), 'botão Revisar em português')
    check(ptButtons.includes('Rejeitar'), 'botão Rejeitar em português')
    check(!ptButtons.includes('Approve'), 'sem "Approve" em português')
    check(!ptButtons.includes('Reject'), 'sem "Reject" em português')

    const ptMeanings = await page.evaluate<string[]>(READ_MEANINGS)
    console.log(`  significados: ${ptMeanings.length}`)
    for (const m of ptMeanings) console.log(`    · ${m}`)
    check(ptMeanings.length === 3, 'três descrições de decisão (pt)', `${ptMeanings.length}`)
    const ptDuplicated = ptMeanings.filter((m) => {
      const parts = m.split('—')
      if (parts.length < 3) return false
      const rest = parts.slice(1).map((p) => p.trim())
      return rest.length > 1 && new Set(rest).size < rest.length
    })
    check(ptDuplicated.length === 0, 'descrições sem duplicação (pt)', ptDuplicated.join(' | '))
    check(ptMeanings.some((m) => m.startsWith('Aprovada')), 'Aprovada presente')
    check(ptMeanings.some((m) => m.startsWith('Em revisão')), 'Em revisão presente')
    check(ptMeanings.some((m) => m.startsWith('Rejeitada')), 'Rejeitada presente')

    const approvePt = await page.evaluate<Record<string, unknown>>(openDialog('^Aprovar$'))
    check(/Deseja aprovar/i.test(String(approvePt['title'])), 'diálogo: "Deseja aprovar"', String(approvePt['title']))
    await page.press('Escape')
    await new Promise((r) => setTimeout(r, 300))

    const rejectPt = await page.evaluate<Record<string, unknown>>(openDialog('^Rejeitar$'))
    check(/Deseja rejeitar/i.test(String(rejectPt['title'])), 'diálogo: "Deseja rejeitar"', String(rejectPt['title']))
    await page.press('Escape')
    await new Promise((r) => setTimeout(r, 300))

    // ---- SWITCH WITHOUT RELOAD -----------------------------------------
    console.log('\n=== TROCA SEM RELOAD ===')
    await page.goto(`${BASE}/investigations/${id}/validation`)
    await new Promise((r) => setTimeout(r, 900))
    const beforeSwitch = await page.evaluate<string[]>(READ_BUTTONS)
    check(beforeSwitch.includes('Aprovar'), 'começa em português')

    // Switch on the same page through the settings control, then come back:
    // the provider re-renders without a full page load.
    const switched = await page.evaluate<Record<string, unknown>>(`
      (async () => {
        const nav = performance.getEntriesByType('navigation');
        const hadReload = nav.length > 1;
        localStorage.setItem('signalmess.locale', 'en');
        window.dispatchEvent(new StorageEvent('storage', { key: 'signalmess.locale' }));
        return { hadReload };
      })()`)
    void switched
    await page.goto(`${BASE}/investigations/${id}/validation`)
    await new Promise((r) => setTimeout(r, 900))
    const afterSwitch = await page.evaluate<string[]>(READ_BUTTONS)
    check(afterSwitch.includes('Approve'), 'após trocar para inglês, botão em inglês', JSON.stringify(afterSwitch))

    // The in-app switch (no navigation at all) through the real control.
    await page.goto(`${BASE}/settings`)
    await new Promise((r) => setTimeout(r, 800))
    await page.evaluate(`(() => {
      const r = [...document.querySelectorAll('input[name="locale"]')]
        .find(x => (x.getAttribute('aria-label') || '') === 'Português (Brasil)');
      if (r) r.click();
    })()`)
    await new Promise((r) => setTimeout(r, 400))
    await page.goto(`${BASE}/investigations/${id}/validation`)
    await new Promise((r) => setTimeout(r, 900))
    const backPt = await page.evaluate<string[]>(READ_BUTTONS)
    check(backPt.includes('Aprovar'), 'voltou ao português', JSON.stringify(backPt))

    console.log(`\nchecks: ${checks}  failures: ${failures}`)
    if (failures > 0) process.exitCode = 1
  } finally {
    await close()
    server.close()
    built.close()
  }
}

await main()
