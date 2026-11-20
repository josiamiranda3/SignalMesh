/**
 * Migration CLI: local SQLite → DeepSpace Records.
 *
 *   node --experimental-transform-types scripts/migrate-to-records.ts --owner <userId> [--dry-run]
 *
 * Why a CLI and not an HTTP endpoint: the migration writes rows on behalf of
 * their original owners, which a member-scoped transport cannot and must not do.
 * It therefore runs where the operator has the app's server credential — never
 * from the browser.
 *
 * The script never deletes the source database. It reads through the repository
 * ports, writes through the Records adapter, and prints a per-collection report
 * so the operator can verify before switching anything over.
 */

import { loadEnvFile } from '../server/lib/env.ts'
import { loadConfig } from '../server/config.ts'
import { openDatabase } from '../server/db.ts'
import { createSqliteRepositories } from '../server/repositories/sqlite.ts'
import { createRecordStore, createTransport } from '../server/repositories/records/transport.ts'
import { formatMigrationReport, migrateToRecords } from '../server/migration/records.ts'
import type { RecordToolCaller, ToolResult } from '../server/repositories/records/transport.ts'

loadEnvFile()

interface Args {
  owner: string | null
  dryRun: boolean
  appId: string | null
  ownerUserId: string | null
}

function parseArgs(argv: string[]): Args {
  const args: Args = { owner: null, dryRun: false, appId: null, ownerUserId: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--dry-run') args.dryRun = true
    else if (value === '--owner') args.owner = argv[++index] ?? null
    else if (value === '--app') args.appId = argv[++index] ?? null
    else if (value === '--owner-user') args.ownerUserId = argv[++index] ?? null
  }
  return args
}

/**
 * Resolve the Worker's record room over HTTP.
 *
 * A deployed app exposes no public endpoint that can write on behalf of another
 * user, by design. The supported path is to run the migration with the app's
 * server credential against the record room, which the platform provides as
 * `DEEPSPACE_APP_ID` + an authenticated request to the app origin.
 *
 * Until deployment is authorized there is no such origin, so this function
 * explains what is missing instead of pretending to work.
 */
function createRemoteCaller(input: {
  appBaseUrl: string
  appId: string
  ownerUserId: string
}): RecordToolCaller {
  return async (tool, params): Promise<ToolResult> => {
    const response = await fetch(`${input.appBaseUrl.replace(/\/+$/, '')}/api/internal/records/tools`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signalmess-request': '1',
        'x-migration-app': input.appId,
        'x-migration-owner': input.ownerUserId,
      },
      body: JSON.stringify({ tool, params }),
    })
    return (await response.json()) as ToolResult
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig(process.env, { runtime: 'node' })

  if (!args.owner) {
    console.error('Informe --owner <userId> (o dono cujos dados serão migrados).')
    console.error(
      'O modo local não enumera contas com segurança, então a migração é explícita por proprietário.',
    )
    process.exit(2)
  }

  const db = openDatabase(config.databaseUrl)
  const source = createSqliteRepositories(db)

  const appBaseUrl = process.env['MIGRATION_TARGET_URL']?.trim()
  if (!appBaseUrl) {
    console.error('MIGRATION_TARGET_URL não definido.')
    console.error(
      'A migração envia os dados para a instância DeepSpace já implantada. Defina a URL do app',
    )
    console.error('(por exemplo https://signalmess.app.space) e as credenciais do operador.')
    console.error('Nenhum dado foi alterado.')
    db.close()
    process.exit(2)
  }

  const appId = args.appId ?? process.env['DEEPSPACE_APP_ID'] ?? ''
  const ownerUserId = args.ownerUserId ?? process.env['OWNER_USER_ID'] ?? ''
  if (!appId || !ownerUserId) {
    console.error('Defina --app <appId> e --owner-user <userId> (ou as variáveis correspondentes).')
    db.close()
    process.exit(2)
  }

  const target = createRecordStore(
    createTransport(createRemoteCaller({ appBaseUrl, appId, ownerUserId })),
  )

  console.info(`Migrando dados locais de ${args.owner} → ${appBaseUrl}${args.dryRun ? ' (simulação)' : ''}`)

  const report = await migrateToRecords({
    source,
    target,
    dryRun: args.dryRun,
    ownerId: args.owner,
  })

  console.info(formatMigrationReport(report))
  db.close()

  const failed = Object.values(report.collections).reduce((sum, counts) => sum + counts.failed, 0)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error: unknown) => {
  console.error('Migração falhou:', error instanceof Error ? error.message : error)
  process.exit(1)
})
