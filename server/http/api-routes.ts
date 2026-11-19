import { Hono } from 'hono'
import type { z } from 'zod'
import type {
  Analysis,
  Evidence,
  Investigation,
  Validation,
  ValidationStatus,
} from '../../shared/domain.ts'
import type {
  ApiErrorPayload,
  DashboardSummary,
  InvestigationDetail,
  ResearchResponse,
  SettingsResponse,
} from '../../shared/api.ts'
import {
  analysisRequestSchema,
  evidenceBulkCreateSchema,
  evidenceCreateSchema,
  evidenceUpdateSchema,
  exportQuerySchema,
  investigationCreateSchema,
  investigationStatusSchema,
  investigationUpdateSchema,
  listQuerySchema,
  researchRequestSchema,
  settingsQuotaSchema,
  validationSchema,
} from '../../shared/schemas.ts'
import { AppError, errors } from '../lib/errors.ts'
import { requireUser, toPublicUser, type AppEnv } from './middleware.ts'
import { VALIDATION_STATUSES } from '../../shared/domain.ts'

/**
 * HTTP surface.
 *
 * Sits at the API root. Every route validates input with the shared schemas,
 * delegates to a service, and returns the common envelope. Errors are converted
 * exactly once, in `app.onError`, so no route needs its own try/catch and no
 * internal detail escapes.
 */
export function createApiRoutes(): Hono<AppEnv> {
  const api = new Hono<AppEnv>()

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------
  api.get('/dashboard', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const summary: DashboardSummary = await services.dashboard.summary(user.id)
    return c.json({ success: true as const, data: summary })
  })

  // ---------------------------------------------------------------------------
  // Investigations
  // ---------------------------------------------------------------------------
  api.get('/investigations', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const query = parseQuery(listQuerySchema, c.req.query())
    const page = await services.investigations.list(user.id, query)
    return c.json({ success: true as const, data: page })
  })

  api.post('/investigations', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const input = parseBody(investigationCreateSchema, await readJson(c))
    const investigation = await services.investigations.create(user.id, input)
    return c.json({ success: true as const, data: investigation }, 201)
  })

  api.get('/investigations/:id', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const id = c.req.param('id')

    const investigation = await services.investigations.requireOwned(id, user.id)
    const [evidence, analyses, validations, activity, byValidationStatus, quota] = await Promise.all([
      services.repos.evidence.listByInvestigation(id),
      services.repos.analyses.listByInvestigation(id),
      services.repos.validations.listByInvestigation(id),
      services.activity.listByInvestigation(id, 100),
      services.evidence.countsForInvestigation(id),
      services.usage.snapshot(user.id),
    ])

    const detail: InvestigationDetail = {
      investigation,
      evidence,
      analyses,
      validations,
      activity,
      counts: {
        evidence: evidence.length,
        byValidationStatus,
        analyses: analyses.length,
        validations: validations.length,
      },
      quota,
    }
    return c.json({ success: true as const, data: detail })
  })

  api.patch('/investigations/:id', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const input = parseBody(investigationUpdateSchema, await readJson(c))
    const investigation = await services.investigations.update(c.req.param('id'), user.id, input)
    return c.json({ success: true as const, data: investigation })
  })

  api.post('/investigations/:id/status', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const input = parseBody(investigationStatusSchema, await readJson(c))
    const investigation = await services.investigations.changeStatus(c.req.param('id'), user.id, input.status)
    return c.json({ success: true as const, data: investigation })
  })

  api.post('/investigations/:id/archive', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const investigation = await services.investigations.archive(c.req.param('id'), user.id)
    return c.json({ success: true as const, data: investigation })
  })

  api.delete('/investigations/:id', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    await services.investigations.remove(c.req.param('id'), user.id)
    return c.json({ success: true as const, data: { deleted: true } })
  })

  api.get('/investigations/:id/history', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const id = c.req.param('id')
    await services.investigations.requireOwned(id, user.id)
    const activity = await services.activity.listByInvestigation(id, 500)
    return c.json({ success: true as const, data: activity })
  })

  // ---------------------------------------------------------------------------
  // Research
  // ---------------------------------------------------------------------------
  api.post('/investigations/:id/research', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const input = parseBody(researchRequestSchema, await readJson(c))
    const result: ResearchResponse = await services.research.search(c.req.param('id'), user.id, input)
    return c.json({ success: true as const, data: result })
  })

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------
  api.get('/investigations/:id/evidence', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const evidence = await services.evidence.list(c.req.param('id'), user.id)
    return c.json({ success: true as const, data: evidence })
  })

  api.post('/investigations/:id/evidence', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const input = parseBody(evidenceCreateSchema, await readJson(c))
    const result = await services.evidence.addOne(c.req.param('id'), user.id, input)
    if (result.duplicate) {
      return c.json(
        {
          success: true as const,
          data: { evidence: result.evidence, duplicate: true as const },
        },
        200,
      )
    }
    return c.json({ success: true as const, data: result }, 201)
  })

  api.post('/investigations/:id/evidence/bulk', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const input = parseBody(evidenceBulkCreateSchema, await readJson(c))
    const result = await services.evidence.addMany(c.req.param('id'), user.id, input)
    return c.json({ success: true as const, data: result }, 201)
  })

  api.patch('/evidence/:id', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const input = parseBody(evidenceUpdateSchema, await readJson(c))
    if (input.note === undefined) throw errors.invalid('Nenhum campo para atualizar')
    const evidence = await services.evidence.updateNote(c.req.param('id'), user.id, input.note)
    return c.json({ success: true as const, data: evidence })
  })

  api.delete('/evidence/:id', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    await services.evidence.remove(c.req.param('id'), user.id)
    return c.json({ success: true as const, data: { deleted: true } })
  })

  api.get('/evidence/:id/validations', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const history = await services.validation.historyForEvidence(c.req.param('id'), user.id)
    return c.json({ success: true as const, data: history })
  })

  api.post('/evidence/:id/validation', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const evidenceId = c.req.param('id')
    const input = parseBody(validationSchema, await readJson(c))
    const evidence = await services.evidence.requireOwned(evidenceId, user.id)
    const result = await services.validation.record({
      investigationId: evidence.investigationId,
      evidenceId,
      ownerId: user.id,
      status: input.status,
      justification: input.justification,
    })
    return c.json({ success: true as const, data: result }, 201)
  })

  // ---------------------------------------------------------------------------
  // Analyses
  // ---------------------------------------------------------------------------
  api.get('/investigations/:id/analyses', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const analyses = await services.analysis.list(c.req.param('id'), user.id)
    return c.json({ success: true as const, data: analyses })
  })

  api.post('/investigations/:id/analyses', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const input = parseBody(analysisRequestSchema, await readJson(c))
    const analysis: Analysis = await services.analysis.run(c.req.param('id'), user.id, input)
    return c.json({ success: true as const, data: analysis }, 201)
  })

  api.get('/analyses/:id', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const analysis = await services.analysis.requireOwned(c.req.param('id'), user.id)
    return c.json({ success: true as const, data: analysis })
  })

  // ---------------------------------------------------------------------------
  // Validations overview
  // ---------------------------------------------------------------------------
  api.get('/validations', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const status = c.req.query('status')
    const parsedStatus = VALIDATION_STATUSES.includes(status as ValidationStatus)
      ? (status as ValidationStatus)
      : undefined

    const investigations = await services.repos.investigations.listByOwner(user.id)
    const results: Array<{
      evidence: Evidence
      investigation: Pick<Investigation, 'id' | 'title'>
      latestValidation: Validation | null
    }> = []

    for (const investigation of investigations) {
      const evidence = await services.repos.evidence.listByInvestigation(investigation.id)
      for (const item of evidence) {
        if (parsedStatus && item.validationStatus !== parsedStatus) continue
        const history = await services.repos.validations.listByEvidence(item.id)
        results.push({
          evidence: item,
          investigation: { id: investigation.id, title: investigation.title },
          latestValidation: history[0] ?? null,
        })
      }
    }

    results.sort((a, b) => (a.evidence.collectedAt < b.evidence.collectedAt ? 1 : -1))
    return c.json({ success: true as const, data: results })
  })

  // ---------------------------------------------------------------------------
  // Activity / history
  // ---------------------------------------------------------------------------
  api.get('/history', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const limit = clampInt(c.req.query('limit'), 1, 200, 100)
    const offset = clampInt(c.req.query('offset'), 0, 10_000, 0)
    const [items, total] = await Promise.all([
      services.activity.listByOwner(user.id, limit, offset),
      services.activity.countByOwner(user.id),
    ])
    return c.json({ success: true as const, data: { items, total, limit, offset } })
  })

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  api.get('/investigations/:id/export', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const query = parseQuery(exportQuerySchema, c.req.query())
    const payload = await services.exports.build(c.req.param('id'), user.id, query)

    await services.activity.record({
      investigationId: c.req.param('id'),
      ownerId: user.id,
      eventType: 'export.generated',
      description: `Exportação ${query.format.toUpperCase()} (${query.scope}) gerada`,
      metadata: { format: query.format, scope: query.scope, filename: payload.filename },
    })

    return new Response(payload.body, {
      status: 200,
      headers: {
        'content-type': payload.contentType,
        'content-disposition': `attachment; filename="${payload.filename}"`,
        'cache-control': 'no-store',
      },
    })
  })

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  api.get('/settings', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const [quota, usageHistory] = await Promise.all([
      services.usage.snapshot(user.id),
      services.usage.listForOwner(user.id, 25),
    ])
    const payload: SettingsResponse = {
      user: toPublicUser(user),
      quota,
      providers: {
        exa: {
          configured: services.exa.configured,
          enabled: services.config.externalApisEnabled && services.exa.configured,
          searchType: services.config.exaSearchType,
        },
        gemini: {
          configured: services.gemini.configured,
          enabled: services.config.externalApisEnabled && services.gemini.configured,
          model: services.gemini.model,
        },
        externalApisEnabled: services.config.externalApisEnabled,
        paidOperationsEnabled: services.config.paidOperationsEnabled,
      },
      usageHistory,
      limits: {
        researchDailyLimit: services.config.researchDailyLimit,
        analysisDailyLimit: services.config.analysisDailyLimit,
        researchGlobalDailyLimit: services.config.researchGlobalDailyLimit,
        analysisGlobalDailyLimit: services.config.analysisGlobalDailyLimit,
      },
    }
    return c.json({ success: true as const, data: payload })
  })

  api.patch('/settings/limits', requireUser, async (c) => {
    const services = c.get('services')
    const user = c.get('user')
    const input = parseBody(settingsQuotaSchema, await readJson(c))

    // Per-user limit overrides are an administrative concern. The local build
    // accepts them only for the user's own display/limit preference, never
    // above the server-side global ceiling.
    if (input.researchDailyLimit !== undefined) {
      await services.repos.settings.set(`user:${user.id}:researchDailyLimit`, String(input.researchDailyLimit))
    }
    if (input.analysisDailyLimit !== undefined) {
      await services.repos.settings.set(`user:${user.id}:analysisDailyLimit`, String(input.analysisDailyLimit))
    }
    const quota = await services.usage.snapshot(user.id)
    return c.json({ success: true as const, data: quota })
  })

  return api
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw errors.invalid('Corpo da requisição deve ser JSON válido')
  }
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw errors.invalid(
      'Dados inválidos',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(raiz)',
        message: issue.message,
      })),
    )
  }
  return parsed.data
}

function parseQuery<T>(schema: z.ZodType<T>, query: Record<string, string>): T {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) {
    if (value !== '' && value !== undefined) clean[key] = value
  }
  const parsed = schema.safeParse(clean)
  if (!parsed.success) {
    throw errors.invalid(
      'Parâmetros inválidos',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(raiz)',
        message: issue.message,
      })),
    )
  }
  return parsed.data
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

/** Shape every unhandled failure into the API's error envelope. */
export function toErrorResponse(error: unknown): { status: number; body: { success: false; error: ApiErrorPayload } } {
  if (error instanceof AppError) {
    return { status: error.status, body: { success: false, error: error.toPayload() } }
  }
  // Never surface internal details (SQL, stack traces, paths) to a client.
  return {
    status: 500,
    body: {
      success: false,
      error: {
        code: 'internal_error',
        message: 'Ocorreu um erro interno. Tente novamente em instantes.',
        retryable: false,
      },
    },
  }
}
