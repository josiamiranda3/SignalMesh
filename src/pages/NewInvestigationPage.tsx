import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Info, Lightbulb, Plus, Tag, Target, X } from 'lucide-react'
import type { Investigation, InvestigationStatus } from '@shared/domain'
import { INVESTIGATION_STATUSES } from '@shared/domain'
import { investigationCreateSchema } from '@shared/schemas'
import { api, ApiError } from '@/lib/api'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import {
  Button,
  Field,
  Input,
  InvestigationStatusBadge,
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
 */
export default function NewInvestigationPage() {
  const navigate = useNavigate()
  const toast = useToast()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [objective, setObjective] = useState('')
  const [topic, setTopic] = useState('')
  const [keywords, setKeywords] = useState<string[]>([])
  const [keywordDraft, setKeywordDraft] = useState('')
  const [status, setStatus] = useState<InvestigationStatus>('draft')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const addKeyword = () => {
    const value = keywordDraft.trim()
    if (!value) return
    if (keywords.length >= 20) {
      setErrors((current) => ({ ...current, keywords: 'Máximo de 20 palavras-chave' }))
      return
    }
    if (!keywords.some((keyword) => keyword.toLowerCase() === value.toLowerCase())) {
      setKeywords([...keywords, value])
    }
    setKeywordDraft('')
    setErrors((current) => {
      const { keywords: _ignored, ...rest } = current
      return rest
    })
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
      const fieldErrors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.') || 'form'
        if (!fieldErrors[key]) fieldErrors[key] = issue.message
      }
      setErrors(fieldErrors)
      setFormError('Revise os campos destacados para continuar.')
      return
    }

    setErrors({})
    setSubmitting(true)
    try {
      const investigation = await api.post<Investigation>('/api/investigations', parsed.data)
      toast.success('Investigação criada', 'O próximo passo é executar a pesquisa externa.')
      navigate(`/investigations/${investigation.id}`, { replace: true })
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrors(caught.fieldErrors())
        setFormError(caught.message)
      } else {
        setFormError('Não foi possível criar a investigação. Tente novamente.')
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
        Investigações
      </Link>

      <PageHeader
        eyebrow="Nova investigação"
        title="Defina o que você quer descobrir"
        description="O tema delimita o assunto; o objetivo define a pergunta concreta que a pesquisa precisa responder. Ambos são usados para montar a consulta externa e para avaliar o alinhamento de cada fonte."
      />

      <form onSubmit={onSubmit} className="mt-7 grid gap-5 lg:grid-cols-[1.6fr_1fr]" noValidate>
        <div className="space-y-5">
          <section className="panel p-5">
            <h2 className="text-[0.875rem] font-semibold text-ink">Identificação</h2>
            <p className="mt-1 text-[0.75rem] text-ink-subtle">
              Um título curto e reconhecível. Você poderá editá-lo depois.
            </p>

            <div className="mt-5 space-y-4">
              <Field
                label="Título"
                error={errors['title']}
                counter={`${title.length}/160`}
                hint="Ex.: Detecção de fraudes financeiras com IA no Brasil"
              >
                <Input
                  value={title}
                  maxLength={160}
                  onChange={(event) => setTitle(event.target.value)}
                  invalid={Boolean(errors['title'])}
                  placeholder="Título da investigação"
                  aria-label="Título da investigação"
                  autoFocus
                />
              </Field>

              <Field
                label="Tema"
                error={errors['topic']}
                counter={`${topic.length}/300`}
                hint="O assunto em uma frase. É usado como base da consulta de pesquisa."
              >
                <Input
                  value={topic}
                  maxLength={300}
                  onChange={(event) => setTopic(event.target.value)}
                  invalid={Boolean(errors['topic'])}
                  placeholder="Ex.: uso de inteligência artificial para detectar fraudes financeiras no Brasil"
                  aria-label="Tema da investigação"
                />
              </Field>

              <Field
                label="Descrição"
                optional
                error={errors['description']}
                counter={`${description.length}/4000`}
                hint="Contexto, escopo e o que está fora do escopo."
              >
                <Textarea
                  value={description}
                  maxLength={4000}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Contexto da investigação, limites e critérios de inclusão de fontes."
                  aria-label="Descrição da investigação"
                  rows={3}
                />
              </Field>
            </div>
          </section>

          <section className="panel p-5">
            <div className="flex items-center gap-2">
              <Target className="size-4 text-signal-bright" aria-hidden />
              <h2 className="text-[0.875rem] font-semibold text-ink">Objetivo da pesquisa</h2>
            </div>
            <p className="mt-1 text-[0.75rem] text-ink-subtle">
              A pergunta que a investigação precisa responder. Seja específico — este texto centraliza a
              análise e a nota de alinhamento das fontes.
            </p>

            <div className="mt-4">
              <Field
                label="Objetivo"
                error={errors['objective']}
                counter={`${objective.length}/2000`}
                hint="Ex.: identificar aplicações reais, instituições envolvidas, tecnologias utilizadas e resultados publicados."
              >
                <Textarea
                  value={objective}
                  maxLength={2000}
                  onChange={(event) => setObjective(event.target.value)}
                  invalid={Boolean(errors['objective'])}
                  placeholder="Descreva o que precisa ser descoberto, com o nível de detalhe que permitiria julgar se a investigação teve sucesso."
                  aria-label="Objetivo da investigação"
                  rows={4}
                />
              </Field>
            </div>

            <div className="mt-4">
              <Field
                label="Palavras-chave"
                optional
                error={errors['keywords']}
                hint="Até 20 termos. Ajudam a focar a consulta externa."
              >
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Tag className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
                    <Input
                      value={keywordDraft}
                      onChange={(event) => setKeywordDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ',') {
                          event.preventDefault()
                          addKeyword()
                        }
                      }}
                      placeholder="Adicionar termo e pressionar Enter"
                      className="pl-9"
                      aria-label="Adicionar palavra-chave"
                    />
                  </div>
                  <Button variant="secondary" onClick={addKeyword} iconLeft={<Plus className="size-3.5" aria-hidden />}>
                    Adicionar
                  </Button>
                </div>

                {keywords.length > 0 ? (
                  <ul className="mt-3 flex flex-wrap gap-1.5">
                    {keywords.map((keyword) => (
                      <li
                        key={keyword}
                        className="inline-flex items-center gap-1 rounded-full border border-hairline-strong bg-raised py-0.5 pl-2.5 pr-1 text-[0.75rem] text-ink-muted"
                      >
                        {keyword}
                        <button
                          type="button"
                          onClick={() => setKeywords(keywords.filter((item) => item !== keyword))}
                          aria-label={`Remover palavra-chave ${keyword}`}
                          className="rounded-full p-0.5 text-ink-faint transition-colors hover:bg-white/5 hover:text-negative"
                        >
                          <X className="size-3" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[0.75rem] text-ink-faint">Nenhuma palavra-chave adicionada.</p>
                )}
              </Field>
            </div>
          </section>
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          <section className="panel p-5">
            <h2 className="text-[0.875rem] font-semibold text-ink">Status inicial</h2>
            <p className="mt-1 text-[0.75rem] text-ink-subtle">
              Rascunho mantém a investigação fora do fluxo ativo até você revisar o objetivo.
            </p>
            <div className="mt-4 space-y-3">
              <Select
                aria-label="Status inicial"
                value={status}
                onChange={(event) => setStatus(event.target.value as InvestigationStatus)}
                options={INVESTIGATION_STATUSES.map((value) => ({
                  value,
                  label: investigationStatusLabel(value),
                }))}
              />
              <div className="flex items-center gap-2">
                <span className="text-[0.75rem] text-ink-subtle">Prévia:</span>
                <InvestigationStatusBadge status={status} />
              </div>
            </div>
          </section>

          <section className="panel p-5">
            <div className="flex items-center gap-2">
              <Lightbulb className="size-4 text-caution" aria-hidden />
              <h2 className="text-[0.875rem] font-semibold text-ink">Objetivo bem escrito</h2>
            </div>
            <ul className="mt-3 space-y-2.5 text-[0.75rem] leading-relaxed text-ink-subtle">
              <li className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-positive" />
                Nomeia o que conta como resposta (instituições, tecnologias, resultados).
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-positive" />
                Delimita tempo e geografia quando isso importa.
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-negative" />
                Evita perguntas binárias do tipo “a IA funciona?”.
              </li>
            </ul>
          </section>

          <section className="panel p-5">
            <div className="flex items-center gap-2">
              <Info className="size-4 text-signal-bright" aria-hidden />
              <h2 className="text-[0.875rem] font-semibold text-ink">Privacidade</h2>
            </div>
            <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-subtle">
              O tema, o objetivo e as evidências selecionadas podem ser enviados aos provedores externos
              configurados para processar a pesquisa e a análise. Não inclua dados pessoais sensíveis.
            </p>
          </section>

          {formError ? <Notice tone="danger">{formError}</Notice> : null}

          <div className="flex flex-col gap-2">
            <Button type="submit" variant="primary" size="lg" loading={submitting} iconRight={<ArrowRight className="size-4" aria-hidden />}>
              {submitting ? 'Criando…' : 'Criar investigação'}
            </Button>
            <Link to="/investigations">
              <Button variant="ghost" size="md" className="w-full justify-center">
                Cancelar
              </Button>
            </Link>
          </div>
        </div>
      </form>
    </PageContainer>
  )
}
