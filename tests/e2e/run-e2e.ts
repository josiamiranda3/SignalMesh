/**
 * End-to-end flow.
 *
 * Drives the real application in a real browser through the complete product
 * journey — sign in → create investigation → research → select evidence →
 * analyse → validate → history → export → sign out — plus a two-user isolation
 * check. The providers are a local mock so the run is deterministic and free.
 *
 *   node --experimental-transform-types tests/e2e/run-e2e.ts
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { buildApp } from '../../server/app.ts'
import { Page } from './cdp.ts'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ARTIFACTS = join(process.cwd(), 'tests', 'e2e', 'artifacts')
let failures = 0
let checks = 0

function check(condition: boolean, label: string, detail = ''): void {
  checks += 1
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const EXA_RESULTS = [
  {
    id: 'https://example.org/estudo',
    title: 'Estudo sobre detecção de fraudes com aprendizado de máquina',
    url: 'https://example.org/estudo',
    publishedDate: '2024-08-12T00:00:00.000Z',
    author: 'Grupo de Pesquisa',
    text: 'Estudo detalhado sobre antifraude com machine learning aplicado a transações financeiras no Brasil.',
    highlights: ['Redução de falsos positivos', 'Validação temporal'],
    summary: 'Resumo do estudo.',
  },
  {
    id: 'https://example.org/regulacao',
    title: 'Requisitos regulatórios para decisões automatizadas de crédito',
    url: 'https://example.org/regulacao',
    publishedDate: '2023-11-03T00:00:00.000Z',
    author: null,
    highlights: ['Exigência de explicabilidade'],
  },
]

async function main(): Promise<void> {
  rmSync(ARTIFACTS, { recursive: true, force: true })
  mkdirSync(ARTIFACTS, { recursive: true })

  // --- Mock providers ------------------------------------------------------
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const url = request.url ?? ''

      if (url.startsWith('/search')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ requestId: 'req_e2e', results: EXA_RESULTS, costDollars: { total: 0.004 } }))
        return
      }

      if (url.includes(':generateContent')) {
        const contents = body.contents as Array<{ parts: Array<{ text: string }> }> | undefined
        const userText = contents?.[0]?.parts?.[0]?.text ?? ''
        const ids = [...userText.matchAll(/<fonte id="([^"]+)"/g)].map((match) => match[1]!)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        executiveSummary:
                          'As fontes indicam uso de aprendizado de máquina em antifraude, com exigências regulatórias de explicabilidade.',
                        findings: [
                          {
                            statement: 'Um estudo relata redução de falsos positivos em transações.',
                            evidenceIds: [ids[0]],
                            confidence: 'medium',
                          },
                        ],
                        keyPoints: ['Explicabilidade é exigência regulatória.'],
                        supportedClaims: ['Redução de falsos positivos reportada.'],
                        contradictions: [],
                        limitations: ['Apenas duas fontes foram enviadas.'],
                        informationGaps: ['Dados de 2025 ainda não publicados.'],
                        objectiveAlignment: 'Cobre tecnologias e requisitos, mas não instituições específicas.',
                        insufficientEvidence: false,
                        citedEvidenceIds: [ids[0]],
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 350, totalTokenCount: 1250 },
          }),
        )
        return
      }

      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const providerPort = (provider.address() as AddressInfo).port

  // --- App -----------------------------------------------------------------
  const port = 8810
  const base = `http://127.0.0.1:${port}`
  const built = await buildApp({
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: ':memory:',
      PORT: String(port),
      APP_ORIGIN: base,
      SESSION_SECRET: 'e2e-secret-value-long-enough-for-production-123456',
      ENABLE_EXTERNAL_APIS: 'true',
      EXA_API_KEY: 'e2e-exa-key',
      EXA_BASE_URL: `http://127.0.0.1:${providerPort}`,
      GEMINI_API_KEY: 'e2e-gemini-key',
      GEMINI_BASE_URL: `http://127.0.0.1:${providerPort}`,
      GEMINI_MODEL: 'gemini-2.5-flash',
      RESEARCH_DAILY_LIMIT: '10',
      ANALYSIS_DAILY_LIMIT: '10',
      DUPLICATE_GUARD_SECONDS: '0',
    },
  })
  built.app.use('*', serveStatic({ root: './dist' }))
  built.app.get('*', serveStatic({ path: './dist/index.html' }))
  const server = serve({ fetch: built.app.fetch, port, hostname: '127.0.0.1' })
  await new Promise((resolve) => setTimeout(resolve, 500))

  const { page, close } = await Page.open({ width: 1440, height: 950 })

  try {
    console.log('\n1. Landing e autenticação')
    await page.goto(`${base}/`)
    await page.waitForText('informação dispersa')
    check((await page.text()).includes('SignalMesh') || (await page.text()).includes('SIGNALMESH'), 'landing page renderiza a marca')
    check((await page.text()).includes('Cada conclusão vinculada') || (await page.text()).includes('transformada em inteligência'), 'landing explica a proposta')

    // Protected route redirects an anonymous visitor.
    await page.goto(`${base}/dashboard`)
    await page.waitForText('Entrar no SignalMesh')
    check((await page.url()).includes('/login?next='), 'rota protegida redireciona para login preservando destino')

    // Sign in through the form.
    await page.fill('input[name="email"]', 'e2e@signalmess.test')
    await page.fill('input[name="name"]', 'Pesquisador E2E')
    await page.clickText('Entrar', 'button[type="submit"]')
    await page.waitForText('Visão geral', 12000)
    check((await page.url()).includes('/dashboard'), 'login redireciona para o destino original')
    check((await page.text()).includes('Pesquisador E2E'), 'nome do usuário aparece na interface')

    console.log('\n2. Estado vazio do dashboard')
    const emptyDashboard = await page.text()
    check(emptyDashboard.includes('Nenhuma investigação ainda'), 'dashboard mostra estado vazio elaborado')
    check(!/R\$\s?\d|clientes|empresas atendidas/i.test(emptyDashboard), 'nenhum número fictício é exibido')

    console.log('\n3. Criação de investigação')
    await page.clickText('Criar primeira investigação')
    await page.waitForText('Defina o que você quer descobrir')
    await page.fill('input[aria-label="Título da investigação"]', 'IA na detecção de fraudes financeiras no Brasil')
    await page.fill(
      'input[aria-label="Tema da investigação"]',
      'inteligência artificial para detecção de fraudes financeiras no Brasil',
    )
    await page.fill(
      'textarea[aria-label="Objetivo da investigação"]',
      'Identificar aplicações reais de inteligência artificial na detecção de fraudes financeiras no Brasil, instituições envolvidas, tecnologias e resultados publicados.',
    )
    await page.fill('textarea[aria-label="Descrição da investigação"]', 'Investigação conduzida pelo fluxo automatizado de verificação.')
    await page.fill('input[aria-label="Adicionar palavra-chave"]', 'fraude financeira')
    await page.press('Enter')
    await page.fill('input[aria-label="Adicionar palavra-chave"]', 'machine learning')
    await page.press('Enter')
    await page.clickText('Criar investigação', 'button[type="submit"]')
    await page.waitForText('Objetivo da pesquisa', 15000)
    check((await page.url()).includes('/investigations/'), 'investigação criada e detalhe aberto')
    const detailUrl = await page.url()
    const investigationId = detailUrl.split('/investigations/')[1]!.split('/')[0]!

    console.log('\n4. Pesquisa externa (Exa)')
    await page.clickText('Pesquisar')
    await page.waitForText('Buscar fontes na web')
    await page.clickText('Pesquisar', 'button[type="submit"]')
    await page.waitForText('Estudo sobre detecção de fraudes', 15000)
    const researchText = await page.text()
    check(researchText.includes('Estudo sobre detecção de fraudes'), 'resultado da pesquisa aparece')
    check(researchText.includes('example.org'), 'domínio da fonte é exibido')
    check(researchText.includes('conteúdo integral'), 'disponibilidade de conteúdo é indicada')
    check(researchText.includes('apenas trechos'), 'limitação de conteúdo parcial é indicada')
    check(researchText.includes('Conteúdo integral para 1 de 2'), 'aviso honesto sobre o conteúdo retornado')

    console.log('\n5. Seleção e armazenamento de evidências')
    await page.clickText('Selecionar todos')
    await page.clickText('Adicionar', 'button')
    await page.waitForText('evidência(s) adicionada(s)', 15000)
    check((await page.text()).includes('adicionada(s)'), 'evidências adicionadas com confirmação')

    await page.goto(`${base}/investigations/${investigationId}/evidence`)
    await page.waitForText('Fontes coletadas')
    const evidenceText = await page.text()
    check(evidenceText.includes('Estudo sobre detecção de fraudes'), 'evidência listada')
    check(evidenceText.includes('prioridade'), 'índice de priorização exibido')
    check(evidenceText.includes('Pendente'), 'status inicial pendente')

    const evidenceCountBefore = await page.evaluate<number>(`document.querySelectorAll('main li.panel').length`)

    console.log('\n6. Prevenção de duplicação')
    await page.goto(`${base}/investigations/${investigationId}/research`)
    await page.waitForText('Buscar fontes na web')
    await page.clickText('Pesquisar', 'button[type="submit"]')
    await page.waitForText('Estudo sobre detecção de fraudes', 15000)
    check((await page.text()).includes('Já adicionada'), 'resultado repetido aparece marcado como já adicionado')

    await page.goto(`${base}/investigations/${investigationId}/evidence`)
    await page.waitForText('Fontes coletadas')
    const evidenceCountAfter = await page.evaluate<number>(`document.querySelectorAll('main li.panel').length`)
    check(evidenceCountAfter === evidenceCountBefore, 'nenhuma duplicata foi criada', `${evidenceCountBefore} → ${evidenceCountAfter}`)

    console.log('\n7. Análise estruturada (Gemini)')
    await page.goto(`${base}/investigations/${investigationId}/analysis`)
    await page.waitForText('Síntese das evidências')
    await page.clickText('Solicitar análise')
    await page.waitForText('Confirmar análise')
    await page.clickText('Confirmar análise')
    await page.waitForText('Resumo executivo', 20000)
    const analysisText = await page.text()
    check(analysisText.includes('Resumo executivo'), 'resumo executivo apresentado')
    check(analysisText.includes('Principais descobertas'), 'descobertas apresentadas')
    check(analysisText.includes('Possíveis contradições'), 'seção de contradições presente')
    check(analysisText.includes('Limitações'), 'limitações apresentadas')
    check(analysisText.includes('Lacunas de informação'), 'lacunas apresentadas')
    check(analysisText.includes('Relação com o objetivo'), 'alinhamento ao objetivo apresentado')
    check(analysisText.includes('Referências utilizadas'), 'referências listadas')
    check(analysisText.includes('gemini-2.5-flash'), 'modelo utilizado identificado')
    check(!analysisText.includes('evi_inventado'), 'nenhuma referência inventada aparece')

    console.log('\n8. Validação humana')
    await page.goto(`${base}/investigations/${investigationId}/validation`)
    await page.waitForText('Decidir sobre as evidências')
    await page.clickText('Aprovar', 'button')
    await page.waitForText('Deseja aprovar')
    await page.fill('textarea[aria-label="Justificativa da decisão"]', 'Metodologia descrita e dados primários citados.')
    await page.clickText('Confirmar decisão')
    await page.waitForText('Evidência aprovada', 12000)
    check((await page.text()).includes('Evidência aprovada'), 'aprovação registrada com feedback')

    // Rejection requires a justification.
    await page.clickText('Rejeitar', 'button')
    await page.waitForText('Deseja rejeitar')
    await page.clickText('Confirmar decisão')
    await page.waitForText('pelo menos 3 caracteres', 8000)
    check((await page.text()).includes('pelo menos 3 caracteres'), 'rejeição sem justificativa é bloqueada')
    await page.fill('textarea[aria-label="Justificativa da decisão"]', 'Fonte sem data de publicação.')
    await page.clickText('Confirmar decisão')
    await page.waitForText('Evidência rejeitada', 12000)
    check((await page.text()).includes('Evidência rejeitada'), 'rejeição registrada com justificativa')

    console.log('\n9. Histórico auditável')
    // Both decisions moved the evidence out of "Pendentes", so switch to the tab
    // that now holds it before opening its decision history.
    await page.clickText('Rejeitadas', 'button[role="tab"]')
    await page.waitForText('Fonte sem data de publicação', 8000)
    await page.clickText('Histórico', 'button')
    await page.waitForText('Histórico de validação', 10000)
    const historyModal = await page.text()
    check(historyModal.includes('antes:'), 'histórico mostra o status anterior')
    check(historyModal.includes('Fonte sem data de publicação.'), 'justificativa preservada no histórico')
    await page.press('Escape')

    await page.goto(`${base}/history`)
    await page.waitForText('Histórico')
    const globalHistory = await page.text()
    check(globalHistory.includes('Investigação'), 'histórico global lista eventos de investigação')
    check(globalHistory.includes('validation.recorded'), 'histórico registra validações')
    check(globalHistory.includes('analysis.completed'), 'histórico registra análises')
    check(globalHistory.includes('research.executed'), 'histórico registra pesquisas')

    console.log('\n10. Exportação')
    await page.goto(`${base}/investigations/${investigationId}`)
    await page.waitForText('Objetivo da pesquisa')
    await page.clickText('Exportar', 'button')
    await page.waitForText('Exportar investigação')
    const exportText = await page.text()
    check(exportText.includes('JSON') && exportText.includes('CSV'), 'formatos JSON e CSV oferecidos')
    check(exportText.includes('Investigação completa'), 'escopo completo disponível')
    await page.press('Escape')

    const download = await page.evaluate<{ status: number; length: number; contentType: string; start: string }>(`
      (async () => {
        const response = await fetch('/api/investigations/${investigationId}/export?format=json&scope=investigation', {
          headers: { 'x-signalmess-request': '1' },
        });
        const text = await response.text();
        return { status: response.status, length: text.length, contentType: response.headers.get('content-type') || '', start: text.slice(0, 20) };
      })()
    `)
    check(download.status === 200, 'download JSON responde 200', `status ${download.status}`)
    check(download.contentType.includes('application/json'), 'content-type correto')
    check(download.start.includes('{'), 'arquivo é JSON válido', download.start)
    const bundle = await page.evaluate<{ generator?: string; investigationId?: string; evidenceCount: number }>(`
      (async () => {
        const response = await fetch('/api/investigations/${investigationId}/export?format=json&scope=investigation', {
          headers: { 'x-signalmess-request': '1' },
        });
        const data = await response.json();
        return {
          generator: data.meta && data.meta.generator,
          investigationId: data.investigation && data.investigation.id,
          evidenceCount: Array.isArray(data.evidence) ? data.evidence.length : 0,
        };
      })()
    `)
    check(bundle.generator === 'SIGNALMESH', 'arquivo identifica o gerador', String(bundle.generator))
    check(bundle.investigationId === investigationId, 'arquivo contém a investigação correta')
    check(bundle.evidenceCount >= 2, 'arquivo contém as evidências relacionadas', String(bundle.evidenceCount))

    const csv = await page.evaluate<{ status: number; rows: number }>(`
      (async () => {
        const response = await fetch('/api/investigations/${investigationId}/export?format=csv&scope=investigation', {
          headers: { 'x-signalmess-request': '1' },
        });
        const text = await response.text();
        return { status: response.status, rows: text.split('\\n').length };
      })()
    `)
    check(csv.status === 200 && csv.rows > 1, 'download CSV contém linhas', `${csv.rows} linhas`)

    console.log('\n11. Configurações e limites')
    await page.goto(`${base}/settings`)
    await page.waitForText('Provedores externos')
    const settingsText = await page.text()
    check(settingsText.includes('operacional'), 'provedores aparecem como operacionais')
    check(settingsText.includes('exa') || settingsText.includes('Exa'), 'Exa listada')
    check(settingsText.includes('Gemini'), 'Gemini listado')
    check(settingsText.includes('Registro de consumo'), 'registro de consumo visível')
    check(!settingsText.includes('e2e-exa-key'), 'nenhuma chave é exposta na interface')

    console.log('\n12. Isolamento entre dois usuários')
    const second = await page.evaluate<string>(`
      (async () => {
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-signalmess-request': '1' } });
        const login = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-signalmess-request': '1' },
          body: JSON.stringify({ email: 'intruso@signalmess.test', name: 'Intruso' }),
        });
        if (!login.ok) return 'login falhou';
        const direct = await fetch('/api/investigations/${investigationId}');
        const list = await fetch('/api/investigations');
        const payload = await list.json();
        return direct.status + '|' + payload.data.total;
      })()
    `)
    check(second.startsWith('404|0'), 'segundo usuário não vê nem acessa dados do primeiro', second)

    console.log('\n13. Encerramento de sessão')
    // Step 12 signed in as a second user through fetch, so end that session
    // through the UI: reload settings, then use the sign-out control.
    await page.goto(`${base}/settings`)
    await page.waitForText('Encerrar sessão', 12000)
    await page.clickText('Encerrar sessão', 'button')
    await page.waitForText('Entrar no SignalMesh', 12000)
    check((await page.url()).includes('/login'), 'logout redireciona para login')

    // The protected route must stay closed after signing out.
    await page.goto(`${base}/dashboard`)
    await page.waitForText('Entrar no SignalMesh', 12000)
    check((await page.url()).includes('/login'), 'rota protegida permanece fechada após logout')

    // Clean run check.
    check(page.pageErrors.length === 0, 'nenhum erro de runtime durante o fluxo', page.pageErrors.join(' | ').slice(0, 300))
    const consoleErrors = page.consoleMessages.filter((message) => message.type === 'error')
    check(consoleErrors.length === 0, 'nenhum erro de console durante o fluxo', consoleErrors.map((m) => m.text).join(' | ').slice(0, 300))

    await page.screenshot(join(ARTIFACTS, 'e2e-final.png'))
  } finally {
    await close()
    server.close()
    await new Promise<void>((resolve) => provider.close(() => resolve()))
    built.close()
  }

  console.log(`\n${checks - failures}/${checks} verificações passaram.`)
  if (failures > 0) {
    console.error(`${failures} verificação(ões) falharam.`)
    process.exit(1)
  }
  console.log('Fluxo de ponta a ponta concluído com sucesso.')
}

main().catch((error: unknown) => {
  console.error('E2E falhou:', error)
  process.exit(1)
})
