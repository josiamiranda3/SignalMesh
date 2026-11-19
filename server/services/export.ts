import type { ExportQueryInput } from '../../shared/schemas.ts'
import type { Repositories } from '../repositories/ports.ts'
import type { ActivityService } from './activity.ts'
import type { InvestigationService } from './investigations.ts'

/**
 * Export.
 *
 * The bundle carries ids and foreign keys so the data can be reconstructed
 * elsewhere, and it contains only rows owned by the caller. Credentials,
 * session tokens and other users' data are never included — the export reads
 * exclusively from the caller's investigation.
 *
 * CSV is emitted as RFC 4180 with a UTF-8 BOM so Excel opens accented text
 * correctly; multi-line and quoted values are escaped.
 */

export interface ExportPayload {
  filename: string
  contentType: string
  body: string
}

export class ExportService {
  constructor(
    private readonly repos: Repositories,
    private readonly investigations: InvestigationService,
    private readonly activity: ActivityService,
  ) {}

  async build(investigationId: string, ownerId: string, query: ExportQueryInput): Promise<ExportPayload> {
    const investigation = await this.investigations.requireOwned(investigationId, ownerId)
    const [evidence, analyses, validations, activity] = await Promise.all([
      this.repos.evidence.listByInvestigation(investigationId),
      this.repos.analyses.listByInvestigation(investigationId),
      this.repos.validations.listByInvestigation(investigationId),
      this.activity.listByInvestigation(investigationId, 500),
    ])

    const slug = slugify(investigation.title)
    const stamp = new Date().toISOString().slice(0, 10)

    if (query.format === 'json') {
      const bundle = {
        meta: {
          generator: 'SIGNALMESH',
          exportedAt: new Date().toISOString(),
          formatVersion: 1,
          scope: query.scope,
          investigationId: investigation.id,
          ownerId,
        },
        investigation: {
          id: investigation.id,
          ownerId: investigation.ownerId,
          title: investigation.title,
          description: investigation.description,
          objective: investigation.objective,
          topic: investigation.topic,
          keywords: investigation.keywords,
          status: investigation.status,
          createdAt: investigation.createdAt,
          updatedAt: investigation.updatedAt,
        },
        evidence:
          query.scope === 'evidence' || query.scope === 'investigation'
            ? evidence.map(serializeEvidence)
            : undefined,
        analyses:
          query.scope === 'analyses' || query.scope === 'investigation'
            ? analyses.map(serializeAnalysis)
            : undefined,
        validations:
          query.scope === 'validations' || query.scope === 'investigation'
            ? validations.map(serializeValidation)
            : undefined,
        activity:
          query.scope === 'history' || query.scope === 'investigation'
            ? activity.map(serializeActivity)
            : undefined,
      }
      return {
        filename: `signalmess-${slug}-${query.scope}-${stamp}.json`,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(bundle, null, 2),
      }
    }

    const csv = buildCsv(query.scope, {
      evidence,
      analyses,
      validations,
      activity,
      investigationTitle: investigation.title,
    })
    return {
      filename: `signalmess-${slug}-${query.scope}-${stamp}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: csv,
    }
  }
}

function serializeEvidence(evidence: Awaited<ReturnType<Repositories['evidence']['listByInvestigation']>>[number]) {
  return {
    id: evidence.id,
    investigationId: evidence.investigationId,
    title: evidence.title,
    url: evidence.url,
    domain: evidence.domain,
    snippet: evidence.snippet,
    retrievedContent: evidence.retrievedContent,
    publishedAt: evidence.publishedAt,
    author: evidence.author,
    collectedAt: evidence.collectedAt,
    source: evidence.source,
    contentAvailability: evidence.contentAvailability,
    relevanceScore: evidence.relevanceScore,
    relevanceBreakdown: evidence.relevanceBreakdown,
    validationStatus: evidence.validationStatus,
    note: evidence.note,
    createdAt: evidence.createdAt,
    updatedAt: evidence.updatedAt,
  }
}

function serializeAnalysis(analysis: Awaited<ReturnType<Repositories['analyses']['listByInvestigation']>>[number]) {
  return {
    id: analysis.id,
    investigationId: analysis.investigationId,
    evidenceIds: analysis.evidenceIds,
    model: analysis.model,
    status: analysis.status,
    executiveSummary: analysis.executiveSummary,
    findings: analysis.findings,
    keyPoints: analysis.keyPoints,
    supportedClaims: analysis.supportedClaims,
    contradictions: analysis.contradictions,
    limitations: analysis.limitations,
    informationGaps: analysis.informationGaps,
    objectiveAlignment: analysis.objectiveAlignment,
    references: analysis.references,
    insufficientEvidence: analysis.insufficientEvidence,
    usage: analysis.usage,
    errorMessage: analysis.errorMessage,
    createdAt: analysis.createdAt,
  }
}

function serializeValidation(validation: Awaited<ReturnType<Repositories['validations']['listByInvestigation']>>[number]) {
  return {
    id: validation.id,
    investigationId: validation.investigationId,
    evidenceId: validation.evidenceId,
    status: validation.status,
    previousStatus: validation.previousStatus,
    justification: validation.justification,
    createdAt: validation.createdAt,
  }
}

function serializeActivity(entry: Awaited<ReturnType<Repositories['activity']['listByInvestigation']>>[number]) {
  return {
    id: entry.id,
    investigationId: entry.investigationId,
    eventType: entry.eventType,
    description: entry.description,
    metadata: entry.metadata,
    createdAt: entry.createdAt,
  }
}

const CSV_HEADER = [
  'record_type',
  'id',
  'investigation_id',
  'evidence_id',
  'title',
  'url',
  'domain',
  'status',
  'justification',
  'relevance_score',
  'published_at',
  'collected_at',
  'created_at',
  'model',
  'summary',
  'findings_count',
  'references_count',
  'event_type',
  'description',
  'metadata_json',
]

function buildCsv(
  scope: ExportQueryInput['scope'],
  data: Parameters<typeof toCsvRows>[1],
): string {
  const rows = toCsvRows(scope, data)
  const lines = [CSV_HEADER.join(',')]
  for (const row of rows) {
    lines.push(CSV_HEADER.map((column) => escapeCsv(row[column] ?? '')).join(','))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

function toCsvRows(
  scope: ExportQueryInput['scope'],
  data: {
    evidence: Array<ReturnType<typeof serializeEvidence>>
    analyses: Array<ReturnType<typeof serializeAnalysis>>
    validations: Array<ReturnType<typeof serializeValidation>>
    activity: Array<ReturnType<typeof serializeActivity>>
    investigationTitle: string
  },
): Array<Record<string, string | number>> {
  const includeEvidence = scope === 'evidence' || scope === 'investigation'
  const includeAnalyses = scope === 'analyses' || scope === 'investigation'
  const includeValidations = scope === 'validations' || scope === 'investigation'
  const includeHistory = scope === 'history' || scope === 'investigation'

  const rows: Array<Record<string, string | number>> = []

  if (includeEvidence) {
    for (const item of data.evidence) {
      rows.push({
        record_type: 'evidence',
        id: item.id,
        investigation_id: item.investigationId,
        title: item.title,
        url: item.url,
        domain: item.domain,
        status: item.validationStatus,
        relevance_score: item.relevanceScore ?? '',
        published_at: item.publishedAt ?? '',
        collected_at: item.collectedAt,
        created_at: item.createdAt,
        metadata_json: JSON.stringify({
          author: item.author,
          contentAvailability: item.contentAvailability,
          source: item.source,
          note: item.note,
        }),
      })
    }
  }

  if (includeValidations) {
    for (const item of data.validations) {
      rows.push({
        record_type: 'validation',
        id: item.id,
        investigation_id: item.investigationId,
        evidence_id: item.evidenceId,
        status: item.status,
        justification: item.justification,
        created_at: item.createdAt,
        metadata_json: JSON.stringify({ previousStatus: item.previousStatus }),
      })
    }
  }

  if (includeAnalyses) {
    for (const item of data.analyses) {
      rows.push({
        record_type: 'analysis',
        id: item.id,
        investigation_id: item.investigationId,
        status: item.status,
        model: item.model,
        summary: item.executiveSummary,
        findings_count: item.findings.length,
        references_count: item.references.length,
        created_at: item.createdAt,
        metadata_json: JSON.stringify({
          evidenceIds: item.evidenceIds,
          limitations: item.limitations,
          contradictions: item.contradictions,
          informationGaps: item.informationGaps,
          insufficientEvidence: item.insufficientEvidence,
        }),
      })
    }
  }

  if (includeHistory) {
    for (const item of data.activity) {
      rows.push({
        record_type: 'activity',
        id: item.id,
        investigation_id: item.investigationId ?? '',
        event_type: item.eventType,
        description: item.description,
        created_at: item.createdAt,
        metadata_json: JSON.stringify(item.metadata),
        title: data.investigationTitle,
      })
    }
  }

  return rows
}

function escapeCsv(value: string | number): string {
  const text = String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function slugify(value: string): string {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'investigacao'
  )
}
