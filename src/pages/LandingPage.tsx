import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BadgeCheck,
  Blocks,
  FileJson,
  Fingerprint,
  Gauge,
  Link2,
  ScanSearch,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { Logo, Wordmark } from '@/components/brand/Logo'
import { APP_TAGLINE } from '@/app/constants'

/**
 * Landing page.
 *
 * Static and fully server-renderable: no data fetch, no auth call. It explains
 * the product in concrete terms (what goes in, what comes out, what the system
 * refuses to do), and it makes no claims about customers, volumes or results —
 * everything stated here describes capabilities that exist in the app.
 */
export default function LandingPage() {
  return (
    <div className="relative z-10 min-h-screen">
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link to="/" className="flex min-h-9 items-center gap-2.5" aria-label="SignalMesh — início">
          <Logo size={26} />
          <Wordmark className="text-[0.9375rem]" />
        </Link>
        <nav className="flex items-center gap-2" aria-label="Acesso">
          <span className="hidden text-[0.75rem] text-ink-faint sm:inline">{APP_TAGLINE}</span>
          <Link
            to="/login"
            className="ml-2 inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline-strong bg-raised px-4 text-[0.8125rem] font-medium text-ink transition-colors hover:border-[#39445c] hover:bg-overlay"
          >
            Entrar
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden px-6 pb-20 pt-14 sm:pt-20">
          <div aria-hidden className="grid-fade pointer-events-none absolute inset-0 -z-10" />
          <div className="mx-auto max-w-6xl">
            <div className="max-w-3xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-hairline-strong bg-raised/60 px-3 py-1 text-[0.75rem] font-medium text-ink-muted">
                <span className="size-1.5 rounded-full bg-cyan" aria-hidden />
                Plataforma de inteligência de pesquisa
              </p>

              <h1 className="mt-6 text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.03em] sm:text-5xl lg:text-[3.4rem]">
                <span className="text-gradient">Informação dispersa</span>
                <br />
                transformada em inteligência
                <br className="hidden sm:block" /> que você pode auditar.
              </h1>

              <p className="mt-6 max-w-2xl text-pretty text-[0.9375rem] leading-relaxed text-ink-muted">
                O SignalMesh organiza fontes externas em evidências rastreáveis, confronta o que elas
                dizem com o objetivo da sua investigação e mantém cada conclusão presa à fonte que a
                sustenta. A análise é feita por IA; a decisão final é sempre humana.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  to="/login"
                  className="inline-flex h-11 items-center gap-2 rounded-lg bg-signal px-5 text-sm font-semibold text-[#050912] shadow-[0_16px_40px_-20px_rgba(91,140,255,0.9)] transition-colors hover:bg-signal-bright"
                >
                  Acessar a plataforma
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
                <a
                  href="#como-funciona"
                  className="inline-flex h-11 items-center gap-2 rounded-lg border border-hairline-strong px-5 text-sm font-medium text-ink-muted transition-colors hover:border-[#39445c] hover:text-ink"
                >
                  Ver como funciona
                </a>
              </div>

              <p className="mt-5 flex items-center gap-2 text-[0.75rem] text-ink-faint">
                <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
                Autenticação obrigatória · dados isolados por usuário · consumo de APIs externas limitado
              </p>
            </div>

            {/* Pipeline diagram — the actual data flow of the product */}
            <div className="mt-16 overflow-hidden rounded-xl border border-hairline bg-surface/70">
              <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
                <p className="eyebrow">Fluxo de evidência</p>
                <p className="text-[0.75rem] text-ink-faint">cada etapa é registrada no histórico</p>
              </div>
              <ol className="grid divide-y divide-hairline sm:grid-cols-5 sm:divide-x sm:divide-y-0">
                {[
                  { icon: ScanSearch, title: 'Pesquisa', body: 'Consulta à Exa a partir do tema e do objetivo' },
                  { icon: Link2, title: 'Coleta', body: 'Fontes selecionadas viram evidências com URL e trecho' },
                  { icon: Sparkles, title: 'Análise', body: 'Gemini estrutura descobertas e contradições' },
                  { icon: BadgeCheck, title: 'Validação', body: 'Decisão humana com justificativa registrada' },
                  { icon: FileJson, title: 'Exportação', body: 'JSON e CSV com relações preservadas' },
                ].map((step, index) => (
                  <li key={step.title} className="flex flex-col gap-2 px-5 py-5">
                    <div className="flex items-center gap-2">
                      <step.icon className="size-4 text-signal-bright" aria-hidden />
                      <span className="tnum text-[0.75rem] font-semibold text-ink-faint">
                        0{index + 1}
                      </span>
                    </div>
                    <p className="text-[0.8125rem] font-medium text-ink">{step.title}</p>
                    <p className="text-[0.75rem] leading-relaxed text-ink-subtle">{step.body}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section id="como-funciona" className="border-t border-hairline/70 px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-2xl">
              <p className="eyebrow">O que a plataforma faz</p>
              <h2 className="mt-3 text-balance text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
                Rastreabilidade como requisito, não como recurso opcional
              </h2>
              <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-muted">
                O SignalMesh não é um chat. É um ambiente de trabalho onde a origem de cada afirmação
                permanece visível — inclusive quando a resposta é “as fontes não sustentam esta conclusão”.
              </p>
            </div>

            <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  icon: Link2,
                  title: 'Evidência acima de opinião',
                  body: 'Cada descoberta cita os IDs das evidências que a sustentam. Referências que não existem no conjunto enviado invalidam a análise inteira.',
                },
                {
                  icon: Sparkles,
                  title: 'Análise estruturada',
                  body: 'Resumo executivo, descobertas, contradições, limitações, lacunas e alinhamento ao objetivo — em schema validado, não texto livre.',
                },
                {
                  icon: BadgeCheck,
                  title: 'Validação humana auditável',
                  body: 'Aprovar, rejeitar ou pedir revisão exige justificativa. Cada mudança de decisão gera um novo evento; nada é sobrescrito.',
                },
                {
                  icon: Gauge,
                  title: 'Prioridade transparente',
                  body: 'Índice de priorização com pesos explícitos e justificativa por componente. É ordenação, não probabilidade de veracidade.',
                },
                {
                  icon: Fingerprint,
                  title: 'Isolamento por usuário',
                  body: 'A propriedade é verificada no servidor em toda operação. Trocar o ID na URL não abre dados de outra pessoa.',
                },
                {
                  icon: Blocks,
                  title: 'Consumo controlado',
                  body: 'Limites diários por usuário e globais, trava de operação simultânea e interruptor geral para chamadas externas.',
                },
              ].map((feature) => (
                <div key={feature.title} className="bg-surface/95 p-6 transition-colors hover:bg-raised/70">
                  <feature.icon className="size-4.5 text-signal-bright" aria-hidden />
                  <h3 className="mt-3.5 text-[0.875rem] font-semibold text-ink">{feature.title}</h3>
                  <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-subtle">{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Principle */}
        <section className="border-t border-hairline/70 px-6 py-20">
          <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <div>
              <p className="eyebrow">Princípio central</p>
              <h2 className="mt-3 text-balance text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
                A IA organiza. Você decide.
              </h2>
              <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-muted">
                Um modelo de linguagem pode resumir, comparar e apontar tensões entre fontes. Ele não
                pode declarar que algo é verdadeiro. O SignalMesh trata a saída do modelo como um rascunho
                estruturado que um pesquisador precisa revisar, evidência por evidência.
              </p>
            </div>

            <div className="rounded-xl border border-hairline bg-surface/80 p-6">
              <p className="text-[0.8125rem] font-medium text-ink">O que o sistema recusa fazer</p>
              <ul className="mt-4 space-y-3">
                {[
                  'Inventar URLs, títulos ou fontes que não estão na investigação.',
                  'Apresentar inferência como fato comprovado.',
                  'Escolher uma versão como verdadeira quando as fontes se contradizem.',
                  'Continuar chamando um provedor pago depois de um erro de cota.',
                  'Exibir números de exemplo como se fossem dados reais.',
                ].map((item) => (
                  <li key={item} className="flex gap-2.5 text-[0.8125rem] leading-relaxed text-ink-muted">
                    <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-negative" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-hairline/70 px-6 py-20">
          <div className="relative mx-auto max-w-3xl overflow-hidden rounded-2xl border border-hairline-strong bg-surface/80 px-8 py-12 text-center">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-24 h-48 bg-[radial-gradient(40rem_18rem_at_50%_0%,rgba(91,140,255,0.18),transparent_70%)]"
            />
            <h2 className="relative text-balance text-2xl font-semibold tracking-[-0.02em]">
              Comece uma investigação com objetivo definido
            </h2>
            <p className="relative mx-auto mt-3 max-w-xl text-[0.875rem] leading-relaxed text-ink-muted">
              O SignalMesh exige um objetivo explícito porque é ele que orienta a pesquisa, a análise
              e a avaliação de alinhamento de cada fonte.
            </p>
            <Link
              to="/login"
              className="relative mt-7 inline-flex h-11 items-center gap-2 rounded-lg bg-signal px-6 text-sm font-semibold text-[#050912] transition-colors hover:bg-signal-bright"
            >
              Entrar e começar
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-hairline/70 px-6 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex min-h-9 items-center gap-2.5">
            <Logo size={20} />
            <Wordmark className="text-[0.8125rem]" />
          </div>
          <p className="max-w-xl text-[0.75rem] leading-relaxed text-ink-faint">
            Conteúdo de pesquisa selecionado pode ser enviado aos provedores externos (Exa para busca e
            Google Gemini para análise) estritamente para processar suas solicitações. Nenhuma
            credencial é exposta ao navegador.
          </p>
        </div>
      </footer>
    </div>
  )
}
