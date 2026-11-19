/**
 * Supplementary browser checks for flows the main E2E does not cover:
 * editing through the modal, archiving, deleting, evidence notes, filtering,
 * search, sorting, the global validation queue, and the demo-seed path.
 *
 *   node --experimental-transform-types tests/e2e/run-flows.ts
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { buildApp } from '../../server/app.ts'
import { Page } from './cdp.ts'

let failures = 0
let checks = 0

function check(condition: boolean, label: string, detail = ''): void {
  checks += 1
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const url = request.url ?? ''
      if (url.startsWith('/search')) {
        const results = [
          {
            id: 'https://example.org/a',
            title: 'Primeira fonte sobre antifraude com aprendizado de máquina',
            url: 'https://example.org/a',
            publishedDate: '2024-05-01T00:00:00.000Z',
            author: 'Pesquisador A',
            text: 'Conteúdo da primeira fonte sobre fraude e antifraude.',
            highlights: ['destaque A'],
          },
          {
            id: 'https://example.org/b',
            title: 'Segunda fonte sobre regulação de crédito',
            url: 'https://example.org/b',
            publishedDate: '2023-02-01T00:00:00.000Z',
            author: null,
            highlights: ['destaque B'],
          },
          {
            id: 'https://example.org/c',
            title: 'Terceira fonte sem data de publicação',
            url: 'https://example.org/c',
            publishedDate: null,
            author: null,
          },
        ]
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ requestId: 'req_flows', results }))
        return
      }
      response.writeHead(404).end('{}')
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const providerPort = (provider.address() as AddressInfo).port

  const port = 8812
  const base = `http://127.0.0.1:${port}`
  const built = await buildApp({
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: ':memory:',
      PORT: String(port),
      APP_ORIGIN: base,
      EXA_API_KEY: 'flows-key',
      EXA_BASE_URL: `http://127.0.0.1:${providerPort}`,
      ENABLE_EXTERNAL_APIS: 'true',
      RESEARCH_DAILY_LIMIT: '20',
      DUPLICATE_GUARD_SECONDS: '0',
      SEED_DEMO_DATA: 'true',
    },
  })
  built.app.use('*', serveStatic({ root: './dist' }))
  built.app.get('*', serveStatic({ path: './dist/index.html' }))
  const server = serve({ fetch: built.app.fetch, port, hostname: '127.0.0.1' })
  await new Promise((resolve) => setTimeout(resolve, 400))

  const { page, close } = await Page.open({ width: 1440, height: 950 })
  try {
    console.log('\nA. Dados de demonstração são claramente rotulados')
    await page.goto(`${base}/login`)
    await page.waitForText('Entrar no SignalMesh', 12000)
    await page.fill('input[name="email"]', 'demonstracao@signalmess.local')
    await page.clickText('Entrar', 'button[type="submit"]')
    await page.waitForText('Visão geral', 12000)
    const dashboard = await page.text()
    check(dashboard.includes('[DEMONSTRAÇÃO]'), 'investigação de demo aparece marcada')
    await page.goto(`${base}/investigations`)
    await page.waitForText('[DEMONSTRAÇÃO]', 8000)
    check((await page.text()).includes('[DEMONSTRAÇÃO]'), 'marcação visível na listagem')

    console.log('\nB. Usuário limpo, fluxo de edição e arquivamento')
    await page.evaluate(`
      (async () => {
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-signalmess-request': '1' } });
        await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-signalmess-request': '1' },
          body: JSON.stringify({ email: 'flows@signalmess.test', name: 'Fluxos' }),
        });
      })()
    `)

    const id = await page.evaluate<string>(`
      (async () => {
        const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
        const r = await fetch('/api/investigations', { method: 'POST', headers: h, body: JSON.stringify({
          title: 'Investigação para fluxos',
          description: 'Descrição inicial',
          objective: 'Verificar edição, arquivamento e exclusão nesta investigação de teste',
          topic: 'testes de fluxo', keywords: ['teste'], status: 'active' }) });
        return (await r.json()).data.id;
      })()
    `)

    await page.goto(`${base}/investigations/${id}`)
    await page.waitForText('Objetivo da pesquisa')

    // Edit through the modal.
    await page.clickText('Editar', 'button')
    await page.waitForText('Editar investigação')
    const titleInput = await page.evaluate<boolean>(`
      (() => {
        const modal = document.querySelector('[role="dialog"]');
        const input = modal && modal.querySelector('input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'Investigação editada pelo fluxo');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `)
    check(titleInput, 'modal de edição permite alterar o título')
    await page.clickText('Salvar alterações')
    await page.waitForText('Investigação editada pelo fluxo', 12000)
    check((await page.text()).includes('Investigação editada pelo fluxo'), 'título atualizado na tela')

    // Archive.
    await page.clickText('Arquivar', 'button')
    await page.waitForText('Investigação arquivada', 10000)
    check((await page.text()).includes('Arquivada'), 'status arquivada refletido na interface')

    // Change status back through the select.
    await page.evaluate(`
      (() => {
        const select = document.querySelector('select[aria-label="Alterar status da investigação"]');
        if (!select) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(select, 'active');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `)
    await page.waitForText('Status atualizado', 10000)
    check((await page.text()).includes('Em andamento'), 'status alterado de volta para em andamento')

    console.log('\nC. Adicionar evidências, notas e filtros')
    await page.evaluate(`
      (async () => {
        const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
        const r = await fetch('/api/investigations/${id}/research', { method: 'POST', headers: h, body: JSON.stringify({ numResults: 3 }) });
        const data = await r.json();
        await fetch('/api/investigations/${id}/evidence/bulk', { method: 'POST', headers: h, body: JSON.stringify({
          sources: data.data.results.map((item) => ({
            title: item.title, url: item.url, domain: item.domain, snippet: item.snippet,
            retrievedContent: item.retrievedContent, publishedAt: item.publishedAt, author: item.author,
            providerRequestId: null, contentAvailability: item.contentAvailability,
          })),
        }) });
      })()
    `)

    await page.goto(`${base}/investigations/${id}/evidence`)
    await page.waitForText('Fontes coletadas', 10000)
    const evText = await page.text()
    check(evText.includes('Primeira fonte'), 'três evidências listadas')
    check(evText.includes('sem data de publicação'), 'ausência de data é declarada')

    // Note.
    await page.clickText('Adicionar observação', 'button')
    await page.waitForText('Observação da evidência')
    await page.fill('textarea[name="note"]', 'Observação de teste automatizado.')
    await page.clickText('Salvar observação')
    await page.waitForText('Observação salva', 10000)
    check((await page.text()).includes('Observação de teste automatizado.'), 'nota persistida e exibida')

    // Filter by status.
    await page.evaluate(`
      (() => {
        const select = document.querySelector('select[aria-label="Filtrar por status de validação"]');
        if (!select) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(select, 'accepted');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `)
    await page.waitForText('Nenhuma evidência corresponde aos filtros', 8000)
    check((await page.text()).includes('Nenhuma evidência corresponde aos filtros'), 'filtro sem resultado mostra estado vazio')

    await page.clickText('Limpar filtros')
    await page.waitForText('Primeira fonte', 8000)
    check((await page.text()).includes('Primeira fonte'), 'limpar filtros restaura a lista')

    // Search.
    await page.fill('input[aria-label="Buscar evidências"]', 'Terceira')
    await page.waitForText('Terceira fonte', 5000)
    const searched = await page.text()
    check(searched.includes('Terceira fonte') && !searched.includes('Primeira fonte'), 'busca filtra por título')

    console.log('\nD. Fila global de validação')
    await page.goto(`${base}/validation`)
    await page.waitForText('Fila de validação', 10000)
    const queue = await page.text()
    check(queue.includes('Pendentes'), 'fila global mostra aba de pendentes')
    check(queue.includes('Primeira fonte'), 'fila global lista evidências de qualquer investigação')
    await page.clickText('Revisão', 'button')
    await page.waitForText('Deseja solicitar revisão')
    await page.fill('textarea[aria-label="Justificativa da decisão"]', 'Precisa de verificação adicional.')
    await page.clickText('Confirmar decisão')
    await page.waitForText('Revisão solicitada', 10000)
    await page.clickText('Em revisão', 'button[role="tab"]')
    await page.waitForText('Precisa de verificação adicional.', 8000)
    check((await page.text()).includes('Precisa de verificação adicional.'), 'justificativa aparece na aba de revisão')

    console.log('\nE. Busca e ordenação de investigações')
    await page.goto(`${base}/investigations`)
    await page.waitForText('Investigações', 8000)
    await page.fill('input[aria-label="Buscar investigações"]', 'inexistente-xyz')
    await page.waitForText('Nenhum resultado com estes filtros', 8000)
    check((await page.text()).includes('Nenhum resultado com estes filtros'), 'busca sem resultado mostra estado próprio')
    await page.clickText('Limpar filtros')
    await page.waitForText('Investigação editada pelo fluxo', 8000)

    console.log('\nF. Exclusão com confirmação')
    await page.goto(`${base}/investigations/${id}`)
    await page.waitForText('Objetivo da pesquisa')
    await page.clickText('Excluir investigação', 'button')
    await page.waitForText('Excluir esta investigação?')
    const deleteModal = await page.text()
    check(deleteModal.includes('não pode ser desfeita'), 'modal de exclusão avisa que é irreversível')
    check(deleteModal.includes('evidência(s)'), 'modal quantifica o que será removido')
    await page.clickText('Excluir definitivamente')
    await page.waitForText('Investigação excluída', 12000)
    check((await page.url()).includes('/investigations'), 'exclusão redireciona para a listagem')

    console.log('\nG. Erros de navegação e recuperação')
    await page.goto(`${base}/investigations/inv_inexistente_000000`)
    await page.waitForText('Investigação não encontrada', 10000)
    check((await page.text()).includes('Investigação não encontrada'), 'id inexistente mostra estado claro')

    check(page.pageErrors.length === 0, 'nenhum erro de runtime', page.pageErrors.join(' | ').slice(0, 240))
    const consoleErrors = page.consoleMessages.filter((message) => message.type === 'error')
    check(consoleErrors.length === 0, 'nenhum erro de console', consoleErrors.map((m) => m.text).join(' | ').slice(0, 240))
  } finally {
    await close()
    server.close()
    await new Promise<void>((resolve) => provider.close(() => resolve()))
    built.close()
  }

  console.log(`\n${checks - failures}/${checks} verificações passaram.`)
  if (failures > 0) process.exit(1)
}

main().catch((error: unknown) => {
  console.error('fluxos falharam:', error)
  process.exit(1)
})
