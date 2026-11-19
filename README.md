# SIGNALMESH

**Research & Evidence Intelligence Platform**

O SignalMesh transforma informação dispersa em evidências organizadas, analisadas e
validadas por pessoas. Não é um chatbot: é um ambiente de pesquisa onde toda conclusão
relevante permanece vinculada às fontes que a sustentam, e onde a decisão final sobre
cada fonte é humana, registrada e auditável.

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
- [Segurança](#segurança)
- [Exportação](#exportação)
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

### Autenticação
- Sessão persistente com cookie `HttpOnly`, `SameSite=Lax`, `Secure` sob HTTPS.
- Revogação imediata no logout (o token é opaco; só o hash SHA-256 é armazenado).
- Rotas privadas protegidas no cliente **e** no servidor.
- Redirecionamento pós-login preservando o destino (`?next=`), com validação
  same-origin para evitar open redirect.
- Adaptador de autenticação local para desenvolvimento; o adaptador DeepSpace Auth é o
  caminho de produção (ver [docs/decisions.md](docs/decisions.md)).

### Investigações
- Criar, listar, editar, arquivar e excluir (com confirmação e resumo do que será removido).
- Busca por título/tema/objetivo, filtro por status, ordenação por data ou título.
- Status: `draft`, `active`, `completed`, `archived`.
- Objetivo obrigatório e destacado — ele orienta a consulta, a análise e o cálculo de
  alinhamento de cada fonte.

### Pesquisa externa (Exa)
- `POST https://api.exa.ai/search` com autenticação por `x-api-key` no backend.
- Consulta montada a partir de tema + palavras-chave + objetivo, com possibilidade de
  sobrescrever.
- Exibe título, URL, domínio, trecho, data de publicação, autor, conteúdo recuperado e
  **disponibilidade de conteúdo** (`text` / `highlights` / `summary`).
- Aviso honesto sobre o que o provedor realmente retornou (ex.: "Conteúdo integral para 1
  de 3 resultados").
- Estados de carregamento, resultado vazio, erro, timeout, rate limit e duplicata.
- Nenhuma repetição automática de chamada potencialmente cobrada.

### Evidências
- Persistência com `investigationId`, URL original, domínio, trecho, conteúdo recuperado,
  metadados, data de coleta e status de validação.
- **Prevenção de duplicação** por URL normalizada (ignora `utm_*`, `gclid`, fragmento e
  barra final). Resultados já adicionados aparecem marcados e não podem ser re-selecionados.
- Observações por evidência.
- Índice de priorização com justificativa por componente e indicação explícita de dados
  ausentes.

### Análise (Google Gemini)
- Saída estruturada validada por schema (`responseSchema` + validação zod própria).
- Seções: resumo executivo, descobertas (com `evidenceIds` e confiança), pontos
  relevantes, afirmações sustentadas, contradições, limitações, lacunas, alinhamento ao
  objetivo, referências e modelo utilizado.
- Conteúdo das fontes é delimitado como **dado não confiável**; o prompt instrui
  explicitamente o modelo a ignorar comandos embutidos nas páginas.
- Modelo, tokens e data registrados em cada análise.

### Validação humana
- Três decisões: `accepted`, `rejected`, `needs_review`.
- Rejeição e revisão exigem justificativa (validado no servidor).
- Cada mudança de decisão cria um **novo evento** com `previousStatus`; nada é sobrescrito.
- Histórico por evidência visível na interface.

### Avaliação de relevância
Pesos configuráveis (padrão: relevância temática 40%, atualidade 25%, qualidade da fonte
25%, alinhamento ao objetivo 10%). O resultado é um **índice de priorização**, nunca uma
probabilidade de veracidade. Componentes sem dados ficam `null`, o índice é renormalizado
sobre o que pôde ser avaliado, e a justificativa diz exatamente o que faltou.

### Histórico e exportação
- Trilha persistida em `activity_logs` (não em estado de navegador), consultável por
  investigação e globalmente, com filtros por tipo de evento.
- Exportação JSON (estrutura completa com `meta`, `investigation`, `evidence`, `analyses`,
  `validations`, `activity`) e CSV (RFC 4180, BOM UTF-8), por escopo.

### Proteção de custo
- Limites diários por usuário e globais para pesquisa e análise.
- Uma operação simultânea por usuário (evita duplo clique = dupla cobrança).
- Guarda de consulta duplicada com janela configurável.
- Interruptor global `ENABLE_EXTERNAL_APIS` e `ENABLE_PAID_OPERATIONS` (ambos `false` por
  padrão).
- Toda tentativa — inclusive bloqueios — registrada em `usage_records`.

## Arquitetura

```
┌──────────────────────────────────────────────────────────────┐
│  React 19 + Vite 8 + Tailwind v4 (src/)                      │
│  rotas, componentes, hooks, cliente de API tipado            │
└───────────────────────┬──────────────────────────────────────┘
                        │  fetch JSON (cookie + CSRF)
┌───────────────────────▼──────────────────────────────────────┐
│  Hono (server/)                                              │
│  middleware de sessão, CSRF, validação zod, erros tipados    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ services/  regras de negócio (sem HTTP, sem SQL)       │  │
│  │   investigations · evidence · research · analysis      │  │
│  │   validation · activity · usage · dashboard · export   │  │
│  └───────────────┬────────────────────────┬───────────────┘  │
│                  │ ports.ts               │ integrations/    │
│  ┌───────────────▼──────────┐   ┌─────────▼──────────────┐   │
│  │ repositories/sqlite.ts   │   │ exa.ts · gemini.ts     │   │
│  │ (adaptador substituível) │   │ (fetch documentado)    │   │
│  └───────────────┬──────────┘   └─────────┬──────────────┘   │
└──────────────────┼────────────────────────┼──────────────────┘
                   │                        │
             ┌─────▼─────┐            ┌─────▼─────────────────┐
             │  SQLite   │            │  Exa  ·  Gemini       │
             │ (node:    │            │  (chaves só no        │
             │  sqlite)  │            │   backend)            │
             └───────────┘            └───────────────────────┘
```

A regra de negócio depende apenas das **portas** em
[`server/repositories/ports.ts`](server/repositories/ports.ts). Trocar SQLite por
DeepSpace Records ou PostgreSQL exige um novo adaptador, não uma reescrita dos serviços.

Detalhes em [docs/architecture.md](docs/architecture.md).

## Tecnologias

| Camada | Tecnologia | Versão verificada |
| --- | --- | --- |
| Runtime | Node.js | 24.22.0 (exigido `>=22.15 <23 || >=24 <25 || >=26 <27`) |
| Frontend | React | 19.3.1 |
| Build | Vite | 8.3.8 |
| Estilo | Tailwind CSS | 4.3.5 |
| Roteamento | react-router-dom | 7.18.6 |
| Ícones | lucide-react | 0.460.0 |
| Backend | Hono | 4.13.19 |
| Servidor local | @hono/node-server | 2.1.9 |
| Validação | zod | 4.6.7 |
| Banco | SQLite via `node:sqlite` | nativo do Node 24 |
| Tipos | TypeScript | 5.9.3 |
| Testes | `node:test` + CDP (Chrome/Edge) | nativo |
| Lint | ESLint + typescript-eslint | 9.39.5 / 8.73.0 |

Nenhum desses pacotes foi escolhido por conveniência de instalação: cada versão foi
verificada no ambiente e registrada em [docs/decisions.md](docs/decisions.md).

## Estrutura de pastas

```
.
├── index.html                  # shell da SPA
├── vite.config.ts              # build + proxy de /api para o servidor local
├── tsconfig.json               # cliente (strict, noUncheckedIndexedAccess)
├── tsconfig.server.json        # servidor, shared e testes
├── eslint.config.js
├── .env.example
│
├── shared/                     # contrato único entre cliente e servidor
│   ├── domain.ts               # entidades e enums
│   ├── api.ts                  # envelope de resposta e DTOs
│   ├── schemas.ts              # validação zod de entrada
│   ├── relevance.ts            # índice de priorização (puro)
│   └── analysis.ts             # schema da análise + validação de referências
│
├── server/
│   ├── app.ts                  # composição da aplicação Hono
│   ├── dev.ts                  # bootstrap do runtime local
│   ├── config.ts               # configuração a partir do ambiente
│   ├── db.ts                   # esquema SQLite e helpers
│   ├── seed.ts                 # dados de demonstração claramente rotulados
│   ├── http/                   # rotas e middleware
│   ├── services/               # regras de negócio
│   ├── repositories/           # portas + adaptador SQLite
│   ├── integrations/           # Exa e Gemini
│   └── lib/                    # erros, sessões, utilidades
│
├── src/
│   ├── main.tsx                # rotas e montagem
│   ├── app/                    # constantes e contexto de sessão
│   ├── components/
│   │   ├── ui/                 # primitivas (Button, Field, Modal, Toast, ...)
│   │   ├── layout/             # shell, sidebar, cabeçalhos
│   │   ├── charts/             # sparkline, distribuição, índice circular
│   │   ├── dashboard/          # cards de métrica
│   │   └── brand/              # marca
│   ├── pages/                  # 12 telas
│   ├── hooks/                  # useAsync, useDebounced, useMediaQuery
│   ├── lib/                    # cliente de API, formatação, classes
│   └── styles.css              # tokens de design
│
├── tests/
│   ├── unit/                   # 70 testes
│   ├── integration/            # 64 testes (harness com provedores mockados)
│   └── e2e/                    # fluxo completo em navegador real + auditoria de design
│
└── docs/                       # arquitetura, banco, segurança, integrações, ...
```

## Pré-requisitos

- **Node.js** `>=22.15.0 <23` ou `>=24 <25` ou `>=26 <27` (linhas ímpares excluídas).
- **npm** `>=11`.
- Para os testes de navegador: Chrome ou Edge instalado localmente. Defina `CHROME_PATH`
  se estiver em um caminho não padrão.

Verificação:

```bash
node --version   # v24.x
npm --version    # 11.x
```

## Instalação

```bash
npm install
```

## Configuração

```bash
cp .env.example .env
```

Edite `.env`. O mínimo para o app subir:

| Variável | Obrigatória | Padrão | Descrição |
| --- | --- | --- | --- |
| `PORT` | não | `8787` | Porta do servidor de API |
| `APP_ORIGIN` | não | `http://127.0.0.1:8787` | Origem usada no cookie e no check de CSRF |
| `DATABASE_URL` | não | `.data/signalmess.sqlite` | Arquivo SQLite (`:memory:` para efêmero) |
| `SESSION_SECRET` | **em produção** | fallback de dev | 32+ caracteres aleatórios |
| `ENABLE_EXTERNAL_APIS` | não | `false` | Interruptor global de chamadas externas |
| `ENABLE_PAID_OPERATIONS` | não | `false` | Autorização explícita para operações cobráveis |
| `EXA_API_KEY` | para pesquisar | — | Chave própria da Exa |
| `GEMINI_API_KEY` | para analisar | — | Chave própria do Google Gemini |
| `GEMINI_MODEL` | não | `gemini-2.5-flash` | Modelo usado na análise |
| `RESEARCH_DAILY_LIMIT` | não | `3` | Pesquisas por usuário/dia |
| `ANALYSIS_DAILY_LIMIT` | não | `3` | Análises por usuário/dia |

Lista completa em [.env.example](.env.example).

Gerar um segredo de sessão:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> **Chaves de API nunca vão para o navegador nem para o banco.** São lidas apenas por
> `server/integrations/*` a partir do ambiente.

## Execução local

Dois processos, como em qualquer projeto Vite + servidor de API:

```bash
# terminal 1 — API (Hono) em http://127.0.0.1:8787
npm run dev

# terminal 2 — frontend com HMR em http://127.0.0.1:5273
npm run dev:web
```

Abra **http://127.0.0.1:5273**. O Vite faz proxy de `/api` para o servidor.

Ou, para servir o build de produção a partir de um único processo:

```bash
npm run build
npm run preview        # http://127.0.0.1:8787
```

Entre com qualquer e-mail no ambiente local (adaptador de desenvolvimento) e use dois
e-mails diferentes para testar o isolamento entre usuários.

## Testes

```bash
npm run typecheck      # cliente + servidor
npm run lint           # ESLint (zero avisos)
npm run test           # 134 testes unitários + integração
npm run test:e2e       # fluxo completo em navegador real (56 verificações)
npm run audit:design   # auditoria de design em 3 viewports
npm run verify         # typecheck + lint + build + testes
```

Resultados verificados neste ambiente:

| Suíte | Testes | Resultado |
| --- | --- | --- |
| Unitários | 70 | ✅ todos passam |
| Integração | 64 | ✅ todos passam |
| Ponta a ponta (navegador real) | 56 verificações | ✅ todas passam |
| Auditoria de design | 13 rotas × 3 viewports | ✅ zero problemas |

Detalhes, incluindo o que cada suíte garante, em [docs/testing.md](docs/testing.md).

## Integração com a Exa

- Endpoint: `POST https://api.exa.ai/search`
- Autenticação: header `x-api-key` (a chave fica só no backend)
- Corpo: `{ query, type, numResults, contents: { text, highlights, summary } }`
- Resposta lida: `requestId`, `results[].{title,url,publishedDate,author,text,highlights,summary}`,
  `costDollars`, `warnings`
- Erros mapeados: 400, 401, 402, 403, 429, 500/502/503, timeout, JSON inválido
- Sem retry automático

Documentação completa em [docs/api-integrations.md](docs/api-integrations.md).

## Integração com o Google Gemini

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- Autenticação: header `x-goog-api-key`
- Saída estruturada: `responseMimeType: application/json` + `responseSchema`
- Modelo padrão: `gemini-2.5-flash` (free tier, com capacidade de saída estruturada)
- Toda resposta é revalidada por schema próprio **e** contra o conjunto real de evidências

## Persistência

SQLite via o módulo nativo `node:sqlite` (sem dependência compilada). Sete collections
principais mais três de apoio, com índices, chaves estrangeiras e `ON DELETE CASCADE`:
`investigations`, `evidence`, `analyses`, `validations`, `activity_logs`, `usage_records`
e `app_settings`.

Esquema completo, relacionamentos e regras de acesso em [docs/database.md](docs/database.md).

## Segurança

- Autorização verificada no servidor em **toda** operação; posse conferida por `ownerId`.
- ID de outro usuário responde `404` (não confirma existência).
- CSRF por header obrigatório + checagem de origem em métodos mutantes.
- Queries 100% parametrizadas (sem concatenação de SQL).
- URLs exibidas como link só se `http`/`https` (bloqueia `javascript:`, `data:`, `file:`).
- Conteúdo de fontes tratado como dado não confiável, inclusive no prompt da IA.
- Logs sem credenciais, sem corpos de requisição e sem tokens.
- Erros internos nunca expõem stack trace ou detalhes de SQL ao cliente.

Detalhes em [docs/security.md](docs/security.md).

## Exportação

- **JSON** — objeto completo com `meta`, `investigation`, `evidence`, `analyses`,
  `validations`, `activity`, preservando ids e relações.
- **CSV** — RFC 4180, BOM UTF-8 para Excel, uma linha por registro com `record_type`
  distinguindo entidades.
- Escopos: investigação completa, evidências, análises, validações, histórico.
- Nomes de arquivo legíveis: `signalmess-<titulo>-<escopo>-<data>.{json,csv}`.
- Nunca inclui credenciais, tokens, sessão ou dados de outros usuários.

## Limitações conhecidas

1. **Autenticação local é de desenvolvimento.** O adaptador aceita o e-mail informado.
   Não é adequado para produção aberta; o caminho de produção é o DeepSpace Auth
   (ver [docs/decisions.md](docs/decisions.md) e [docs/deployment.md](docs/deployment.md)).
2. **Integrações reais não foram exercitadas com chaves.** Toda a lógica de integração é
   testada contra um mock que fala o formato documentado dos provedores; nenhuma chamada
   cobrável foi feita, conforme a regra de custo zero.
3. **Conteúdo integral depende do provedor.** Quando a Exa retorna apenas título/trecho,
   o sistema informa isso e a análise considera a limitação — não há scraping próprio.
4. **Sem colaboração entre usuários.** O modelo é por proprietário; compartilhamento não
   foi implementado (e, portanto, não é anunciado).
5. **Rate limiting em memória.** Suficiente para uma instância; múltiplas instâncias
   exigiriam um store compartilhado.
6. **Sem i18n.** Interface em português do Brasil.
7. **Análises são imutáveis.** Não há exclusão individual; uma nova análise é o caminho
   previsto, preservando a auditoria.

## Estado da implantação

**Não publicado.** O desenvolvimento ocorreu integralmente em ambiente local, conforme
instruído. Nenhum deploy, billing ou push para a plataforma foi executado. O relatório de
condições e riscos está em [docs/deployment.md](docs/deployment.md), incluindo o gate
obrigatório que precisa de aprovação do proprietário antes de qualquer publicação.

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Componentes, fluxos, camadas e por que cada uma existe |
| [docs/database.md](docs/database.md) | Collections, relacionamentos, índices e permissões |
| [docs/security.md](docs/security.md) | Autenticação, autorização, secrets, limites, ameaças |
| [docs/api-integrations.md](docs/api-integrations.md) | Exa e Gemini: endpoints, payloads, erros, custos |
| [docs/testing.md](docs/testing.md) | Estratégia, suítes, resultados reais |
| [docs/decisions.md](docs/decisions.md) | Decisões técnicas e alternativas descartadas |
| [docs/deployment.md](docs/deployment.md) | Gate de implantação, quotas, riscos |

## Licença

Projeto privado. Todos os direitos reservados ao proprietário.
