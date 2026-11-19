import type { Analysis, AnalysisReference, Evidence } from '../../shared/domain.ts'
import type { AnalysisRequestInput } from '../../shared/schemas.ts'
import { AnalysisValidationError, buildAnalysisPrompt } from '../../shared/analysis.ts'
import type { Repositories } from '../repositories/ports.ts'
import { AppError, errors } from '../lib/errors.ts'
import { createId, excerpt, nowIso } from '../lib/util.ts'
import type { GeminiClient } from '../integrations/gemini.ts'
import type { ActivityService } from './activity.ts'
import type { EvidenceService } from './evidence.ts'
import type { InvestigationService } from './investigations.ts'
import { UsageService } from './usage.ts'

/**
 * AI analysis orchestration.
 *
 * The only evidence ever sent to the model is evidence that is already stored
 * in this investigation and owned by the caller. The response is validated
 * against the real evidence id set before anything is persisted; a model that
 * cites a nonexistent source produces a FAILED analysis record, never a
 * partially trusted one.
 *
 * A contract violation is an upstream data problem, so it surfaces as
 * `invalid_provider_response` (502) rather than an internal error — the caller
 * can act on it, and the operator can tell a bad model response apart from a
 * server bug in the logs.
 */
export class AnalysisService {
  constructor(
    private readonly repos: Repositories,
    private readonly investigations: InvestigationService,
    private readonly evidence: EvidenceService,
    private readonly usage: UsageService,
    private readonly activity: ActivityService,
    private readonly gemini: GeminiClient,
  ) {}

  async list(investigationId: string, ownerId: string): Promise<Analysis[]> {
    await this.investigations.requireOwned(investigationId, ownerId)
    return this.repos.analyses.listByInvestigation(investigationId)
  }

  async latest(investigationId: string, ownerId: string): Promise<Analysis | null> {
    await this.investigations.requireOwned(investigationId, ownerId)
    return this.repos.analyses.latestForInvestigation(investigationId)
  }

  async requireOwned(id: string, ownerId: string): Promise<Analysis> {
    const analysis = await this.repos.analyses.findById(id)
    if (!analysis || analysis.ownerId !== ownerId) throw errors.notFound('Análise não encontrada')
    return analysis
  }

  async run(investigationId: string, ownerId: string, input: AnalysisRequestInput): Promise<Analysis> {
    const investigation = await this.investigations.requireOwned(investigationId, ownerId)
    this.gemini.assertUsable()

    const allEvidence = await this.repos.evidence.listByInvestigation(investigationId)
    if (allEvidence.length === 0) {
      throw errors.invalid(
        'Não há evidências nesta investigação. Adicione fontes antes de solicitar uma análise.',
      )
    }

    const selected = selectEvidence(allEvidence, input.evidenceIds)
    if (selected.length === 0) {
      throw errors.invalid('Nenhuma evidência válida foi selecionada para a análise.')
    }

    const reservation = await this.usage.reserve({ ownerId, operation: 'analysis', investigationId })

    const prompt = buildAnalysisPrompt({
      investigationTitle: investigation.title,
      topic: investigation.topic,
      objective: investigation.objective,
      evidences: selected.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        domain: item.domain,
        publishedAt: item.publishedAt,
        content: buildEvidenceContent(item),
        missingData: missingDataFor(item),
      })),
    })

    await this.activity.record({
      investigationId,
      ownerId,
      eventType: 'analysis.requested',
      description: `Análise solicitada com ${selected.length} evidência(s)`,
      metadata: { evidenceIds: selected.map((item) => item.id), model: this.gemini.model },
    })

    try {
      const outcome = await this.gemini.analyze({
        systemInstruction: prompt.systemInstruction,
        userPrompt: prompt.userPrompt,
        allowedEvidenceIds: selected.map((item) => item.id),
      })

      const referenceIds = new Set<string>(outcome.citedEvidenceIds)
      for (const finding of outcome.payload.findings) for (const id of finding.evidenceIds) referenceIds.add(id)
      for (const contradiction of outcome.payload.contradictions) {
        for (const id of contradiction.evidenceIds) referenceIds.add(id)
      }

      const references: AnalysisReference[] = [...referenceIds]
        .map((id) => selected.find((item) => item.id === id))
        .filter((item): item is Evidence => Boolean(item))
        .map((item) => ({ evidenceId: item.id, title: item.title, url: item.url, domain: item.domain }))

      const analysis: Analysis = {
        id: createId('ana'),
        investigationId,
        ownerId,
        evidenceIds: selected.map((item) => item.id),
        model: outcome.model,
        status: 'completed',
        executiveSummary: outcome.payload.executiveSummary,
        findings: outcome.payload.findings,
        keyPoints: outcome.payload.keyPoints,
        supportedClaims: outcome.payload.supportedClaims,
        contradictions: outcome.payload.contradictions,
        limitations: outcome.payload.limitations,
        informationGaps: outcome.payload.informationGaps,
        objectiveAlignment: outcome.payload.objectiveAlignment,
        references,
        insufficientEvidence: outcome.payload.insufficientEvidence,
        rawStructuredOutput: outcome.raw,
        usage: outcome.usage,
        errorMessage: null,
        createdAt: nowIso(),
      }

      await this.repos.analyses.create(analysis)

      await this.usage.settle({
        ownerId,
        operation: 'analysis',
        token: reservation.token,
        status: 'success',
        investigationId,
        metadata: {
          model: outcome.model,
          evidenceCount: selected.length,
          totalTokens: outcome.usage.totalTokens,
        },
      })

      await this.activity.record({
        investigationId,
        ownerId,
        eventType: 'analysis.completed',
        description: `Análise concluída com ${outcome.payload.findings.length} descoberta(s)`,
        metadata: {
          analysisId: analysis.id,
          model: outcome.model,
          evidenceCount: selected.length,
          referenceCount: references.length,
        },
      })

      return analysis
    } catch (error) {
      const code = UsageService.errorCodeFor(error)
      const message = describeError(error)

      await this.usage.settle({
        ownerId,
        operation: 'analysis',
        token: reservation.token,
        status: 'error',
        investigationId,
        errorCode: code,
      })

      // Record the failed attempt so the user sees what happened instead of an
      // empty screen — but never as a "completed" analysis.
      const failed: Analysis = {
        id: createId('ana'),
        investigationId,
        ownerId,
        evidenceIds: selected.map((item) => item.id),
        model: this.gemini.model,
        status: 'failed',
        executiveSummary: '',
        findings: [],
        keyPoints: [],
        supportedClaims: [],
        contradictions: [],
        limitations: [],
        informationGaps: [],
        objectiveAlignment: '',
        references: [],
        insufficientEvidence: true,
        rawStructuredOutput:
          error instanceof AnalysisValidationError ? { issues: error.issues } : null,
        usage: null,
        errorMessage: message,
        createdAt: nowIso(),
      }
      await this.repos.analyses.create(failed)

      await this.activity.record({
        investigationId,
        ownerId,
        eventType: 'analysis.failed',
        description: `Análise não concluída: ${code}`,
        metadata: { analysisId: failed.id, code, message },
      })

      // A schema/reference violation is the provider producing unusable output,
      // not a server fault. Surface it as such so the UI can explain it.
      if (error instanceof AnalysisValidationError) {
        throw errors.provider(
          'invalid_provider_response',
          message,
          'gemini',
          false,
          error,
        )
      }

      throw error
    }
  }

  /** Individual analyses are audit records; deletion is not offered. */
  async remove(): Promise<never> {
    throw errors.invalid(
      'Análises são registros de auditoria e não podem ser excluídas individualmente; solicite uma nova análise.',
    )
  }

  /**
   * After evidence is deleted, an analysis can reference a source that no
   * longer exists. Reports which analyses are affected so the UI can warn.
   */
  async referencesBroken(investigationId: string, ownerId: string): Promise<string[]> {
    const [analyses, evidence] = await Promise.all([
      this.list(investigationId, ownerId),
      this.repos.evidence.listByInvestigation(investigationId),
    ])
    const alive = new Set(evidence.map((item) => item.id))
    return analyses
      .filter((analysis) => analysis.evidenceIds.some((id) => !alive.has(id)))
      .map((analysis) => analysis.id)
  }
}

function selectEvidence(all: Evidence[], ids: string[] | undefined): Evidence[] {
  if (!ids || ids.length === 0) return all
  const allowed = new Set(ids)
  return all.filter((item) => allowed.has(item.id))
}

/**
 * Content sent to the model. Full retrieved text when available, otherwise the
 * snippet, clearly labelled so the model knows it is a partial view.
 */
function buildEvidenceContent(evidence: Evidence): string {
  const body = evidence.retrievedContent?.trim()
  if (body) return excerpt(body, 6000)
  if (evidence.snippet.trim()) {
    return `[SOMENTE TRECHO DISPONÍVEL]\n${excerpt(evidence.snippet, 1500)}`
  }
  return '[NENHUM CONTEÚDO RECUPERADO — APENAS METADADOS]'
}

function missingDataFor(evidence: Evidence): string[] {
  const missing: string[] = []
  if (!evidence.retrievedContent) missing.push('conteúdo integral')
  if (!evidence.publishedAt) missing.push('data de publicação')
  if (!evidence.author) missing.push('autoria')
  return missing
}

function describeError(error: unknown): string {
  if (error instanceof AnalysisValidationError) {
    const first = error.issues[0]
    return first
      ? `A resposta da IA foi rejeitada pela validação de schema (${first.path}: ${first.message}). Nenhuma conclusão foi registrada.`
      : 'A resposta da IA foi rejeitada pela validação de schema. Nenhuma conclusão foi registrada.'
  }
  if (error instanceof AppError) return error.message
  return 'Falha inesperada ao gerar a análise.'
}
