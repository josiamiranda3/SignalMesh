import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FakeRecordRoom,
  createFakeCaller,
  type FakeCaller,
} from '../../server/repositories/records/fake-room.ts'
import {
  createRecordStore,
  createTransport,
  RecordsError,
} from '../../server/repositories/records/transport.ts'
import { createRecordsRepositories } from '../../server/repositories/records/repositories.ts'
import { schemas, COLLECTIONS } from '../../src/schemas.ts'

/**
 * DeepSpace Records behaviour.
 *
 * These tests target the properties that only exist once the data lives behind
 * the Durable Object: schema-driven validation, `uniqueOn` constraints, the
 * `{ kind: ... }` interpretations, paging, and — most importantly — that the
 * collection `permissions` are enforced by the storage layer rather than only by
 * our services.
 *
 * The fake room reproduces the documented RBAC evaluation, so a mistake in the
 * schema (for example granting `member.read: true` instead of `'own'`) fails
 * here rather than leaking data in production.
 */

let room: FakeRecordRoom | null = null

afterEach(() => {
  room?.close()
  room = null
})

function makeRoom(): FakeRecordRoom {
  room = new FakeRecordRoom()
  return room
}

function storeFor(fake: FakeRecordRoom, caller: FakeCaller) {
  return createRecordStore(createTransport(createFakeCaller(fake, caller)))
}

const ALICE = 'user_alice'
const BOB = 'user_bob'

describe('schema declarations', () => {
  it('registers every collection the domain needs', () => {
    const names = schemas.map((schema) => schema.name)
    for (const required of [
      'investigations',
      'evidence',
      'analyses',
      'validations',
      'activity_logs',
      'usage_records',
      'research_queries',
      'app_settings',
    ]) {
      assert.ok(names.includes(required), `schema ausente: ${required}`)
    }
    assert.ok(names.includes('users'), 'users é obrigatório pelo SDK')
  })

  it('declares ownerField on every domain collection', () => {
    for (const schema of schemas) {
      if (schema.name === 'users') continue
      assert.equal(schema.ownerField, 'ownerId', `${schema.name} deve declarar ownerField`)
      assert.ok(
        schema.columns.some((column) => column.name === 'ownerId'),
        `${schema.name} deve ter a coluna ownerId`,
      )
    }
  })

  it('never grants a member wide read/update/delete on domain data', () => {
    for (const schema of schemas) {
      if (schema.name === 'users') continue
      const member = schema.permissions['member']
      assert.ok(member, `${schema.name} sem permissões de member`)
      // `read: true` on another user's rows is the failure this test exists for.
      assert.notEqual(member.read, true, `${schema.name}: member.read não pode ser true`)
      assert.notEqual(member.update, true, `${schema.name}: member.update não pode ser true`)
      assert.notEqual(member.delete, true, `${schema.name}: member.delete não pode ser true`)
      assert.equal(member.read, 'own', `${schema.name}: member.read deve ser 'own'`)
    }
  })

  it('makes the audit and usage ledgers append-only for members', () => {
    for (const name of ['activity_logs', 'usage_records'] as const) {
      const schema = schemas.find((candidate) => candidate.name === name)!
      const member = schema.permissions['member']!
      assert.equal(member.create, true, `${name}: membro precisa poder registrar`)
      assert.equal(member.update, false, `${name}: registro não pode ser reescrito`)
      assert.equal(member.delete, false, `${name}: registro não pode ser apagado`)
    }
  })

  it('declares the evidence uniqueness constraint', () => {
    const evidence = schemas.find((schema) => schema.name === 'evidence')!
    assert.deepEqual(evidence.uniqueOn, ['investigationId', 'urlNormalized'])
  })

  it('declares settings uniqueness per owner and key', () => {
    const settings = schemas.find((schema) => schema.name === 'app_settings')!
    assert.deepEqual(settings.uniqueOn, ['ownerId', 'key'])
  })
})

describe('row-level RBAC enforced by the room', () => {
  it('returns nothing when another user queries a collection', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    await alice.create(COLLECTIONS.investigations, {
      ownerId: ALICE,
      title: 'Da Alice',
      description: '',
      objective: 'Objetivo da Alice',
      topic: 'tema',
      keywords: [],
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const bob = storeFor(fake, { userId: BOB, appAction: false })
    const seenByBob = await bob.query(COLLECTIONS.investigations)
    assert.equal(seenByBob.records.length, 0, 'Bob não pode ver a linha da Alice')

    const seenByAlice = await alice.query(COLLECTIONS.investigations)
    assert.equal(seenByAlice.records.length, 1, 'Alice vê a própria linha')
  })

  it('refuses to read another user’s record by id', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    const id = await alice.create(COLLECTIONS.investigations, {
      ownerId: ALICE,
      title: 'Segredo da Alice',
      description: '',
      objective: 'Objetivo privado',
      topic: 'tema',
      keywords: [],
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const bob = storeFor(fake, { userId: BOB, appAction: false })
    const stolen = await bob.get(COLLECTIONS.investigations, id)
    assert.equal(stolen, null, 'a leitura por id deve falhar para outro usuário')
  })

  it('refuses to update another user’s record', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    const id = await alice.create(COLLECTIONS.investigations, {
      ownerId: ALICE,
      title: 'Original',
      description: '',
      objective: 'Objetivo original da investigação',
      topic: 'tema',
      keywords: [],
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const bob = storeFor(fake, { userId: BOB, appAction: false })
    await assert.rejects(
      () => bob.update(COLLECTIONS.investigations, id, { title: 'Invadido' }),
      (error: unknown) => {
        assert.ok(error instanceof RecordsError)
        assert.equal(error.code, 'denied')
        return true
      },
    )

    const still = await alice.get(COLLECTIONS.investigations, id)
    assert.equal(still?.data['title'], 'Original')
  })

  it('refuses to delete another user’s record', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    const id = await alice.create(COLLECTIONS.investigations, {
      ownerId: ALICE,
      title: 'Não pode sumir',
      description: '',
      objective: 'Objetivo que precisa sobreviver',
      topic: 'tema',
      keywords: [],
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const bob = storeFor(fake, { userId: BOB, appAction: false })
    await assert.rejects(
      () => bob.remove(COLLECTIONS.investigations, id),
      (error: unknown) => error instanceof RecordsError && error.code === 'denied',
    )

    assert.ok(await alice.get(COLLECTIONS.investigations, id), 'a linha deve continuar existindo')
  })

  it('refuses every write for an anonymous caller', async () => {
    const fake = makeRoom()
    const anonymous = storeFor(fake, { userId: null, appAction: false })

    await assert.rejects(
      () =>
        anonymous.create(COLLECTIONS.investigations, {
          ownerId: 'user_none',
          title: 'Anônimo',
          description: '',
          objective: 'Tentativa anônima de escrita',
          topic: 'tema',
          keywords: [],
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      (error: unknown) => error instanceof RecordsError && error.code === 'denied',
    )
  })

  it('scopes the evidence query to the caller', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const now = new Date().toISOString()

    await alice.create(COLLECTIONS.evidence, {
      investigationId: 'inv_alice',
      ownerId: ALICE,
      title: 'Fonte da Alice',
      url: 'https://example.org/a',
      urlNormalized: 'https://example.org/a',
      domain: 'example.org',
      snippet: 'trecho',
      retrievedContent: null,
      publishedAt: null,
      author: null,
      collectedAt: now,
      source: 'exa',
      sourceMetadata: {},
      contentAvailability: [],
      relevanceScore: 0.5,
      relevanceBreakdown: null,
      validationStatus: 'pending',
      note: '',
      createdAt: now,
      updatedAt: now,
    })

    const bob = storeFor(fake, { userId: BOB, appAction: false })
    const bobEvidence = await bob.query(COLLECTIONS.evidence, {
      where: { investigationId: 'inv_alice' },
    })
    assert.equal(bobEvidence.records.length, 0)
  })

  it('does not let one user’s usage rows inflate another’s quota', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const now = new Date().toISOString()

    for (let index = 0; index < 5; index += 1) {
      await alice.create(COLLECTIONS.usageRecords, {
        ownerId: ALICE,
        provider: 'exa',
        operation: 'research',
        status: 'success',
        quantity: 1,
        investigationId: null,
        errorCode: null,
        metadata: {},
        createdAt: now,
      })
    }

    const repos = createRecordsRepositories(storeFor(fake, { userId: BOB, appAction: false }))
    const since = new Date(Date.now() - 86_400_000).toISOString()
    const bobUsage = await repos.usage.countInWindow(BOB, 'research', since)
    assert.equal(bobUsage, 0, 'o consumo da Alice não pode contar para o Bob')

    const aliceRepos = createRecordsRepositories(storeFor(fake, { userId: ALICE, appAction: false }))
    assert.equal(await aliceRepos.usage.countInWindow(ALICE, 'research', since), 5)
  })
})

describe('schema-driven validation', () => {
  it('rejects a record missing a required field', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    await assert.rejects(
      () =>
        alice.create(COLLECTIONS.investigations, {
          ownerId: ALICE,
          // title missing
          description: '',
          objective: 'Objetivo válido',
          topic: 'tema',
          keywords: [],
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof RecordsError)
        assert.equal(error.code, 'invalid')
        assert.match(error.message, /required/i)
        return true
      },
    )
  })

  it('rejects a value longer than maxLength', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    await assert.rejects(
      () =>
        alice.create(COLLECTIONS.investigations, {
          ownerId: ALICE,
          title: 'x'.repeat(200),
          description: '',
          objective: 'Objetivo válido',
          topic: 'tema',
          keywords: [],
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      (error: unknown) => error instanceof RecordsError && error.code === 'invalid',
    )
  })

  it('enforces the evidence composite uniqueness constraint', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const now = new Date().toISOString()

    const base = {
      investigationId: 'inv_1',
      ownerId: ALICE,
      title: 'Fonte',
      domain: 'example.org',
      snippet: '',
      retrievedContent: null,
      publishedAt: null,
      author: null,
      collectedAt: now,
      source: 'exa',
      sourceMetadata: {},
      contentAvailability: [],
      relevanceScore: 0.5,
      relevanceBreakdown: null,
      validationStatus: 'pending',
      note: '',
      createdAt: now,
      updatedAt: now,
    }

    await alice.create(COLLECTIONS.evidence, {
      ...base,
      url: 'https://example.org/a',
      urlNormalized: 'https://example.org/a',
    })

    await assert.rejects(
      () =>
        alice.create(COLLECTIONS.evidence, {
          ...base,
          url: 'https://example.org/a?utm_source=x',
          urlNormalized: 'https://example.org/a',
        }),
      (error: unknown) => {
        assert.ok(error instanceof RecordsError)
        assert.equal(error.code, 'duplicate')
        return true
      },
    )
  })

  it('allows the same URL in a different investigation', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const now = new Date().toISOString()
    const base = {
      ownerId: ALICE,
      title: 'Fonte',
      url: 'https://example.org/a',
      urlNormalized: 'https://example.org/a',
      domain: 'example.org',
      snippet: '',
      retrievedContent: null,
      publishedAt: null,
      author: null,
      collectedAt: now,
      source: 'exa',
      sourceMetadata: {},
      contentAvailability: [],
      relevanceScore: 0.5,
      relevanceBreakdown: null,
      validationStatus: 'pending',
      note: '',
      createdAt: now,
      updatedAt: now,
    }

    await alice.create(COLLECTIONS.evidence, { ...base, investigationId: 'inv_1' })
    // Same URL, different investigation: allowed by the composite constraint.
    await alice.create(COLLECTIONS.evidence, { ...base, investigationId: 'inv_2' })

    assert.equal(fake.rawCount(COLLECTIONS.evidence), 2)
  })

  it('enforces settings uniqueness per owner and key', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    await alice.create(COLLECTIONS.appSettings, {
      ownerId: ALICE,
      key: 'researchDailyLimit',
      value: '3',
    })

    await assert.rejects(
      () =>
        alice.create(COLLECTIONS.appSettings, {
          ownerId: ALICE,
          key: 'researchDailyLimit',
          value: '9',
        }),
      (error: unknown) => error instanceof RecordsError && error.code === 'duplicate',
    )
  })
})

describe('column interpretations', () => {
  it('round-trips JSON arrays and objects', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    const id = await alice.create(COLLECTIONS.investigations, {
      ownerId: ALICE,
      title: 'Com arrays',
      description: '',
      objective: 'Objetivo para testar JSON',
      topic: 'tema',
      keywords: ['um', 'dois', 'três'],
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const row = await alice.get(COLLECTIONS.investigations, id)
    assert.deepEqual(row?.data['keywords'], ['um', 'dois', 'três'])
  })

  it('round-trips nested objects in json columns', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const now = new Date().toISOString()

    const id = await alice.create(COLLECTIONS.evidence, {
      investigationId: 'inv_1',
      ownerId: ALICE,
      title: 'Fonte com breakdown',
      url: 'https://example.org/a',
      urlNormalized: 'https://example.org/a',
      domain: 'example.org',
      snippet: '',
      retrievedContent: null,
      publishedAt: null,
      author: null,
      collectedAt: now,
      source: 'exa',
      sourceMetadata: { providerRequestId: 'req_9', nested: { deep: [1, 2] } },
      contentAvailability: ['text', 'highlights'],
      relevanceScore: 0.61,
      relevanceBreakdown: {
        topical: 0.5,
        recency: 0.7,
        sourceQuality: 0.6,
        objectiveAlignment: 0.4,
        rationale: ['a', 'b'],
        weights: { topical: 0.4, recency: 0.25, sourceQuality: 0.25, objectiveAlignment: 0.1 },
        missing: [],
      },
      validationStatus: 'pending',
      note: '',
      createdAt: now,
      updatedAt: now,
    })

    const row = await alice.get(COLLECTIONS.evidence, id)
    assert.deepEqual(row?.data['contentAvailability'], ['text', 'highlights'])
    assert.deepEqual(row?.data['sourceMetadata'], {
      providerRequestId: 'req_9',
      nested: { deep: [1, 2] },
    })
    const breakdown = row?.data['relevanceBreakdown'] as { rationale: string[] }
    assert.deepEqual(breakdown.rationale, ['a', 'b'])
  })

  it('round-trips booleans as 0/1 in the column but boolean on the wire', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    const id = await alice.create(COLLECTIONS.analyses, {
      investigationId: 'inv_1',
      ownerId: ALICE,
      evidenceIds: ['evi_1'],
      model: 'gemini-2.5-flash',
      status: 'completed',
      executiveSummary: 'Resumo',
      findings: [],
      keyPoints: [],
      supportedClaims: [],
      contradictions: [],
      limitations: [],
      informationGaps: [],
      objectiveAlignment: 'Alinhado',
      referenceIds: ['evi_1'],
      insufficientEvidence: true,
      rawStructuredOutput: null,
      usage: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
    })

    const row = await alice.get(COLLECTIONS.analyses, id)
    assert.equal(row?.data['insufficientEvidence'], true)
  })
})

describe('query behaviour', () => {
  it('pages results and reports nextOffset', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const now = new Date().toISOString()

    for (let index = 0; index < 7; index += 1) {
      await alice.create(COLLECTIONS.activityLogs, {
        investigationId: null,
        ownerId: ALICE,
        eventType: 'investigation.updated',
        description: `evento ${index}`,
        metadata: {},
        createdAt: new Date(Date.parse(now) + index * 1000).toISOString(),
      })
    }

    const first = await alice.query(COLLECTIONS.activityLogs, {
      orderBy: 'createdAt',
      orderDir: 'desc',
      limit: 3,
    })
    assert.equal(first.records.length, 3)
    assert.equal(first.nextOffset, 3)

    const second = await alice.query(COLLECTIONS.activityLogs, {
      orderBy: 'createdAt',
      orderDir: 'desc',
      limit: 3,
      offset: first.nextOffset,
    })
    assert.equal(second.records.length, 3)
    assert.notEqual(second.records[0]!.recordId, first.records[0]!.recordId)
  })

  it('rejects a where clause on an unknown field', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    await assert.rejects(
      () => alice.query(COLLECTIONS.investigations, { where: { naoExiste: 'x' } }),
      (error: unknown) => error instanceof RecordsError && error.code === 'unknown',
    )
  })

  it('rejects a deleteWhere without a filter', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    await assert.rejects(
      () => alice.deleteWhere(COLLECTIONS.investigations, {}),
      (error: unknown) => error instanceof RecordsError,
    )
  })

  it('deleteWhere only removes rows the caller may delete', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const now = new Date().toISOString()
    const base = {
      title: 'x',
      description: '',
      objective: 'Objetivo válido para o teste',
      topic: 'tema',
      keywords: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }

    await alice.create(COLLECTIONS.investigations, { ...base, ownerId: ALICE })
    await alice.create(COLLECTIONS.investigations, { ...base, ownerId: ALICE })

    const bob = storeFor(fake, { userId: BOB, appAction: false })
    const deleted = await bob.deleteWhere(COLLECTIONS.investigations, { status: 'active' })
    assert.equal(deleted, 0, 'Bob não pode apagar linhas da Alice')
    assert.equal(fake.rawCount(COLLECTIONS.investigations), 2)
  })
})

describe('admin transport is scoped to aggregates', () => {
  it('can count across owners when acting as app code', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const bob = storeFor(fake, { userId: BOB, appAction: false })
    const now = new Date().toISOString()

    for (const ownerStore of [alice, bob]) {
      await ownerStore.create(COLLECTIONS.usageRecords, {
        ownerId: ownerStore === alice ? ALICE : BOB,
        provider: 'exa',
        operation: 'research',
        status: 'success',
        quantity: 1,
        investigationId: null,
        errorCode: null,
        metadata: {},
        createdAt: now,
      })
    }

    const memberView = await alice.query(COLLECTIONS.usageRecords)
    assert.equal(memberView.records.length, 1, 'visão de membro vê só o próprio consumo')

    const admin = storeFor(fake, { userId: 'owner_of_app', appAction: true })
    const adminView = await admin.query(COLLECTIONS.usageRecords)
    assert.equal(adminView.records.length, 2, 'a visão administrativa soma a plataforma')
  })
})
