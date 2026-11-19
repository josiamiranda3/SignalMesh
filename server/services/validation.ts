import type { Validation, ValidationStatus } from '../../shared/domain.ts'
import type { Repositories } from '../repositories/ports.ts'
import { errors } from '../lib/errors.ts'
import { createId, nowIso } from '../lib/util.ts'
import type { ActivityService } from './activity.ts'
import type { EvidenceService } from './evidence.ts'
import type { InvestigationService } from './investigations.ts'

/**
 * Human validation.
 *
 * Validation is a decision by a person, not a machine verdict. Each decision is
 * appended as a new row (with the previous status recorded), so changing your
 * mind never erases the earlier decision — the audit trail keeps every step.
 *
 * The evidence row mirrors the latest decision for fast filtering, but the
 * `validations` table is the source of truth for history.
 */
export class ValidationService {
  constructor(
    private readonly repos: Repositories,
    private readonly investigations: InvestigationService,
    private readonly evidence: EvidenceService,
    private readonly activity: ActivityService,
  ) {}

  async record(input: {
    investigationId: string
    evidenceId: string
    ownerId: string
    status: ValidationStatus
    justification: string
  }): Promise<{ validation: Validation; evidenceTitle: string }> {
    await this.investigations.requireOwned(input.investigationId, input.ownerId)
    const evidence = await this.evidence.requireOwned(input.evidenceId, input.ownerId)
    if (evidence.investigationId !== input.investigationId) {
      throw errors.notFound('Evidência não encontrada nesta investigação')
    }

    if ((input.status === 'rejected' || input.status === 'needs_review') && !input.justification.trim()) {
      throw errors.invalid(
        input.status === 'rejected'
          ? 'Informe a justificativa ao rejeitar uma evidência.'
          : 'Informe o motivo ao solicitar revisão de uma evidência.',
      )
    }

    if (evidence.validationStatus === input.status && input.status !== 'pending') {
      throw errors.invalid(
        `A evidência já está com o status "${input.status}". Altere a decisão para registrar um novo evento.`,
      )
    }

    const validation: Validation = {
      id: createId('val'),
      investigationId: input.investigationId,
      evidenceId: input.evidenceId,
      ownerId: input.ownerId,
      status: input.status,
      previousStatus: evidence.validationStatus,
      justification: input.justification.trim(),
      createdAt: nowIso(),
    }

    await this.repos.validations.create(validation)
    await this.evidence.setValidationStatus(input.evidenceId, input.status)

    await this.activity.record({
      investigationId: input.investigationId,
      ownerId: input.ownerId,
      eventType: 'validation.recorded',
      description: `Evidência "${evidence.title}" marcada como ${labelFor(input.status)}`,
      metadata: {
        evidenceId: input.evidenceId,
        validationId: validation.id,
        status: input.status,
        previousStatus: validation.previousStatus,
        justification: validation.justification,
      },
    })

    return { validation, evidenceTitle: evidence.title }
  }

  async historyForEvidence(evidenceId: string, ownerId: string): Promise<Validation[]> {
    await this.evidence.requireOwned(evidenceId, ownerId)
    return this.repos.validations.listByEvidence(evidenceId)
  }

  async listForInvestigation(investigationId: string, ownerId: string): Promise<Validation[]> {
    await this.investigations.requireOwned(investigationId, ownerId)
    return this.repos.validations.listByInvestigation(investigationId)
  }

  async countForOwner(ownerId: string): Promise<number> {
    return this.repos.validations.countByOwner(ownerId)
  }
}

export function labelFor(status: ValidationStatus): string {
  switch (status) {
    case 'accepted':
      return 'aprovada'
    case 'rejected':
      return 'rejeitada'
    case 'needs_review':
      return 'em revisão'
    default:
      return 'pendente'
  }
}
