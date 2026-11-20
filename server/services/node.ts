import type { AppConfig } from '../config.ts'
import { openDatabase, type Database } from '../db.ts'
import { createSqliteRepositories } from '../repositories/sqlite.ts'
import { AuthResolver } from '../lib/auth-resolver.ts'
import { SessionStore } from '../lib/sessions.ts'
import { createServices, type Services } from './index.ts'

/**
 * Node composition root.
 *
 * Used by the local server, the integration tests, and the browser E2E suite.
 * It wires SQLite plus the local session adapter. The local adapter is refused
 * on the DeepSpace runtime (`assertProductionSafety`), so this file cannot
 * become a production back door.
 */

export interface NodeServices extends Services {
  db: Database
  sessions: SessionStore
  close: () => void
}

export interface CreateNodeServicesOptions {
  config: AppConfig
  /** Reuse a database handle (tests pass an in-memory one). */
  database?: Database
}

export function createNodeServices(options: CreateNodeServicesOptions): NodeServices {
  const { config } = options
  const db = options.database ?? openDatabase(config.databaseUrl)
  const repos = createSqliteRepositories(db)
  const sessions = new SessionStore(db, repos.users, config.sessionTtlSeconds)

  const auth = new AuthResolver({
    mode: 'local',
    sessions,
    users: repos.users,
    // The local runtime never verifies a platform JWT; the resolver only calls
    // this in `deepspace` mode.
    verifyJwt: async () => ({ result: null }),
    bindings: () => ({}),
    ensureUser: async (user) => repos.users.upsert(user),
  })

  const services = createServices({ config, repos, auth })

  return {
    ...services,
    db,
    sessions,
    close: () => db.close(),
  }
}
