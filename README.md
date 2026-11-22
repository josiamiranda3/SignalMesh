# SIGNALMESH

**Research & Evidence Intelligence Platform**

> **v0.2.4.3 — internacionalização completa (en / pt-BR).** O runtime de produção é um
> Cloudflare Worker com DeepSpace Auth e DeepSpace Records. O runtime Node com SQLite
> permanece para desenvolvimento e testes. O app **não está publicado** e **não está
> registrado** na plataforma — ver [docs/deployment.md](docs/deployment.md).
>
> A v0.2.4.3 traduz a interface inteira para inglês (padrão) e português do Brasil, com
> catálogos tipados, formatação regional por `Intl` e preferência persistida. A mesma
> versão endurece a superfície de ações: `/api/actions/*` passa a exigir Bearer Token,
> `ActionTools` ganha `deleteWhere` e a resolução de nomes usa `lookupOwn`.
> Ver [docs/audit-integrada-v0.2.4.3.md](docs/audit-integrada-v0.2.4.3.md) e, para a
> proteção financeira, [docs/changes-v0.2.4.3.md](docs/changes-v0.2.4.3.md).

O SignalMesh transforma informação dispersa em evidências organizadas, analisadas e
validadas por pessoas. Não é um chatbot: é um ambiente de pesquisa onde toda conclusão
relevante permanece vinculada às fontes que a sustentam, e onde a decisão final sobre cada
fonte é humana, registrada e auditável.

---

## Índice

- [O que o produto faz](#o-que-o-produto-faz)
- [Princípio central](#princípio-central)
- [Funcionalidades](#funcionalidades)
- [Arquitetura](#arquitetura)
- [Tecnologias](#tecnologias)
- [Estrutura de pastas](#estrutura-de-pastas)
- [Pré-requisitos](#pré-requisitos)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Execução local](#execução-local)
- [Testes](#testes)
- [Integração com a Exa](#integração-com-a-exa)
- [Integração com o Google Gemini](#integração-com-o-google-gemini)
- [Persistência](#persistência)
- [Autenticação](#autenticação)
- [Segurança](#segurança)
- [Exportação](#exportação)
- [Migração de dados](#migração-de-dados)
- [Limitações conhecidas](#limitações-conhecidas)
- [Estado da implantação](#estado-da-implantação)

---

## O que o produto faz

Um pesquisador define um **tema** e um **objetivo**. A partir deles o SignalMesh:

1. monta uma consulta e pesquisa fontes externas na **Exa**;
2. permite selecionar resultados e armazená-los como **evidências** com URL, trecho,
   conteúdo efetivamente recuperado e índice de priorização;
3. solicita ao **Google Gemini** uma análise estruturada — resumo executivo, descobertas
   com referências, contradições, limitações, lacunas e alinhamento ao objetivo;
4. valida o resultado contra as evidências reais antes de persistir;
5. registra a **decisão humana** sobre cada evidência (aprovada, rejeitada, em revisão)
   com justificativa e histórico completo;
6. mantém uma **trilha de auditoria** de todas as operações;
7. **exporta** tudo em JSON e CSV com relações preservadas.

## Princípio central

> Toda conclusão relevante deve estar vinculada às fontes que a sustentam.

Esse princípio é executável, não decorativo. Antes de uma análise ser aceita, o servidor
verifica que **cada `evidenceId` citado existe no conjunto que foi efetivamente enviado ao
modelo**. Uma referência inexistente invalida a análise inteira, que é registrada como
`failed` com o motivo — nunca exibida como resultado.

A IA organiza e confronta evidências. Ela não declara veracidade. Aprovar uma evidência
significa que ela é adequada para aquela investigação, não que seu conteúdo seja
cientificamente ou juridicamente verdadeiro.

## Funcionalidades

### Investigações
Criar, listar, editar, arquivar e excluir (com confirmação e resumo do que será removido);
busca por título/tema/objetivo, filtro por status, ordenação. Status: `draft`, `active`,
`completed`, `archived`. O objetivo é obrigatório e destacado — ele orienta a consulta, a
análise e o cálculo de alinhamento de cada fonte.

### Pesquisa externa (Exa)
`POST https://api.exa.ai/search` com chave no backend. Consulta montada de tema +
palavras-chave + objetivo, com sobrescrita opcional. Exibe título, URL, domínio, trecho,
data, autor, conteúdo recuperado e **disponibilidade real de conteúdo**. Aviso honesto
("Conteúdo integral para 1 de 3 resultados"). Estados de carregamento, vazio, erro, timeout,
rate limit e duplicata. **Sem retry automático.**

### Evidências
Persistência com proveniência completa, **prevenção de duplicação** por URL normalizada
(ignora `utm_*`, `gclid`, fragmento, barra final) garantida no armazenamento, observações por
evidência e índice de priorização com justificativa por componente.

### Análise (Google Gemini)
Saída estruturada via `responseSchema`, revalidada por schema próprio **e contra o conjunto
real de evidenceIds enviados**. Conteúdo de fontes delimitado como dado não confiável.

### Validação humana
Aceitar/rejeitar/requisitar revisão; justificativa obrigatória em rejeição e revisão; cada
mudança é um evento novo com `previousStatus` — nada é sobrescrito.

### Dashboard, histórico e exportação
Indicadores derivados de linhas persistidas; trilha de auditoria consultável por investigação
e globalmente; export JSON/CSV com escopos e relações íntegras.

### Proteção de custo
Cotas por usuário e globais, single-flight, guarda de duplicata, interruptores
`ENABLE_EXTERNAL_APIS`/`ENABLE_PAID_OPERATIONS` (ambos `false` por padrão), registro de
tentativas inclusive bloqueios.

## Arquitetura

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  PRODUÇÃO — Cloudflare Worker│        │  LOCAL/TESTE — Node          │
│  worker.ts                   │        │  server/dev.ts               │
│    · DeepSpace Auth (JWT)    │        │    · sessão local            │
│    · Records (Durable Object)│        │    · SQLite (node:sqlite)    │
└───────────────┬──────────────┘        └───────────────┬──────────────┘
                │                                        │
                └───────────► server/app.ts ◄────────────┘
                        (Hono, plataforma-neutro)
                                     │
                          server/services/index.ts
                          (regras de negócio puras)
                                     │
                      server/repositories/ports.ts
                       ┌─────────────┴─────────────┐
              records/repositories.ts      sqlite.ts
              (Durable Object)             (node:sqlite)
```

As duas implementações de persistência satisfazem as mesmas interfaces e são verificadas por
uma suíte de paridade: o mesmo cenário roda nos dois adaptadores e o resultado observável é
comparado. Detalhes em [docs/architecture.md](docs/architecture.md).

## Tecnologias

| Camada | Tecnologia | Versão |
| --- | --- | --- |
| Runtime | Node.js | 24.22.0 (exigido `>=22.15 <23 \|\| >=24 <25 \|\| >=26 <27`) |
| Frontend | React | 19.3.1 |
| Build | Vite | 8.3.8 |
| Estilo | Tailwind CSS | 4.3.5 |
| Roteamento | react-router-dom | 7.18.6 |
| Ícones | lucide-react | 0.460.0 |
| Backend | Hono | 4.13.19 |
| Plataforma | **deepspace SDK/CLI** | **0.44.2** |
| Deploy | **wrangler** | **4.79.0** |
| Validação | zod | 4.6.7 |
| Banco local | SQLite via `node:sqlite` | nativo do Node 24 |
| Tipos | TypeScript | 5.9.3 |
| Testes | `node:test` + CDP | nativo |
| Lint | ESLint + typescript-eslint | 9.39.5 / 8.73.0 |

## Estrutura de pastas

```
.
├── worker.ts                        # entry do Cloudflare Worker
├── wrangler.toml                    # DO, assets, vars (app id ainda placeholder)
├── vite.config.ts                   # build local | build de plataforma
├── index.html
├── tsconfig.json                    # cliente
├── tsconfig.server.json             # servidor, shared, testes, worker
├── eslint.config.js
├── .env.example
│
├── shared/                          # contrato único cliente↔servidor
│   ├── domain.ts · api.ts · schemas.ts
│   ├── relevance.ts                 # índice de priorização (puro)
│   └── analysis.ts                  # schema + validação de referências
│
├── src/
│   ├── schemas.ts                   # ← CollectionSchema do DeepSpace
│   ├── main.tsx · app/ · pages/ · components/ · hooks/ · lib/ · styles.css
│
├── server/
│   ├── app.ts                       # Hono plataforma-neutro
│   ├── bootstrap.ts                 # builder de testes
│   ├── dev.ts                       # runtime Node
│   ├── config.ts · db.ts · seed.ts
│   ├── http/                        # rotas + middleware
│   ├── services/
│   │   ├── index.ts                 # composição neutra
│   │   ├── node.ts                  # SQLite + sessão local
│   │   └── worker.ts                # Records + JWT verificado
│   ├── repositories/
│   │   ├── ports.ts                 # interfaces
│   │   ├── sqlite.ts
│   │   └── records/                 # transport + adapter + fake room
│   ├── integrations/                # exa.ts · gemini.ts
│   ├── migration/                   # SQLite → Records
│   └── lib/                         # auth-resolver, auth-context, erros, sessões
│
├── scripts/migrate-to-records.ts
├── tests/
│   ├── unit/                        # 74
│   ├── integration/                 # 335
│   ├── e2e/                         # 78 verificações em navegador real
│   └── worker/                      # 31 (contrato estático + empacotamento)
└── docs/                            # arquitetura, banco, segurança, ...
```

## Pré-requisitos

- **Node.js** `>=22.15.0 <23` ou `>=24 <25` ou `>=26 <27`.
- **npm** `>=11`.
- Para os testes de navegador: Chrome ou Edge (defina `CHROME_PATH` se necessário).
- Para o runtime de produção: o SDK `deepspace` e `wrangler` (instalados como dependências).

## Instalação

```bash
npm install
```

## Configuração

```bash
cp .env.example .env
```

### Worker (produção)

Os segredos vivem no store da plataforma, nunca no repositório:

```bash
npx deepspace secrets set EXA_API_KEY=... GEMINI_API_KEY=...
```

Os interruptores de custo ficam em `[vars]` no `wrangler.toml`, ambos `false`:

```toml
ENABLE_EXTERNAL_APIS = "false"
ENABLE_PAID_OPERATIONS = "false"
```

### Runtime local (Node)

Variáveis principais em `.env`:

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `8787` | porta da API |
| `APP_ORIGIN` | `http://127.0.0.1:8787` | origem para cookie e CSRF |
| `DATABASE_URL` | `.data/signalmess.sqlite` | arquivo SQLite (`:memory:` para efêmero) |
| `SESSION_SECRET` | fallback de dev | 32+ caracteres aleatórios |
| `ENABLE_EXTERNAL_APIS` | `false` | interruptor global de chamadas externas |
| `ENABLE_PAID_OPERATIONS` | `false` | autorização explícita de cobrança |
| `EXA_API_KEY` | — | chave própria da Exa |
| `GEMINI_API_KEY` | — | chave própria do Gemini |
| `RESEARCH_DAILY_LIMIT` | `3` | pesquisas por usuário/dia |
| `ANALYSIS_DAILY_LIMIT` | `3` | análises por usuário/dia |

Lista completa em [.env.example](.env.example).

Gerar um segredo de sessão:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Execução local

### Runtime Node (desenvolvimento e testes)

```bash
# terminal 1 — API em http://127.0.0.1:8787
npm run dev

# terminal 2 — frontend com HMR em http://127.0.0.1:5273
npm run dev:web
```

Ou, servindo o build de produção a partir de um processo:

```bash
npm run build
npm run preview
```

### Runtime DeepSpace (produção)

```bash
npx deepspace auth login     # requer conta e autorização
npx deepspace dev start      # Worker + Vite na plataforma local
```

**Não execute `dev start` antes de decidir a origem do código**: o primeiro uso do app pode
registrá-lo e travar a origem permanentemente. Ver
[docs/deployment.md](docs/deployment.md#52-decisão-de-origem-de-código-permanente).

## Testes

```bash
npm run typecheck        # cliente + servidor
npm run lint             # ESLint (zero avisos)
npm run test             # 479 testes (unit + integração + contrato)
npm run test:e2e         # 56 verificações em navegador real
npm run test:flows       # 22 verificações de fluxos complementares
npm run audit:design     # auditoria de design em 3 viewports
npm run test:worker      # empacotamento do Worker (+ execução ao vivo se possível)
npm run verify           # typecheck + lint + build + test
```

Resultados da validação operacional da v0.2.4.1, executados neste ambiente:

| Suíte | Resultado |
| --- | --- |
| Unitários | ✅ 74/74 |
| Integração | ✅ 374/374 |
| Contrato do Worker | ✅ 31/31 |
| **Total automatizado** | **✅ 479/479** |
| E2E fluxo principal | ✅ 56/56 |
| E2E fluxos complementares | ✅ 22/22 |
| Auditoria de design | ✅ 0 problemas (13 rotas × 3 viewports) |
| Worker — empacotamento | ✅ 17/17 |
| Worker — execução em workerd | ⏭ SKIPPED (o binário crasha com `std::terminate` neste ambiente) |

As quatro suítes que apareciam como não executadas passaram. Elas exigem que o comando rode
**fora do confinamento do sandbox**, que bloqueia named pipes — o que impedia o Chrome de
iniciar e o esbuild do wrangler de abrir seu canal IPC. A causa está diagnosticada em
[docs/validation-v0.2.4.1.md](docs/validation-v0.2.4.1.md) e o procedimento em
[docs/testing.md](docs/testing.md) §4.19. Nenhuma linha de código foi alterada para isso.

## Integração com a Exa

- Endpoint: `POST https://api.exa.ai/search`, header `x-api-key`
- Corpo: `{ query, type, numResults, contents: { text, highlights, summary } }`
- Erros mapeados: 400, 401, 402, 403, 429, 5xx, timeout, JSON inválido
- Sem retry automático

Ver [docs/api-integrations.md](docs/api-integrations.md).

## Integração com o Google Gemini

- Endpoint: `POST .../models/{model}:generateContent`, header `x-goog-api-key`
- Saída estruturada: `responseMimeType: application/json` + `responseSchema`
- Modelo padrão: `gemini-2.5-flash`
- Toda resposta é revalidada por schema próprio **e** contra o conjunto real de evidências

## Persistência

| Runtime | Armazenamento |
| --- | --- |
| Worker | DeepSpace Records (Durable Object), 9 collections declaradas em `src/schemas.ts` |
| Node | SQLite via `node:sqlite`, 10 tabelas em `server/db.ts` |

Isolamento por dono em duas camadas: `requireOwned` no serviço **e** `ownerField` +
`permissions: 'own'` avaliados pelo Durable Object.

Esquema completo em [docs/database.md](docs/database.md).

## Autenticação

| Runtime | Mecanismo |
| --- | --- |
| Worker | **DeepSpace Auth** — JWT verificado com `verifyJwt` e chave pública da plataforma. A app não emite, assina nem armazena JWT. |
| Node | Sessão local opaca (hash SHA-256), **exclusiva de testes**, recusada em produção e no Worker. |

Em modo DeepSpace, `POST /api/auth/login` responde `404`: não existe entrada alternativa.
Ver [docs/security.md](docs/security.md).

## Segurança

- Autorização verificada no servidor em toda operação; posse responde `404`.
- RBAC do Durable Object como segunda barreira independente.
- CSRF por header + verificação de origem em métodos mutantes.
- Operações de dados parametrizadas pelo protocolo de tools; nenhuma concatenação.
- URLs exibidas como link só se `http`/`https:`.
- Conteúdo de fontes tratado como dado não confiável, inclusive no prompt.
- Logs sem credenciais, sem corpos e sem tokens.
- Bundle verificado: nenhum segredo embutido, nenhum runtime Node vazando.

## Exportação

- **JSON** — `meta`, `investigation`, `evidence`, `analyses`, `validations`, `activity`.
- **CSV** — RFC 4180, BOM UTF-8, uma linha por registro, `record_type` distinguindo entidades.
- Escopos: completa, evidências, análises, validações, histórico.
- Nunca inclui credenciais, tokens ou dados de outros usuários.

## Migração de dados

O adaptador SQLite continua sendo a origem local. Para levar dados a uma instância DeepSpace
já implantada:

```bash
MIGRATION_TARGET_URL=https://<app>.app.space \
DEEPSPACE_APP_ID=app_... \
OWNER_USER_ID=... \
npm run migrate:records -- --owner <userId> --dry-run
```

Idempotente, preserva ids e relações, normaliza URLs, e **nunca apaga a origem**. Ver
[docs/database.md](docs/database.md#6-migração-de-dados-locais).

## Limitações conhecidas

1. **Não publicado e não registrado.** `DEEPSPACE_APP_ID` ainda é `__APP_ID__`; registrar
   exige autorização porque trava a origem do código permanentemente.
2. **Execução em workerd não verificada neste ambiente.** O empacotamento é verificado com o
   wrangler real; o binário `workerd` não inicia aqui (reproduzido com um Worker mínimo).
3. **O Durable Object real não foi exercitado.** O adaptador Records é testado contra um fake
   fiel ao contrato documentado (RBAC, `uniqueOn`, required, `maxLength`, paginação).
4. **Integrações reais não exercitadas com chaves.** Toda a lógica é testada contra um mock
   que fala o formato documentado; nenhuma chamada cobrável foi feita.
5. **Conteúdo integral depende do provedor.** Quando a Exa retorna só título/trecho, o
   sistema informa e a análise considera a limitação — não há scraping próprio.
6. **Sem colaboração entre usuários.** Modelo por proprietário; compartilhamento não
   implementado (e não anunciado).
7. **Rate limiting em memória.** Suficiente para uma instância; múltiplas exigiriam store
   compartilhado.
8. **Sem i18n.** Interface em português do Brasil.

## Estado da implantação

**Não publicado.** Nenhum deploy, `push`, `app init`, billing ou contratação foi executado.
O relatório de quotas, riscos e o gate obrigatório está em
[docs/deployment.md](docs/deployment.md).

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Dois runtimes, camadas, identidade, isolamento |
| [docs/database.md](docs/database.md) | Collections, equivalência de restrições, migração |
| [docs/security.md](docs/security.md) | Autenticação, autorização, secrets, ameaças |
| [docs/api-integrations.md](docs/api-integrations.md) | Exa e Gemini: endpoints, payloads, erros, custos |
| [docs/testing.md](docs/testing.md) | Estratégia, suítes, resultados reais, limites |
| [docs/decisions.md](docs/decisions.md) | Decisões e alternativas descartadas |
| [docs/audit-v0.2.1.md](docs/audit-v0.2.1.md) | Auditoria de segurança: problemas, correções, riscos |
| [docs/audit-v0.2.4.md](docs/audit-v0.2.4.md) | Auditoria do `authorizedParties` na rota privilegiada |
| [docs/validation-v0.2.4.1.md](docs/validation-v0.2.4.1.md) | Validação operacional local: causas dos bloqueios de E2E e wrangler |
| [docs/preflight-deepspace-v0.2.4.1.md](docs/preflight-deepspace-v0.2.4.1.md) | Pré-verificação DeepSpace: conta, SDK, requisitos e custos |
| [docs/changes-v0.2.4.2.md](docs/changes-v0.2.4.2.md) | v0.2.4.2: cadastro manual de evidências e correção da procedência |
| [docs/deployment.md](docs/deployment.md) | Gate de implantação, quotas, riscos, checklist |

## Licença

Projeto privado. Todos os direitos reservados ao proprietário.
