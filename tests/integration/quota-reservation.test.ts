import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../../server/db.ts'
import { createSqliteRepositories } from '../../server/repositories/sqlite.ts'
import type { Database } from '../../server/db.ts'
import type { Repositories } from '../../server/repositories/ports.ts'

/**
 * Exclusive paid-operation reservations.
 *
 * The guard moved from an in-memory `Map` to storage because the Worker builds
 * its services per request, so a `Map` starts empty on every invocation and
 * cannot see another isolate's reservation. Storage enforces exclusivity with a
 * unique index; these tests prove the *contract* both adapters must satisfy.
 *
 * What is proven here: the SQLite adapter rejects a second live reservation and
 * reclaims an expired one. What is **not** proven: that the RecordRoom behaves
 * identically under real concurrency — that requires workerd, which does not
 * start in this environment (docs/validation-v0.2.4.1.md §1.4). The DeepSpace
 * adapter is written against the same `uniqueOn` index the SDK creates, but its
 * runtime behaviour is unverified.
 */

let db: Database
let repos: Repositories

before(() => {
  db = openDatabase(':memory:')
  repos = createSqliteRepositories(db)
})

after(() => {
  db.close()
})

function request(ownerId: string, operation: string, token: string, ttlMs = 60_000) {
  return {
    ownerId,
    operation,
    token,
    expiresAt: Date.now() + ttlMs,
    createdAt: new Date().toISOString(),
  }
}

describe('reservation: exclusivity', () => {
  it('grants the first request and refuses the second', async () => {
    const first = await repos.reservations.acquire(request('user_a', 'analysis', 'tok_1'))
    assert.ok(first, 'a primeira reserva deve ser concedida')

    const second = await repos.reservations.acquire(request('user_a', 'analysis', 'tok_2'))
    assert.equal(second, null, 'a segunda deve ser recusada enquanto a primeira vive')
  })

  it('does not let two different users block each other', async () => {
    const a = await repos.reservations.acquire(request('user_b', 'research', 'tok_b'))
    const b = await repos.reservations.acquire(request('user_c', 'research', 'tok_c'))
    assert.ok(a)
    assert.ok(b, 'usuários distintos não compartilham a reserva')
  })

  it('does not let two operations of the same user block each other', async () => {
    const research = await repos.reservations.acquire(request('user_d', 'research', 'tok_r'))
    const analysis = await repos.reservations.acquire(request('user_d', 'analysis', 'tok_a'))
    assert.ok(research)
    assert.ok(analysis, 'pesquisa e análise têm reservas independentes')
  })

  it('refuses a concurrent race: exactly one of many wins', async () => {
    // Ten simultaneous attempts for the same slot. The unique index — not a
    // read-then-write check — must let exactly one through.
    const attempts = Array.from({ length: 10 }, (_, index) =>
      repos.reservations.acquire(request('user_race', 'analysis', `tok_race_${index}`)),
    )
    const results = await Promise.all(attempts)
    const winners = results.filter(Boolean)
    assert.equal(winners.length, 1, `exatamente uma reserva deve vencer, vieram ${winners.length}`)
  })
})

describe('reservation: release', () => {
  it('frees the slot for the holder', async () => {
    const held = await repos.reservations.acquire(request('user_e', 'analysis', 'tok_hold'))
    assert.ok(held)

    const released = await repos.reservations.release({
      ownerId: 'user_e',
      operation: 'analysis',
      token: 'tok_hold',
    })
    assert.equal(released, true)

    const again = await repos.reservations.acquire(request('user_e', 'analysis', 'tok_next'))
    assert.ok(again, 'após liberar, a reserva pode ser tomada novamente')
  })

  it('does not let a wrong token release someone else\'s reservation', async () => {
    const held = await repos.reservations.acquire(request('user_f', 'analysis', 'tok_owner'))
    assert.ok(held)

    const wrong = await repos.reservations.release({
      ownerId: 'user_f',
      operation: 'analysis',
      token: 'tok_impostor',
    })
    assert.equal(wrong, false)

    const blocked = await repos.reservations.acquire(request('user_f', 'analysis', 'tok_late'))
    assert.equal(blocked, null, 'a reserva original deve continuar válida')
  })

  it('reports false when releasing something that does not exist', async () => {
    const released = await repos.reservations.release({
      ownerId: 'user_nobody',
      operation: 'research',
      token: 'tok_none',
    })
    assert.equal(released, false)
  })
})

describe('reservation: expiry', () => {
  it('reclaims an expired reservation instead of blocking forever', async () => {
    // A crashed request leaves the row behind; the next caller must not be
    // locked out beyond the TTL.
    const stale = await repos.reservations.acquire(request('user_g', 'analysis', 'tok_stale', -1_000))
    assert.ok(stale, 'a reserva expirada é gravada')

    const fresh = await repos.reservations.acquire(request('user_g', 'analysis', 'tok_fresh'))
    assert.ok(fresh, 'a reserva expirada deve ser retomada pelo próximo chamador')
    assert.equal(fresh!.token, 'tok_fresh')
  })

  it('purges expired rows', async () => {
    await repos.reservations.acquire(request('user_h', 'research', 'tok_old', -5_000))
    const purged = await repos.reservations.purgeExpired(Date.now())
    assert.ok(purged >= 1, `esperava ao menos 1 removida, veio ${purged}`)

    const after = await repos.reservations.acquire(request('user_h', 'research', 'tok_new'))
    assert.ok(after)
  })
})
