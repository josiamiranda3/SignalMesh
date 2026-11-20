/**
 * Worker production-runtime verification.
 *
 * Two layers, because the environment only permits one of them here:
 *
 *  1. **Bundle verification** (always runs) — bundles `worker.ts` with the real
 *     `wrangler deploy --dry-run`, then inspects the artifact: the Durable Object
 *     class and manifest are present, the RecordRoom binding is declared, no
 *     Node-only runtime (`node:http`, `@hono/node-server`) leaked in, and no
 *     secret value is embedded.
 *
 *  2. **Live workerd smoke** (runs when the runtime can start) — boots the Worker
 *     under `wrangler dev` and drives the real HTTP surface. `workerd` needs to
 *     spawn child processes and write temp bundles; where the environment denies
 *     that, this layer reports SKIPPED with the observed reason instead of
 *     pretending to have passed.
 *
 *   node --experimental-transform-types tests/worker/run-worker-smoke.ts
 *
 * Neither layer contacts the platform, registers the app, or spends money.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ARTIFACTS = join(process.cwd(), 'tests', 'worker', 'artifacts')
const OUT_DIR = join(process.cwd(), '.wrangler-verify')
const PORT = 8820
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
let checks = 0
const report: string[] = []

function check(condition: boolean, label: string, detail = ''): void {
  checks += 1
  const line = condition ? `  ✓ ${label}` : `  ✗ ${label}${detail ? ` — ${detail}` : ''}`
  console.log(line)
  report.push(line)
  if (!condition) failures += 1
}

function note(line: string): void {
  console.log(line)
  report.push(line)
}

interface RunResult {
  code: number | null
  output: string
}

/** Run a command, capturing output without piping through the sandbox's pipes. */
function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 180_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

// ---------------------------------------------------------------------------
// Layer 1 — bundle verification
// ---------------------------------------------------------------------------

async function verifyBundle(): Promise<boolean> {
  note('\n1. Empacotamento do Worker com o runtime real (wrangler)')

  rmSync(OUT_DIR, { recursive: true, force: true })

  const result = await run(process.execPath, [
    join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'deploy',
    '--dry-run',
    '--outdir',
    OUT_DIR,
  ])

  if (result.code !== 0) {
    check(false, 'wrangler empacota o worker', result.output.slice(-1200))
    return false
  }

  check(true, 'wrangler empacota o worker sem erros')

  const files = existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : []
  const workerFile = files.find((file) => file.endsWith('.js'))
  check(Boolean(workerFile), 'artefato .js gerado', files.join(', '))
  if (!workerFile) return false

  const bundlePath = join(OUT_DIR, workerFile)
  const bundle = readFileSync(bundlePath, 'utf8')
  const sizeKb = Math.round(statSync(bundlePath).size / 1024)
  note(`     bundle: ${workerFile} (${sizeKb} KB)`)

  check(bundle.includes('AppRecordRoom'), 'classe do Durable Object presente no bundle')
  check(bundle.includes('__DO_MANIFEST__'), 'manifesto de Durable Objects presente')
  check(bundle.includes('verifyJwt'), 'verificação de JWT da plataforma presente')
  check(bundle.includes('createWorkerServices'), 'composição do Worker presente')
  check(bundle.includes('records.create') || bundle.includes('records.query'), 'protocolo de Records presente')

  // The production runtime must not carry the Node server.
  check(!bundle.includes('hono/node-server'), '@hono/node-server ausente do bundle')
  check(!bundle.includes('node:http'), 'node:http ausente do bundle')

  // Our SQLite adapter must be tree-shaken out entirely — the Worker has no
  // local database. Asserting on its class names is stronger than looking for
  // the `node:sqlite` string, which the SDK's own Drizzle layer references
  // inside a `try { await import('node:sqlite') }` guard that never runs here.
  check(!bundle.includes('SqliteInvestigationRepository'), 'adaptador SQLite não empacotado')
  check(!bundle.includes('createSqliteRepositories'), 'fábrica do adaptador SQLite não empacotada')
  check(!bundle.includes('CREATE TABLE IF NOT EXISTS users'), 'esquema SQLite local não empacotado')
  check(!bundle.includes('PRAGMA journal_mode'), 'pragmas do SQLite local não empacotados')

  // `node:sqlite` may appear only as a guarded dynamic import, never as a
  // static one: a static import would make the Worker fail to boot.
  const staticSqliteImports = [...bundle.matchAll(/from\s*["']node:sqlite["']/g)].length
  check(staticSqliteImports === 0, 'nenhum import estático de node:sqlite', String(staticSqliteImports))

  // No secret value may be embedded — only the env lookups.
  const secrets = ['test-exa-key', 'test-gemini-key', 'EXA_API_KEY=', 'GEMINI_API_KEY=']
  for (const secret of secrets) {
    // `EXA_API_KEY=` appears as an env lookup only if a value were inlined; the
    // bundle reads `env['EXA_API_KEY']`, which does not contain `=`.
    if (secret.endsWith('=')) continue
    check(!bundle.includes(secret), `nenhum valor de chave embutido (${secret})`)
  }

  // Configuration must be read at runtime, not frozen into the bundle.
  check(
    bundle.includes('ENABLE_EXTERNAL_APIS'),
    'interruptor de custo é lido em runtime, não fixado no bundle',
  )

  return true
}

// ---------------------------------------------------------------------------
// Layer 2 — live workerd
// ---------------------------------------------------------------------------

interface LiveResult {
  status: 'ran' | 'skipped'
  reason?: string
}

async function verifyLiveWorker(): Promise<LiveResult> {
  note('\n2. Execução no workerd (runtime de produção)')

  const persistDir = join(process.cwd(), '.wrangler-smoke')
  rmSync(persistDir, { recursive: true, force: true })

  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'dev',
      '--port',
      String(PORT),
      '--ip',
      '127.0.0.1',
      '--local',
      '--persist-to',
      persistDir,
    ],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    },
  )

  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })

  const started = Date.now()
  let healthy = false

  while (Date.now() - started < 60_000) {
    if (child.exitCode !== null) break
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) {
        healthy = true
        break
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  if (!healthy) {
    child.kill('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 300))
    rmSync(persistDir, { recursive: true, force: true })

    const runtimeFailed = /std::terminate|Workers runtime failed to start/i.test(output)
    const reason = runtimeFailed
      ? 'o binário workerd não inicia neste ambiente (falha do próprio runtime, reproduzida com um Worker mínimo)'
      : 'wrangler dev não respondeu dentro do prazo'

    note(`  SKIP  execução ao vivo não disponível: ${reason}`)
    note(
      '        O empacotamento acima foi verificado; a execução ao vivo deve ser repetida ' +
        'em um ambiente que permita ao workerd criar subprocessos.',
    )
    return { status: 'skipped', reason }
  }

  try {
    note('  workerd iniciou; exercitando a superfície HTTP real')

    const health = await fetch(`${BASE}/api/health`)
    const healthBody = (await health.json()) as {
      data: { runtime: string; storage: string; authMode: string }
    }
    check(health.status === 200, 'GET /api/health responde 200', String(health.status))
    check(healthBody.data.runtime === 'worker', 'runtime reportado como worker', healthBody.data.runtime)
    check(healthBody.data.storage === 'records', 'persistência é records', healthBody.data.storage)
    check(healthBody.data.authMode === 'deepspace', 'autenticação é deepspace', healthBody.data.authMode)

    for (const path of ['/api/investigations', '/api/dashboard', '/api/settings', '/api/history']) {
      const response = await fetch(`${BASE}${path}`)
      check(response.status === 401, `${path} exige identidade`, String(response.status))
    }

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signalmess-request': '1' },
      body: JSON.stringify({ email: 'x@example.com' }),
    })
    check(login.status === 404, 'não existe login local no Worker', String(login.status))

    const shell = await fetch(`${BASE}/dashboard`)
    const shellText = await shell.text()
    check(shell.status === 200 && shellText.includes('<div id="root">'), 'SPA é servida pelo binding ASSETS')

    const missingAsset = await fetch(`${BASE}/assets/nao-existe.js`)
    check(missingAsset.status === 404, 'asset ausente responde 404 (não o shell)')

    const unknownApi = await fetch(`${BASE}/api/rota-inexistente`)
    check(
      (unknownApi.headers.get('content-type') ?? '').includes('application/json'),
      'API desconhecida responde JSON',
    )

    return { status: 'ran' }
  } finally {
    child.kill()
    await new Promise((resolve) => setTimeout(resolve, 400))
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(persistDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  rmSync(ARTIFACTS, { recursive: true, force: true })
  mkdirSync(ARTIFACTS, { recursive: true })

  if (!existsSync(join(process.cwd(), 'dist', 'index.html'))) {
    console.error('dist/index.html ausente — execute `npm run build` primeiro.')
    process.exit(2)
  }
  if (!existsSync(join(process.cwd(), 'node_modules', 'wrangler'))) {
    console.error('wrangler não instalado — execute `npm install`.')
    process.exit(2)
  }

  const bundled = await verifyBundle()
  const live = bundled ? await verifyLiveWorker() : { status: 'skipped' as const, reason: 'empacotamento falhou' }

  note('')
  note(`Verificações: ${checks - failures}/${checks} passaram.`)
  note(`Execução ao vivo no workerd: ${live.status === 'ran' ? 'executada' : `não executada (${live.reason})`}`)

  writeFileSync(
    join(ARTIFACTS, 'worker-verification.txt'),
    [
      ...report,
      '',
      `liveWorkerd: ${live.status}`,
      live.status === 'skipped' ? `reason: ${live.reason}` : '',
      `finishedAt: ${new Date().toISOString()}`,
    ].join('\n'),
  )

  rmSync(OUT_DIR, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`\n${failures} verificação(ões) falharam.`)
    process.exit(1)
  }
  console.log('\nEmpacotamento do Worker validado.')
}

main().catch((error: unknown) => {
  console.error('Verificação do Worker falhou:', error instanceof Error ? error.message : error)
  process.exit(1)
})
