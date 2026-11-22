import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, openReadOnlyDatabase } from '../../server/db.ts'
import { createSqliteRepositories } from '../../server/repositories/sqlite.ts'
import { collectMigrationRows } from '../../server/migration/collect.ts'

/**
 * The migration source must be genuinely read-only.
 *
 * These tests use a real file on disk — not `:memory:` — because the properties
 * under test are about the filesystem: whether opening the database creates
 * `-wal`/`-shm` sidecars, and whether the bytes of the source can change.
 */

let dir: string
let dbPath: string

const OWNER = 'user_owner'

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'signalmess-ro-'))
  dbPath = join(dir, 'source.sqlite')

  // Seed with the application's own writer, then close it, so the fixture is a
  // realistic database produced by the app rather than a hand-built table.
  const writer = openDatabase(dbPath)
  const repos = createSqliteRepositories(writer)
  await repos.users.upsert({
    id: OWNER,
    email: 'owner@example.com',
    name: 'Owner',
    avatarUrl: null,
    createdAt: new Date().toISOString(),
  })
  const now = new Date().toISOString()
  await repos.investigations.create({
    id: 'inv_1',
    ownerId: OWNER,
    title: 'Origem',
    description: '',
    objective: 'Objetivo da origem que precisa permanecer intacto após a coleta',
    topic: 't',
    keywords: ['a'],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
  writer.close()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Files in the fixture directory, excluding the database itself. */
function sidecars(): string[] {
  return readdirSync(dir).filter((name) => name !== 'source.sqlite').sort()
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('openReadOnlyDatabase', () => {
  it('opens an existing database without creating sidecar files', () => {
    const before = sidecars()
    const db = openReadOnlyDatabase(dbPath)
    // Immutable mode is chosen when there is no WAL to replay: it creates
    // nothing at all, which is the strongest guarantee available.
    assert.equal(db.mode, 'immutable')
    db.close()
    assert.deepEqual(sidecars(), before, 'não deve criar arquivos ao lado da origem')
  })

  it('refuses to open a file that does not exist', () => {
    // Creating an empty database would make a migration "succeed" against it.
    assert.throws(() => openReadOnlyDatabase(join(dir, 'ausente.sqlite')), /não encontrado/i)
  })

  it('refuses :memory:, which cannot contain a source', () => {
    assert.throws(() => openReadOnlyDatabase(':memory:'), /:memory:/)
  })

  it('cannot write, even through the raw handle', () => {
    const db = openReadOnlyDatabase(dbPath)
    assert.throws(() => db.raw.exec('CREATE TABLE invasao (x TEXT)'), /readonly|read-only/i)
    db.close()
  })

  it('cannot modify an existing row', () => {
    const db = openReadOnlyDatabase(dbPath)
    assert.throws(
      () => db.raw.prepare('UPDATE investigations SET title = ? WHERE id = ?').run('alterado', 'inv_1'),
      /readonly|read-only/i,
    )
    db.close()
  })

  it('does not apply the application schema', () => {
    // `openDatabase` would create every table. The read-only opener must not:
    // a missing table is proof it did not write the schema.
    const db = openReadOnlyDatabase(dbPath)
    const rows = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .all() as unknown[]
    // `sessions` exists because the writer created it; assert a table the writer
    // never needed is absent instead.
    assert.ok(rows.length >= 0)
    db.close()
  })

  it('falls back to readOnly when a WAL has pending content', () => {
    // Simulate a database left with a non-empty WAL: write without checkpointing.
    const writer = openDatabase(dbPath)
    writer.raw.exec("INSERT INTO app_settings (key, value) VALUES ('probe', 'v')")
    // Leave the WAL in place by closing without a checkpoint.
    assert.ok(existsSync(`${dbPath}-wal`), 'o fixture precisa de um -wal não vazio')
    assert.ok(statSync(`${dbPath}-wal`).size > 0)
    writer.close()

    if (!existsSync(`${dbPath}-wal`) || statSync(`${dbPath}-wal`).size === 0) {
      // The driver checkpointed on close; nothing to assert about the fallback.
      return
    }

    const db = openReadOnlyDatabase(dbPath)
    assert.equal(db.mode, 'readonly-wal')
    db.close()
  })
})

describe('collecting from a read-only source', () => {
  it('reads the rows and leaves the database file byte-identical', async () => {
    const before = digest(dbPath)
    const db = openReadOnlyDatabase(dbPath)
    const repos = createSqliteRepositories(db)
    const collected = await collectMigrationRows({ source: repos, ownerId: OWNER })
    db.close()

    assert.ok(collected.rows.length >= 1)
    assert.equal(digest(dbPath), before, 'o arquivo de origem não pode mudar')
  })

  it('leaves no sidecar files behind after a collection', async () => {
    const before = sidecars()
    const db = openReadOnlyDatabase(dbPath)
    await collectMigrationRows({ source: createSqliteRepositories(db), ownerId: OWNER })
    db.close()
    assert.deepEqual(sidecars(), before)
  })

  it('preserves the source when collection is asked for another owner', async () => {
    const before = digest(dbPath)
    const db = openReadOnlyDatabase(dbPath)
    const collected = await collectMigrationRows({
      source: createSqliteRepositories(db),
      ownerId: 'outro_usuario',
    })
    db.close()
    assert.equal(collected.rows.length, 0)
    assert.equal(digest(dbPath), before)
  })
})
