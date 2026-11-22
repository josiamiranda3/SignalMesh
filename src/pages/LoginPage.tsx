import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, Lock, Mail, ShieldCheck, User } from 'lucide-react'
import { Logo, Wordmark } from '@/components/brand/Logo'
import { Button, Field, Input, Notice, ToastProvider } from '@/components/ui'
import { useAuth } from '@/app/AuthProvider'
import { ApiError } from '@/lib/api'
import { APP_TAGLINE } from '@/app/constants'
import { useI18n } from '@/i18n/I18nProvider'

/**
 * Sign-in.
 *
 * The screen renders whichever identity surface the runtime actually has:
 *
 *  - `deepspace`: the platform's own sign-in (`AuthOverlay` from the SDK). The
 *    app never sees a credential — the overlay drives the platform's auth
 *    worker, and the resulting session arrives as a verified JWT.
 *  - `local`: an email field, for the development/test adapter only.
 *
 * The `?next=` destination is preserved in both cases and sanitised to a
 * same-origin relative path, so the screen cannot be turned into an open
 * redirect.
 */
export default function LoginPage() {
  return (
    <ToastProvider>
      <LoginScreen />
    </ToastProvider>
  )
}

function LoginScreen() {
  const { t } = useI18n()
  const { status, user, mode, signIn, refresh } = useAuth()
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
        setError(t('login.signInError'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative z-10 grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Left: context */}
      <div className="relative hidden flex-col justify-between border-r border-hairline bg-base/50 p-12 lg:flex">
        <div aria-hidden className="grid-fade pointer-events-none absolute inset-0" />
        <Link to="/" className="relative flex min-h-11 items-center gap-2.5">
          <Logo size={28} />
          <Wordmark className="text-base" />
        </Link>

        <div className="relative max-w-md">
          <p className="eyebrow">{APP_TAGLINE}</p>
          <h1 className="mt-4 text-balance text-[2rem] font-semibold leading-[1.12] tracking-[-0.03em]">
            {t('login.headline')}
          </h1>
          <p className="mt-4 text-[0.875rem] leading-[1.75] text-ink-muted">
            {t('login.body')}
          </p>

          <div className="mt-10 space-y-4">
            {[
              { icon: Lock, text: t('login.pointSession') },
              { icon: ShieldCheck, text: t('login.pointIsolation') },
              { icon: ArrowRight, text: t('login.pointAudit') },
            ].map((item) => (
              <div key={item.text} className="flex items-center gap-3 text-[0.8125rem] text-ink-muted">
                <div className="flex size-7 items-center justify-center rounded-md border border-hairline-strong bg-raised">
                  <item.icon className="size-3.5 text-ink-faint" aria-hidden />
                </div>
                {item.text}
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-[0.75rem] text-ink-faint">
          {t('login.disclaimer')}
        </p>
      </div>

      {/* Right: sign-in surface */}
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <Logo size={26} />
            <Wordmark className="text-[0.9375rem]" />
          </div>

          <h2 className="text-[1.375rem] font-semibold tracking-[-0.025em] text-ink">{t('login.title')}</h2>
          <p className="mt-1.5 text-[0.8125rem] text-ink-subtle">
            {t('login.subtitle')}
          </p>

          {mode === 'deepspace' ? (
            <DeepSpaceSignIn onSignedIn={() => void refresh()} />
          ) : (
            <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
              {error ? <Notice tone="danger">{error}</Notice> : null}

              <Field
                label={t('login.emailLabel')}
                error={fields['email']}
                hint={t('login.emailHint')}
              >
                <div className="relative">
                  <Mail
                    className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint"
                    aria-hidden
                  />
                  <Input
                    type="email"
                    name="email"
                    autoComplete="email"
                    required
                    autoFocus
                    placeholder={t('login.emailPlaceholder')}
                    className="pl-9"
                    value={email}
                    invalid={Boolean(fields['email'])}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
              </Field>

              <Field
                label={t('login.nameLabel')}
                optional
                error={fields['name']}
                hint={t('login.nameHint')}
              >
                <div className="relative">
                  <User
                    className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint"
                    aria-hidden
                  />
                  <Input
                    type="text"
                    name="name"
                    autoComplete="name"
                    placeholder={t('login.namePlaceholder')}
                    className="pl-9"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              </Field>

              <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={submitting}>
                {submitting ? t('login.submitting') : t('login.submit')}
              </Button>
            </form>
          )}

          <div className="mt-6">
            {mode === 'deepspace' ? (
              <Notice tone="info" title={t('login.deepspaceNoticeTitle')}>
                {t('login.deepspaceNoticeBody')}
              </Notice>
            ) : (
              <Notice tone="info" title={t('login.localNoticeTitle')}>
                {t('login.localNoticeBody')}
              </Notice>
            )}
          </div>

          <p className="mt-6 text-center text-[0.75rem] text-ink-faint">
            <Link to="/" className="inline-flex min-h-11 items-center underline decoration-hairline-strong underline-offset-4 hover:text-ink-muted">
              {t('login.backHome')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * Platform sign-in.
 *
 * Renders the SDK's own overlay. The component is imported lazily so the local
 * Node build — which never authenticates this way — does not pay for it, and so
 * a missing provider configuration degrades to a clear message rather than a
 * blank screen.
 */
function DeepSpaceSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n()
  const [Overlay, setOverlay] = useState<React.ComponentType<{ onClose?: () => void }> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    import('deepspace')
      .then((mod) => {
        if (!active) return
        // `AuthOverlay` is the SDK's own sign-in surface; it drives the platform
        // auth worker. The app supplies presentation only.
        setOverlay(() => mod.AuthOverlay as unknown as React.ComponentType<{ onClose?: () => void }>)
      })
      .catch(() => {
        if (active) setLoadError(t('login.overlayLoadError'))
      })
    return () => {
      active = false
    }
  }, [t])

  // The overlay reports completion by closing; re-read the session afterwards
  // so the provider picks up the new identity from the server.
  const handleClose = () => onSignedIn()

  if (loadError) {
    return (
      <div className="mt-7">
        <Notice tone="danger" title={t('login.overlayUnavailableTitle')}>
          {loadError}
        </Notice>
      </div>
    )
  }

  return (
    <div className="mt-7">
      {Overlay ? (
        <Overlay onClose={handleClose} />
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-hairline bg-surface/60 px-6 py-10">
          <div className="size-6 animate-spin rounded-full border-2 border-hairline-strong border-t-signal" aria-hidden />
          <p className="text-[0.8125rem] text-ink-subtle">{t('login.overlayLoading')}</p>
        </div>
      )}
    </div>
  )
}

/** Only same-origin relative paths are valid redirect targets. */
function sanitizeNext(raw: string | null): string {
  if (!raw) return '/dashboard'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/dashboard'
  return raw
}
