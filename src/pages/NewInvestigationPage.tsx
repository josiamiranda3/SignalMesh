import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Info, Lightbulb, Target } from 'lucide-react'
import type { Investigation, InvestigationStatus } from '@shared/domain'
import { INVESTIGATION_STATUSES } from '@shared/domain'
import { investigationCreateSchema } from '@shared/schemas'
import { api, ApiError, fieldErrorKey } from '@/lib/api'
import { useI18n, type TranslationKey } from '@/i18n/I18nProvider'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import {
  Button,
  Field,
  Input,
  InvestigationStatusBadge,
  KeywordEditor,
  Notice,
  Select,
  Textarea,
  investigationStatusLabel,
  useToast,
} from '@/components/ui'

/**
 * New investigation.
 *
 * Validation runs on the client with the same zod schema the server uses, so
 * messages and rules cannot diverge. The form explains why the objective is
 * mandatory (it is the anchor for alignment scoring and for the analysis
 * prompt) instead of just demanding it.
 *
 * ## Error reporting
 *
 * Each invalid field shows its own message, in place, with `aria-invalid` and
 * an `aria-describedby` pointing at the message — so a screen reader hears the
 * reason when it lands on the field. A summary lists every problem at once
 * (rather than one per attempt), focus moves to the first invalid field, and
 * nothing the user typed is discarded.
 */

/** Field order, so focus lands on the first invalid one in reading order. */
const FIELD_ORDER = ['title', 'topic', 'description', 'objective', 'keywords'] as const

/** Human labels used in the error summary, as translation keys. */
const FIELD_LABELS: Record<string, TranslationKey> = {
  title: 'newInvestigation.fieldLabelTitle',
  topic: 'newInvestigation.fieldLabelTopic',
  description: 'newInvestigation.fieldLabelDescription',
  objective: 'newInvestigation.fieldLabelObjective',
  keywords: 'newInvestigation.fieldLabelKeywords',
}

export default function NewInvestigationPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { t } = useI18n()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [objective, setObjective] = useState('')
  const [topic, setTopic] = useState('')
  const [keywords, setKeywords] = useState<string[]>([])
  const [status, setStatus] = useState<InvestigationStatus>('draft')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Focus targets, so an invalid submit can move the caret to the right field.
  // Declared one per field (not in an object literal) so each ref is stable
  // across renders — a fresh object would fail the `react-hooks/refs` rule.
  const titleRef = useRef<HTMLInputElement>(null)
  const topicRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const objectiveRef = useRef<HTMLTextAreaElement>(null)
  const keywordsRef = useRef<HTMLInputElement>(null)

  const focusFirstError = (fieldErrors: Record<string, string>) => {
    const first = FIELD_ORDER.find((field) => fieldErrors[field])
    if (!first) return
    const refs = {
      title: titleRef,
      topic: topicRef,
      description: descriptionRef,
      objective: objectiveRef,
      keywords: keywordsRef,
    }
    refs[first].current?.focus()
  }

  /** Build one specific message per field from the zod issues. */
  const collectErrors = (issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>) => {
    const fieldErrors: Record<string, string> = {}
    for (const issue of issues) {
      const key = fieldErrorKey(issue.path)
      if (!fieldErrors[key]) fieldErrors[key] = issue.message
    }
    return fieldErrors
  }

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)

    const parsed = investigationCreateSchema.safeParse({
      title,
      description,
      objective,
      topic,
      keywords,
      status,
    })

    if (!parsed.success) {
      const fieldErrors = collectErrors(parsed.error.issues)
      setErrors(fieldErrors)
      setFormError(
        t('newInvestigation.summaryError', { count: Object.keys(fieldErrors).length }),
      )
      focusFirstError(fieldErrors)
      return
    }

    setErrors({})
    setSubmitting(true)
    try {
      const investigation = await api.post<Investigation>('/api/investigations', parsed.data)
      toast.success(t('newInvestigation.createdTitle'), t('newInvestigation.createdDetail'))
      navigate(`/investigations/${investigation.id}`, { replace: true })
    } catch (caught) {
      if (caught instanceof ApiError) {
        // `fieldErrors()` already folds array indices onto the field, so an
        // invalid keyword lands on the keywords input.
        const fieldErrors = caught.fieldErrors()
        setErrors(fieldErrors)
        setFormError(caught.message)
        focusFirstError(fieldErrors)
      } else {
        setFormError(t('newInvestigation.createError'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PageContainer className="max-w-[1000px]">
      <Link
        to="/investigations"
        className="mb-5 inline-flex min-h-9 items-center gap-1.5 text-[0.75rem] text-ink-subtle transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {t('newInvestigation.back')}
      </Link>

      <PageHeader
        eyebrow={t('newInvestigation.eyebrow')}
        title={t('newInvestigation.title')}
        description={t('newInvestigation.description')}
      />

      <form onSubmit={onSubmit} className="mt-6 grid gap-4 lg:grid-cols-[1.6fr_1fr]" noValidate>
        <div className="space-y-5">
          <section className="panel p-5">
            <h2 className="text-[0.875rem] font-semibold text-ink">{t('newInvestigation.sectionIdentity')}</h2>
            <p className="mt-1 text-[0.75rem] text-ink-subtle">
              {t('newInvestigation.sectionIdentityHint')}
            </p>

            <div className="mt-5 space-y-4">
              <Field
                label={t('newInvestigation.fieldTitle')}
                id="field-title"
                error={errors['title']}
                counter={`${title.length}/160`}
                hint={t('newInvestigation.fieldTitleHint')}
              >
                <Input
                  ref={titleRef}
                  value={title}
                  maxLength={160}
                  onChange={(event) => setTitle(event.target.value)}
                  invalid={Boolean(errors['title'])}
                  placeholder={t('newInvestigation.fieldTitlePlaceholder')}
                  aria-label={t('newInvestigation.fieldTitleAria')}
                  aria-invalid={errors['title'] ? true : undefined}
                  aria-describedby={errors['title'] ? 'field-title-error' : undefined}
                  autoFocus
                />
              </Field>

              <Field
                label={t('newInvestigation.fieldTopic')}
                id="field-topic"
                error={errors['topic']}
                counter={`${topic.length}/300`}
                hint={t('newInvestigation.fieldTopicHint')}
              >
                <Input
                  ref={topicRef}
                  value={topic}
                  maxLength={300}
                  onChange={(event) => setTopic(event.target.value)}
                  invalid={Boolean(errors['topic'])}
                  placeholder={t('newInvestigation.fieldTopicPlaceholder')}
                  aria-label={t('newInvestigation.fieldTopicAria')}
                  aria-invalid={errors['topic'] ? true : undefined}
                  aria-describedby={errors['topic'] ? 'field-topic-error' : undefined}
                />
              </Field>

              <Field
                label={t('newInvestigation.fieldDescription')}
                optional
                id="field-description"
                error={errors['description']}
                counter={`${description.length}/4000`}
                hint={t('newInvestigation.fieldDescriptionHint')}
              >
                <Textarea
                  ref={descriptionRef}
                  value={description}
                  maxLength={4000}
                  onChange={(event) => setDescription(event.target.value)}
                  invalid={Boolean(errors['description'])}
                  placeholder={t('newInvestigation.fieldDescriptionPlaceholder')}
                  aria-label={t('newInvestigation.fieldDescriptionAria')}
                  aria-invalid={errors['description'] ? true : undefined}
                  aria-describedby={errors['description'] ? 'field-description-error' : undefined}
                  rows={3}
                />
              </Field>
            </div>
          </section>

          <section className="panel p-5">
            <div className="flex items-center gap-2">
              <Target className="size-4 text-signal-bright" aria-hidden />
              <h2 className="text-[0.875rem] font-semibold text-ink">{t('newInvestigation.sectionObjective')}</h2>
            </div>
            <p className="mt-1 text-[0.75rem] text-ink-subtle">
              {t('newInvestigation.sectionObjectiveHint')}
            </p>

            <div className="mt-4">
              <Field
                label={t('newInvestigation.fieldObjective')}
                id="field-objective"
                error={errors['objective']}
                counter={`${objective.length}/2000`}
                hint={t('newInvestigation.fieldObjectiveHint')}
              >
                <Textarea
                  ref={objectiveRef}
                  value={objective}
                  maxLength={2000}
                  onChange={(event) => setObjective(event.target.value)}
                  invalid={Boolean(errors['objective'])}
                  placeholder={t('newInvestigation.fieldObjectivePlaceholder')}
                  aria-label={t('newInvestigation.fieldObjectiveAria')}
                  aria-invalid={errors['objective'] ? true : undefined}
                  aria-describedby={errors['objective'] ? 'field-objective-error' : undefined}
                  rows={4}
                />
              </Field>
            </div>

            <div className="mt-4">
              <Field
                label={t('newInvestigation.fieldKeywords')}
                optional
                id="field-keywords"
                error={errors['keywords']}
                hint={t('newInvestigation.keywordsHint')}
              >
                <KeywordEditor
                  value={keywords}
                  onChange={(next) => {
                    setKeywords(next)
                    // A successful edit clears a stale keyword error.
                    setErrors((current) => {
                      const { keywords: _ignored, ...rest } = current
                      return rest
                    })
                  }}
                  onProblem={(problem) =>
                    setErrors((current) => {
                      if (problem) return { ...current, keywords: problem }
                      const { keywords: _ignored, ...rest } = current
                      return rest
                    })
                  }
                  error={errors['keywords']}
                  errorId="field-keywords-error"
                  inputRef={keywordsRef}
                />
              </Field>
            </div>
          </section>
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          <section className="panel p-5">
            <h2 className="text-[0.875rem] font-semibold text-ink">{t('newInvestigation.sectionStatus')}</h2>
            <p className="mt-1 text-[0.75rem] text-ink-subtle">
              {t('newInvestigation.sectionStatusHint')}
            </p>
            <div className="mt-4 space-y-3">
              <Select
                aria-label={t('newInvestigation.statusAria')}
                value={status}
                onChange={(event) => setStatus(event.target.value as InvestigationStatus)}
                options={INVESTIGATION_STATUSES.map((value) => ({
                  value,
                  label: investigationStatusLabel(value),
                }))}
              />
              <div className="flex items-center gap-2">
                <span className="text-[0.75rem] text-ink-subtle">{t('newInvestigation.statusPreview')}</span>
                <InvestigationStatusBadge status={status} />
              </div>
            </div>
          </section>

          <section className="panel p-5">
            <div className="flex items-center gap-2">
              <Lightbulb className="size-4 text-caution" aria-hidden />
              <h2 className="text-[0.875rem] font-semibold text-ink">{t('newInvestigation.sectionTips')}</h2>
            </div>
            <ul className="mt-3 space-y-2.5 text-[0.75rem] leading-relaxed text-ink-subtle">
              <li className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-positive" />
                {t('newInvestigation.tipNamesAnswer')}
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-positive" />
                {t('newInvestigation.tipBoundsScope')}
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-negative" />
                {t('newInvestigation.tipAvoidBinary')}
              </li>
            </ul>
          </section>

          <section className="panel p-5">
            <div className="flex items-center gap-2">
              <Info className="size-4 text-signal-bright" aria-hidden />
              <h2 className="text-[0.875rem] font-semibold text-ink">{t('newInvestigation.sectionPrivacy')}</h2>
            </div>
            <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-subtle">
              {t('newInvestigation.privacyBody')}
            </p>
          </section>

          {formError ? (
            <Notice tone="danger" title={formError}>
              {Object.keys(errors).length > 0 ? (
                <ul className="mt-1 space-y-1">
                  {FIELD_ORDER.filter((field) => errors[field]).map((field) => (
                    <li key={field}>
                      <span className="font-medium">{t(FIELD_LABELS[field]!)}:</span> {errors[field]}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Notice>
          ) : null}

          <div className="flex flex-col gap-2">
            <Button type="submit" variant="primary" size="lg" loading={submitting} iconRight={<ArrowRight className="size-4" aria-hidden />}>
              {submitting ? t('newInvestigation.creating') : t('newInvestigation.create')}
            </Button>
            <Link to="/investigations">
              <Button variant="ghost" size="md" className="w-full justify-center">
                {t('newInvestigation.cancel')}
              </Button>
            </Link>
          </div>
        </div>
      </form>
    </PageContainer>
  )
}
