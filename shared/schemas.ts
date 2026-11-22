import { z } from 'zod'
import { INVESTIGATION_STATUSES, VALIDATION_STATUSES } from './domain.ts'

/**
 * Request validation contracts.
 *
 * Every inbound payload crosses one of these schemas on the server before it
 * reaches a service. The client reuses them for form validation so the two
 * cannot drift.
 */

const trimmed = (min: number, max: number, label: string) =>
  z
    .string({ error: `${label} é obrigatório` })
    .trim()
    .min(min, `${label} deve ter ao menos ${min} caracteres`)
    .max(max, `${label} deve ter no máximo ${max} caracteres`)

export const httpUrl = z
  .string()
  .trim()
  .max(2048, 'URL muito longa')
  .refine(
    (value) => {
      try {
        const url = new URL(value)
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch {
        return false
      }
    },
    { message: 'URL inválida: apenas http e https são permitidos' },
  )

/**
 * A single keyword.
 *
 * The messages are explicit because a bare `.min()/.max()` produces zod's
 * English default ("Too small: expected string to have >=1 characters"), which
 * reached the form as a raw internal string. The limits are unchanged.
 */
const keywordItem = z
  .string()
  .trim()
  .min(1, 'Palavra-chave vazia: informe um termo')
  .max(64, 'Cada palavra-chave deve ter no máximo 64 caracteres')

export const keywordsSchema = z
  .array(keywordItem)
  .max(20, 'Máximo de 20 palavras-chave')
  .default([])

/**
 * Fields as the client may send them, WITHOUT defaults.
 *
 * Zod applies `.default()` even to absent keys, so building a partial schema via
 * `.partial()` on a schema with defaults would inject every default into a PATCH
 * body and silently overwrite fields the user never touched. The update schema is
 * therefore derived from the undefaulted shape.
 */
const investigationFields = z.object({
  title: trimmed(3, 160, 'Título'),
  description: z.string().trim().max(4000, 'Descrição muito longa'),
  objective: trimmed(10, 2000, 'Objetivo'),
  topic: trimmed(3, 300, 'Tema'),
  keywords: z.array(keywordItem).max(20, 'Máximo de 20 palavras-chave'),
  status: z.enum(INVESTIGATION_STATUSES),
})

export const investigationCreateSchema = investigationFields.extend({
  description: z.string().trim().max(4000, 'Descrição muito longa').default(''),
  keywords: keywordsSchema,
  status: z.enum(INVESTIGATION_STATUSES).default('draft'),
})

export const investigationUpdateSchema = investigationFields.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Nenhum campo para atualizar' },
)

export const investigationStatusSchema = z.object({
  status: z.enum(INVESTIGATION_STATUSES),
})

export const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(INVESTIGATION_STATUSES).optional(),
  sort: z.enum(['updatedAt', 'createdAt', 'title']).default('updatedAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
})

export const researchRequestSchema = z.object({
  query: z.string().trim().max(400).optional(),
  numResults: z.coerce.number().int().min(1).max(20).default(8),
  includeContent: z.boolean().default(true),
  /** Re-run even when an identical query ran recently. */
  repeat: z.boolean().default(false),
})

export const evidenceCreateSchema = z.object({
  source: z.object({
    title: trimmed(1, 400, 'Título da fonte'),
    url: httpUrl,
    domain: z.string().trim().max(255).default(''),
    snippet: z.string().max(8000).default(''),
    retrievedContent: z.string().max(200_000).nullable().default(null),
    publishedAt: z.string().datetime({ offset: true }).nullable().default(null),
    author: z.string().max(300).nullable().default(null),
    providerRequestId: z.string().max(200).nullable().default(null),
    contentAvailability: z.array(z.string().max(40)).max(10).default([]),
  }),
  /** Explicit confirmation required when the URL already exists. */
  allowDuplicate: z.boolean().default(false),
})

export const evidenceBulkCreateSchema = z.object({
  sources: z.array(evidenceCreateSchema.shape.source).min(1).max(20),
  allowDuplicates: z.boolean().default(false),
})

export const evidenceUpdateSchema = z
  .object({
    note: z.string().trim().max(4000, 'Observação muito longa'),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nenhum campo para atualizar' })

export const validationSchema = z.object({
  status: z.enum(VALIDATION_STATUSES),
  justification: z
    .string()
    .trim()
    .max(2000, 'Justificativa muito longa')
    .default(''),
})

export const analysisRequestSchema = z.object({
  /** Optional subset of evidence; defaults to every evidence in the investigation. */
  evidenceIds: z.array(z.string().min(1).max(80)).max(60).optional(),
  /** Re-run while an identical analysis is already stored. */
  repeat: z.boolean().default(false),
  /**
   * Language the analysis text must be produced in.
   *
   * Defaults to Portuguese so a caller that predates this field (or the Worker,
   * which does not send it) keeps the behaviour every stored analysis was
   * created with. The evidence itself is never translated.
   */
  outputLanguage: z.enum(['en', 'pt-BR']).default('pt-BR'),
})

export const relevanceWeightsSchema = z
  .object({
    topical: z.number().min(0).max(1),
    recency: z.number().min(0).max(1),
    sourceQuality: z.number().min(0).max(1),
    objectiveAlignment: z.number().min(0).max(1),
  })
  .refine((w) => Math.abs(w.topical + w.recency + w.sourceQuality + w.objectiveAlignment - 1) < 0.001, {
    message: 'Os pesos devem somar 1.00',
  })

export const exportQuerySchema = z.object({
  format: z.enum(['json', 'csv']).default('json'),
  scope: z.enum(['investigation', 'evidence', 'analyses', 'validations', 'history']).default('investigation'),
})

export const settingsQuotaSchema = z.object({
  researchDailyLimit: z.coerce.number().int().min(0).max(100).optional(),
  analysisDailyLimit: z.coerce.number().int().min(0).max(100).optional(),
})

export type InvestigationCreateInput = z.infer<typeof investigationCreateSchema>
export type InvestigationUpdateInput = z.infer<typeof investigationUpdateSchema>
export type ListQueryInput = z.infer<typeof listQuerySchema>
export type ResearchRequestInput = z.infer<typeof researchRequestSchema>
export type EvidenceCreateInput = z.infer<typeof evidenceCreateSchema>
export type EvidenceBulkCreateInput = z.infer<typeof evidenceBulkCreateSchema>
export type ValidationInput = z.infer<typeof validationSchema>
export type AnalysisRequestInput = z.infer<typeof analysisRequestSchema>
export type ExportQueryInput = z.infer<typeof exportQuerySchema>
