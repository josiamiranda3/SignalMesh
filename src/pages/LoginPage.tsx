import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, Lock, Mail, ShieldCheck, User } from 'lucide-react'
import { Logo, Wordmark } from '@/components/brand/Logo'
import { Button, Field, Input, Notice, ToastProvider } from '@/components/ui'
import { useAuth } from '@/app/AuthProvider'
import { ApiError } from '@/lib/api'
import { APP_TAGLINE } from '@/app/constants'

/**
 * Sign-in.
 *
 * In this local build the authentication adapter is the local one (DeepSpace
 * Auth is the production mechanism, wired in the worker adapter). The screen
 * says so plainly rather than pretending to offer social login it cannot
 * perform, and it preserves the intended destination through `?next=`.
 */
export default function LoginPage() {
  return (
    <ToastProvider>
      <LoginScreen />
    </ToastProvider>
  )
}

function LoginScreen() {
  const { status, user, signIn } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = sanitizeNext(params.get('next'))

  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})

  useEffect(() => {
    if (status === 'authenticated' && user) navigate(next, { replace: true })
  }, [status, user, navigate, next])

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    setFields({})
    try {
      await signIn({ email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}) })
      navigate(next, { replace: true })
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message)
        setFields(caught.fieldErrors())
      } else {
        setError('Não foi possível entrar. Tente novamente.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative z-10 grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Left: context */}
      <div className="relative hidden flex-col justify-between border-r border-hairline bg-base/50 p-10 lg:flex">
        <div aria-hidden className="grid-fade pointer-events-none absolute inset-0" />
        <Link to="/" className="relative flex min-h-9 items-center gap-2.5">
          <Logo size={28} />
          <Wordmark className="text-base" />
        </Link>

        <div className="relative max-w-md">
          <p className="eyebrow">{APP_TAGLINE}</p>
          <h1 className="mt-4 text-balance text-3xl font-semibold leading-tight tracking-[-0.025em]">
            Cada conclusão vinculada à fonte que a sustenta.
          </h1>
          <p className="mt-4 text-[0.875rem] leading-relaxed text-ink-muted">
            Organize pesquisas, colete evidências, peça análises estruturadas e registre a decisão
            humana — com histórico completo de cada passo.
          </p>

          <div className="mt-10 space-y-4">
            {[
              { icon: Lock, text: 'Sessão persistente, revogável no servidor' },
              { icon: ShieldCheck, text: 'Seus dados nunca aparecem para outra conta' },
              { icon: ArrowRight, text: 'Trilha de auditoria de todas as operações' },
            ].map((item) => (
              <div key={item.text} className="flex items-center gap-3 text-[0.8125rem] text-ink-muted">
                <div className="flex size-7 items-center justify-center rounded-md border border-hairline-strong bg-raised">
                  <item.icon className="size-3.5 text-signal-bright" aria-hidden />
                </div>
                {item.text}
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-[0.75rem] text-ink-faint">
          Ao entrar você reconhece que conteúdo de pesquisa selecionado pode ser enviado aos provedores
          externos configurados para processamento.
        </p>
      </div>

      {/* Right: form */}
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <Logo size={26} />
            <Wordmark className="text-[0.9375rem]" />
          </div>

          <h2 className="text-xl font-semibold tracking-[-0.02em]">Entrar no SignalMesh</h2>
          <p className="mt-1.5 text-[0.8125rem] text-ink-subtle">
            Identifique-se para acessar suas investigações.
          </p>

          <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
            {error ? <Notice tone="danger">{error}</Notice> : null}

            <Field label="E-mail" error={fields['email']} hint="Usado apenas para identificar sua conta neste ambiente.">
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
                <Input
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  autoFocus
                  placeholder="voce@exemplo.com"
                  className="pl-9"
                  value={email}
                  invalid={Boolean(fields['email'])}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
            </Field>

            <Field label="Nome de exibição" optional error={fields['name']} hint="Se vazio, derivamos do e-mail.">
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
                <Input
                  type="text"
                  name="name"
                  autoComplete="name"
                  placeholder="Como você quer ser chamado"
                  className="pl-9"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </Field>

            <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={submitting}>
              {submitting ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>

          <div className="mt-6">
            <Notice tone="info" title="Autenticação deste ambiente">
              Este build local usa um adaptador de sessão próprio para permitir testes completos sem
              depender de um provedor externo. Em produção, a autenticação é feita pelo DeepSpace Auth.
            </Notice>
          </div>

          <p className="mt-6 text-center text-[0.75rem] text-ink-faint">
            <Link to="/" className="underline decoration-hairline-strong underline-offset-4 hover:text-ink-muted">
              Voltar para a página inicial
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}

/** Only same-origin relative paths are valid redirect targets. */
function sanitizeNext(raw: string | null): string {
  if (!raw) return '/dashboard'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/dashboard'
  return raw
}
