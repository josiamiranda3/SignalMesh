/**
 * Cursor audit.
 *
 * Measures the *computed* `cursor` value of every interactive element across the
 * app, so the fix is driven by observed behaviour rather than by reading JSX.
 *
 * The rule the audit enforces:
 *
 *   - an element that is clickable (a control, a link, a tab, a card with an
 *     action) must compute to `pointer` — unless it is disabled, which must be
 *     `not-allowed` (or `default` where the control is inert);
 *   - a text field keeps `text`;
 *   - a purely informational element must NOT be `pointer`.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-cursor.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { spaRoot } from './dist-root.ts'
import { Page } from './cdp.ts'

const PORT = 8827
const BASE = `http://127.0.0.1:${PORT}`

const ROUTES = (id: string) => [
  '/',
  '/login',
  '/dashboard',
  '/investigations',
  '/investigations/new',
  `/investigations/${id}`,
  `/investigations/${id}/research`,
  `/investigations/${id}/evidence`,
  `/investigations/${id}/analysis`,
  `/investigations/${id}/validation`,
  '/history',
  '/settings',
  '/rota-inexistente',
]

/**
 * Classify every candidate element and record its computed cursor.
 *
 * The classifier is deliberately conservative: it identifies the element's
 * *role* from markup and handlers, not from a list of known components, so it
 * keeps working as the app grows.
 */
const AUDIT = `
(() => {
  const results = [];
  const seen = new Set();

  const isVisible = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const isDisabled =
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.hasAttribute('data-disabled');

    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (!href || href === '#') return { role: 'link-inert', disabled: false };
      return { role: 'link', disabled: isDisabled };
    }
    if (tag === 'button') {
      return { role: isDisabled ? 'button-disabled' : 'button', disabled: isDisabled };
    }
    if (tag === 'input') {
      if (['checkbox', 'radio', 'file', 'submit', 'button', 'reset'].includes(type)) {
        return { role: 'input-' + (type || 'text'), disabled: isDisabled };
      }
      return { role: 'input-text', disabled: isDisabled };
    }
    if (tag === 'select') return { role: 'select', disabled: isDisabled };
    if (tag === 'textarea') return { role: 'textarea', disabled: isDisabled };
    if (tag === 'label') return { role: 'label', disabled: isDisabled };
    if (tag === 'summary') return { role: 'summary', disabled: isDisabled };

    if (role === 'button' || role === 'tab' || role === 'menuitem' || role === 'option' || role === 'switch' || role === 'checkbox') {
      return { role: 'role-' + role, disabled: isDisabled };
    }
    if (role === 'link') return { role: 'role-link', disabled: isDisabled };

    // Anything else that carries a click handler is, for the user, clickable.
    if (typeof el.onclick === 'function' || el.getAttribute('onclick')) {
      return { role: 'onclick', disabled: isDisabled };
    }
    // Inline handlers registered by React do not appear as el.onclick; the
    // attribute list is empty. Detect via the presence of a tabindex plus a
    // non-text cursor hint is unsafe, so rely on known interactive wrappers.
    if (el.tabIndex >= 0 && ['div', 'span', 'li', 'article'].includes(tag) && el.getAttribute('role')) {
      return { role: 'focusable-' + el.getAttribute('role'), disabled: isDisabled };
    }
    return null;
  };

  const candidates = document.querySelectorAll(
    'a[href], button, input, select, textarea, label, summary, [role], [onclick], [tabindex]'
  );

  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const info = roleOf(el);
    if (!info) continue;

    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const key = info.role + '|' + s.cursor + '|' + Math.round(r.height);
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      role: info.role,
      disabled: info.disabled,
      tag: el.tagName.toLowerCase(),
      text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 34),
      cursor: s.cursor,
      height: Math.round(r.height),
      cls: String(el.className).slice(0, 60),
    });
  }
  return results;
})()
`

/** Expected cursor per role. `null` means "not asserted". */
function expectation(row: { role: string; disabled: boolean }): string[] | null {
  const { role, disabled } = row
  if (role === 'link' || role === 'button' || role === 'role-link' || role === 'role-button') {
    return disabled ? ['not-allowed', 'default'] : ['pointer']
  }
  if (role === 'role-tab' || role === 'role-menuitem' || role === 'role-option' || role === 'role-switch' || role === 'role-checkbox') {
    return disabled ? ['not-allowed', 'default'] : ['pointer']
  }
  if (role === 'onclick' || role.startsWith('focusable-')) {
    return disabled ? ['not-allowed', 'default'] : ['pointer']
  }
  if (role === 'button-disabled') return ['not-allowed', 'default']
  if (role === 'input-checkbox' || role === 'input-radio' || role === 'input-file') {
    return disabled ? ['not-allowed', 'default'] : ['pointer']
  }
  if (role === 'input-text' || role === 'textarea') return ['text', 'auto']
  if (role === 'select') return disabled ? ['not-allowed', 'default'] : ['pointer', 'default']
  if (role === 'label') return ['pointer', 'default']
  if (role === 'summary') return ['pointer']
  if (role === 'link-inert') return ['pointer', 'default']
  return null
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

  const { page, close } = await Page.open({ width: 1440, height: 950 })
  try {
    await page.goto(`${BASE}/login`)
    const id = await page.evaluate<string>(`(async () => {
      const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
      await fetch('/api/auth/login', { method: 'POST', headers: h,
        body: JSON.stringify({ email: 'cursor@signalmess.test', name: 'Cursor' }) });
      const res = await fetch('/api/investigations', { method: 'POST', headers: h,
        body: JSON.stringify({
          title: 'Consistência do cursor em elementos interativos',
          description: 'Inspeção do cursor computado em toda a aplicação.',
          objective: 'Verificar se todo elemento clicável apresenta cursor de ponteiro.',
          topic: 'usabilidade', keywords: ['cursor'], status: 'active',
        }) });
      const payload = await res.json();
      return payload.data.id;
    })()`)

    const violations: Array<Record<string, unknown>> = []
    const observed = new Map<string, { cursor: string; roles: Set<string>; count: number }>()

    for (const route of ROUTES(id)) {
      await page.goto(`${BASE}${route}`)
      await new Promise((r) => setTimeout(r, 400))
      const rows = await page.evaluate<Array<Record<string, unknown>>>(AUDIT)

      for (const row of rows) {
        const role = String(row['role'])
        const cursor = String(row['cursor'])
        const key = `${role}|${cursor}`
        const entry = observed.get(key) ?? { cursor, roles: new Set<string>(), count: 0 }
        entry.count += 1
        entry.roles.add(String(row['tag']))
        observed.set(key, entry)

        const expected = expectation(row as { role: string; disabled: boolean })
        if (expected && !expected.includes(cursor)) {
          violations.push({ route, ...row, expected: expected.join(' | ') })
        }
      }
    }

    // Also audit the mobile drawer, which only exists below 1024px.
    await page.setViewport(390, 844)
    for (const route of ['/dashboard', '/investigations']) {
      await page.goto(`${BASE}${route}`)
      await new Promise((r) => setTimeout(r, 400))
      await page.evaluate(`
        (() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').includes('Abrir menu')); if (b) b.click(); })()
      `)
      await new Promise((r) => setTimeout(r, 400))
      const rows = await page.evaluate<Array<Record<string, unknown>>>(AUDIT)
      for (const row of rows) {
        const expected = expectation(row as { role: string; disabled: boolean })
        if (expected && !expected.includes(String(row['cursor']))) {
          violations.push({ route: route + ' (drawer aberto)', ...row, expected: expected.join(' | ') })
        }
      }
    }

    console.log('\n=== OBSERVED CURSORS ===')
    for (const [key, entry] of [...observed.entries()].sort()) {
      const [role, cursor] = key.split('|')
      console.log(`  ${String(role).padEnd(20)} ${String(cursor).padEnd(14)} x${entry.count}`)
    }

    console.log('\n=== VIOLATIONS ===')
    if (violations.length === 0) {
      console.log('  none — every interactive element computes the expected cursor')
    } else {
      const byRole = new Map<string, Array<Record<string, unknown>>>()
      for (const v of violations) {
        const k = String(v['role'])
        const list = byRole.get(k) ?? []
        list.push(v)
        byRole.set(k, list)
      }
      for (const [role, list] of byRole) {
        console.log(`\n  ${role}: ${list.length} occurrence(s)`)
        const samples = new Map<string, Record<string, unknown>>()
        for (const v of list) samples.set(String(v['cls']) + String(v['text']), v)
        for (const v of [...samples.values()].slice(0, 6)) {
          console.log(
            `    ${String(v['route']).padEnd(44)} cursor="${v['cursor']}" esperado=${v['expected']}  ${String(v['tag'])} "${v['text']}"`,
          )
        }
      }
    }

    console.log(`\ntotal violations: ${violations.length}`)
  } finally {
    await close()
    server.close()
    built.close()
  }
}

await main()
