/**
 * Migration CLI: local SQLite → DeepSpace Records.
 *
 *   node --experimental-transform-types scripts/migrate-to-records.ts \
 *     --owner <userId> --target-url https://<app>.app.space [--dry-run] \
 *     [--from <index>] < token.txt
 *
 * ## How it reaches the RecordRoom
 *
 * Through SIGNALMESH's own action route — `POST /api/actions/migrateRecords`. The
 * route is implemented in `server/http/action-routes.ts` and mounted by
 * `worker.ts`; the platform does not mount it for the app. What the SDK supplies
 * is the handler contract and the `X-App-Action` transport that reaches the
 * RecordRoom with per-record RBAC off.
 *
 * ## Identity
 *
 * The bearer token is the operator's own session token, obtained out of band and
 * supplied on stdin (`--token-stdin`) or through `MIGRATION_TOKEN` — never a
 * header this script invents. The route verifies the JWT and the action is
 * `selfScoped`, so the verified subject must equal the `ownerId` being migrated:
 *
 *   - a token for a non-owner is refused (`403`);
 *   - a token for the owner but a different `ownerId` is refused, because
 *     `userBound` would stamp the caller and reattribute the rows.
 *
 * The app owner (`OWNER_USER_ID`) has no special standing here. Being the app
 * owner does not authorize migrating another account's data; each account runs
 * the migration once, with its own token.
 *
 * ## The CSRF marker
 *
 * The mutation carries `x-signalmess-request: 1`. That header is **not
 * authentication** and must never be described as such: it is a CSRF heuristic,
 * and the credential is the bearer token, which the server verifies. This client
 * sends it because it is the simplest, most portable path — a request that works
 * under every deployment topology, including a reverse proxy that terminates TLS
 * and forwards without an `Origin` header.
 *
 * The marker is *sufficient*, not required, for bearer clients: `csrf-policy.ts`
 * exempts a request whose token verified and which carries no session cookie.
 * Sending it keeps this script working even if that exemption is ever narrowed.
 *
 * ## Why one owner at a time
 *
 * `ownerId` is `userBound`, so the Durable Object writes the *caller's* id. A
 * single trusted identity cannot faithfully import several accounts, which is
 * why the CLI takes `--owner` and must be run per account with that account's
 * own token.
 *
 * ## What it never does
 *
 * No deletion of the source, no writes when `--dry-run` is set, and no
 * assumption that a successful HTTP response means a row landed — the action
 * reports per-row outcomes and this script fails when any row failed.
 *
 * ## Partial failure
 *
 * Batches are independent and the operation is idempotent, so a run interrupted
 * at batch N can be resumed with `--from <first index not yet applied>`. The
 * script never truncates, deletes, or rewrites the source: a failure leaves it
 * byte-identical and prints the exact resume command.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { loadEnvFile } from '../server/lib/env.ts'
import { loadConfig } from '../server/config.ts'
import { openReadOnlyDatabase } from '../server/db.ts'
import { createSqliteRepositories } from '../server/repositories/sqlite.ts'
import { collectMigrationRows, type MigrationRows } from '../server/migration/collect.ts'

loadEnvFile()

const MAX_ROWS_PER_CALL = 100

/**
 * Ceiling for a single HTTP call.
 *
 * A batch is at most 100 rows of bounded size, so a healthy response is well
 * under this. The timeout exists so a wedged connection fails the run instead of
 * hanging it forever: a hung migration is indistinguishable from a slow one, and
 * an operator who does not know which is happening cannot decide whether to
 * resume.
 */
const DEFAULT_TIMEOUT_MS = 60_000

/** Network-level retries. A batch is idempotent, so retrying is safe. */
const DEFAULT_RETRIES = 2

const CSRF_MARKER = { 'x-signalmess-request': '1' } as const

interface Args {
  owner: string | null
  dryRun: boolean
  targetUrl: string | null
  token: string | null
  /** Index of the first collected row to send; enables resuming a partial run. */
  from: number
  timeoutMs: number
  retries: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    owner: null,
    dryRun: false,
    targetUrl: null,
    token: null,
    from: 0,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--dry-run') args.dryRun = true
    else if (value === '--owner') args.owner = argv[++index] ?? null
    else if (value === '--target-url') args.targetUrl = argv[++index] ?? null
    else if (value === '--from') args.from = Number(argv[++index] ?? '0') || 0
    else if (value === '--timeout-ms') args.timeoutMs = Number(argv[++index] ?? '0') || DEFAULT_TIMEOUT_MS
    else if (value === '--retries') args.retries = Number(argv[++index] ?? '0') || 0
    else if (value === '--token-stdin') {
      // Reading from stdin avoids putting a live credential in argv, where it
      // would land in shell history and process listings.
      args.token = readStdin().trim() || null
    }
  }
  return args
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

interface ActionOutcome {
  collection: string
  id: string
  result: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed'
  error?: string
}

interface ActionResponse {
  success: boolean
  data?: {
    ownerId: string
    dryRun: boolean
    outcomes: ActionOutcome[]
    counts: Record<string, number>
  }
  error?: string
}

/**
 * Classify a failure so the operator knows whether resuming will help.
 *
 * `retryable` is about the transport, not the data: a 5xx or a dropped socket
 * says nothing about whether the batch was valid, so the same batch is worth
 * retrying. A 4xx does not improve with repetition.
 */
type FailureKind = 'transport' | 'timeout' | 'http' | 'invalid-response' | 'refused'

interface CallFailure {
  ok: false
  kind: FailureKind
  message: string
  retryable: boolean
}

interface CallSuccess {
  ok: true
  body: ActionResponse
}

/** Call the app's migration action with one bounded batch. */
async function callActionOnce(input: {
  targetUrl: string
  token: string
  ownerId: string
  rows: Array<{ collection: string; id: string; data: Record<string, unknown> }>
  dryRun: boolean
  timeoutMs: number
}): Promise<CallSuccess | CallFailure> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)

  let response: Response
  try {
    response = await fetch(
      `${input.targetUrl.replace(/\/+$/, '')}/api/actions/migrateRecords`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The only credential: the operator's own session token. No bespoke
          // identity header exists in this protocol, and the CSRF marker below
          // is not one — it is a browser-oriented heuristic.
          authorization: `Bearer ${input.token}`,
          ...CSRF_MARKER,
        },
        body: JSON.stringify({
          ownerId: input.ownerId,
          rows: input.rows,
          dryRun: input.dryRun,
        }),
        signal: controller.signal,
      },
    )
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError'
    return {
      ok: false,
      kind: aborted ? 'timeout' : 'transport',
      message: aborted
        ? `tempo esgotado após ${input.timeoutMs} ms`
        : `falha de conexão: ${(error as Error).message}`,
      // A timeout is ambiguous: the server may have applied the batch after the
      // socket was cut. Retrying is safe because every write is idempotent.
      retryable: true,
    }
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  let body: ActionResponse
  try {
    body = JSON.parse(text) as ActionResponse
  } catch {
    return {
      ok: false,
      kind: 'invalid-response',
      message: `resposta não-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
      // An HTML error page from a proxy is a deployment problem, not a verdict
      // on the batch; one retry distinguishes a blip from a misconfiguration.
      retryable: response.status >= 500,
    }
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        kind: 'refused',
        message:
          `HTTP ${response.status}: ${body.error ?? 'recusado'}. ` +
          'Verifique se o token pertence ao dono dos dados (ownerId) e se ele ainda é válido.',
        retryable: false,
      }
    }
    return {
      ok: false,
      kind: 'http',
      message: `HTTP ${response.status}: ${body.error ?? 'erro'} (${text.slice(0, 200)})`,
      retryable: response.status >= 500 || response.status === 429,
    }
  }

  if (body.success !== true) {
    return {
      ok: false,
      kind: 'refused',
      message: body.error ?? 'a ação respondeu success: false',
      retryable: false,
    }
  }

  return { ok: true, body }
}

/** Call the action, retrying only transport-level failures. */
async function callAction(input: {
  targetUrl: string
  token: string
  ownerId: string
  rows: Array<{ collection: string; id: string; data: Record<string, unknown> }>
  dryRun: boolean
  timeoutMs: number
  retries: number
}): Promise<CallSuccess | CallFailure> {
  let last: CallFailure | null = null
  for (let attempt = 0; attempt <= input.retries; attempt += 1) {
    const result = await callActionOnce(input)
    if (result.ok) return result
    last = result
    if (!result.retryable) return result
    if (attempt < input.retries) {
      const delay = 500 * 2 ** attempt
      console.info(`  tentativa ${attempt + 1} falhou (${result.message}); repetindo em ${delay} ms`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  return last!
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig(process.env, { runtime: 'node' })

  const targetUrl = args.targetUrl ?? process.env['MIGRATION_TARGET_URL']?.trim() ?? null
  const token = args.token ?? process.env['MIGRATION_TOKEN']?.trim() ?? null

  if (!args.owner) {
    console.error('Informe --owner <userId>: a migração roda uma vez por proprietário.')
    console.error('Como ownerId é userBound, cada conta precisa ser migrada com sua própria identidade.')
    process.exit(2)
  }

  if (!targetUrl || !token) {
    console.error('Migração não configurada — nada foi enviado.\n')
    console.error('A migração grava via a server action do app já implantado:')
    console.error('  POST <target>/api/actions/migrateRecords')
    console.error('')
    console.error('É necessário:')
    console.error('  --target-url https://<app>.app.space   (ou MIGRATION_TARGET_URL)')
    console.error('  --token-stdin                          (token de sessão do proprietário)')
    console.error('')
    console.error('O token deve ser do próprio dono dos dados: a ação exige que o ownerId')
    console.error('seja igual ao chamador verificado e recusa qualquer outro. Ser dono do app')
    console.error('não autoriza migrar dados de outra conta.')
    console.error('')
    console.error('Sem esses dois valores a migração permanece BLOQUEADA — por desenho,')
    console.error('porque não existe caminho administrativo sem credencial de proprietário.')
    process.exit(2)
  }

  // Read-only on purpose: the source is evidence, and a migration must not be
  // able to change it even by accident. See `openReadOnlyDatabase`.
  const db = openReadOnlyDatabase(config.databaseUrl)
  const source = createSqliteRepositories(db)

  let collected: MigrationRows
  try {
    collected = await collectMigrationRows({ source, ownerId: args.owner })
  } catch (error) {
    console.error('Falha ao ler a origem:', error instanceof Error ? error.message : error)
    console.error('Nenhum dado foi alterado.')
    db.close()
    process.exit(1)
  }

  const startAt = Math.max(0, Math.min(args.from, collected.rows.length))
  const remaining = collected.rows.slice(startAt)

  console.info(
    `Migrando ${collected.rows.length} linha(s) de ${args.owner} → ${targetUrl}` +
      `${args.dryRun ? ' (simulação)' : ''}` +
      `${startAt > 0 ? ` — retomando do índice ${startAt} (${remaining.length} restante(s))` : ''}`,
  )

  const totals = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 }
  const warnings: string[] = []

  for (const warning of collected.warnings) warnings.push(warning)

  // Batches keep each request bounded; the action enforces the same ceiling.
  for (let offset = 0; offset < remaining.length; offset += MAX_ROWS_PER_CALL) {
    const batch = remaining.slice(offset, offset + MAX_ROWS_PER_CALL)
    const result = await callAction({
      targetUrl,
      token,
      ownerId: args.owner,
      rows: batch,
      dryRun: args.dryRun,
      timeoutMs: args.timeoutMs,
      retries: args.retries,
    })

    if (!result.ok) {
      const appliedUpTo = startAt + offset
      console.error(`\nFalha na migração: ${result.message}`)
      console.error('A origem não foi alterada nem apagada.')
      if (appliedUpTo > 0) {
        // Resume, do not restart: the writes already applied are idempotent, so
        // `--from` only avoids re-sending what is known to be done.
        console.error(
          `${appliedUpTo} linha(s) já foram processadas nesta execução. ` +
            'Para retomar sem reenviar:',
        )
        console.error(`  --from ${appliedUpTo}`)
      } else {
        console.error('Nenhuma linha foi enviada com sucesso; reexecute quando o problema for corrigido.')
      }
      console.error('A operação é idempotente: reenviar linhas já aplicadas resulta em "unchanged".')
      db.close()
      process.exit(1)
    }

    for (const [key, value] of Object.entries(result.body.data?.counts ?? {})) {
      if (key in totals) totals[key as keyof typeof totals] += value
    }
    for (const outcome of result.body.data?.outcomes ?? []) {
      if (outcome.result === 'failed' || outcome.result === 'skipped') {
        warnings.push(`${outcome.collection}/${outcome.id}: ${outcome.result}${outcome.error ? ` — ${outcome.error}` : ''}`)
      }
    }
  }

  db.close()

  console.info('')
  for (const [key, value] of Object.entries(totals)) {
    console.info(`  ${key.padEnd(10)} ${String(value).padStart(6)}`)
  }
  if (args.dryRun) console.info('\nSimulação: nenhum dado foi gravado.')

  if (warnings.length > 0) {
    console.info('\nAvisos:')
    for (const warning of warnings.slice(0, 40)) console.info(`  - ${warning}`)
    if (warnings.length > 40) console.info(`  … e mais ${warnings.length - 40}`)
  }

  if (totals.failed > 0) {
    console.error(`\n${totals.failed} linha(s) falharam. A origem permanece intacta.`)
    console.error('Corrija a causa e reexecute: linhas já aplicadas voltam como "unchanged".')
    process.exit(1)
  }

  console.info('\nMigração concluída.')
}

/** Stable digest of a row, used only in log lines (never as an identifier). */
export function rowDigest(collection: string, id: string): string {
  return createHash('sha256').update(`${collection}:${id}`).digest('hex').slice(0, 12)
}

main().catch((error: unknown) => {
  console.error('Migração falhou:', error instanceof Error ? error.message : error)
  process.exit(1)
})
