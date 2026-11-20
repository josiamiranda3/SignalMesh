# Arquitetura

Este documento explica **por que** o SignalMesh está estruturado assim, não apenas como.
A versão 0.2 migrou o runtime para o Cloudflare Worker/DeepSpace preservando a lógica de
negócio; o que mudou e o que deliberadamente não mudou está em
[docs/decisions.md](decisions.md).

---

## 1. Dois runtimes, uma aplicação

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  PRODUÇÃO — Cloudflare Worker│        │  LOCAL/TESTE — Node          │
│  worker.ts                   │        │  server/dev.ts               │
│    · DeepSpace Auth (JWT)    │        │    · sessão local            │
│    · Records (Durable Object)│        │    · SQLite (node:sqlite)    │
│    · Exa + Gemini            │        │    · Exa + Gemini            │
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
                       │                           │
              records/repositories.ts      sqlite.ts
              (Durable Object)             (node:sqlite)
```

O que os dois runtimes **compartilham**: rotas, validação, autorização, regras de negócio,
integrações, formato de erro, contrato de resposta. O que **difere**: quem resolve a
identidade e onde os dados moram.

**Por que essa é a decisão central:** portar a aplicação não podia significar reescrever a
regra de negócio. A fronteira em `ports.ts` e o resolvedor de identidade em
`lib/auth-resolver.ts` são os dois únicos pontos que conhecem a plataforma. A suíte de
paridade (`tests/integration/adapter-parity.test.ts`) executa o mesmo cenário nos dois
adaptadores e compara o resultado observável.

---

## 2. Fronteiras de confiança

| Fronteira | O que cruza | Como é controlado |
| --- | --- | --- |
| Navegador → Worker | JSON + JWT | `verifyJwt`, CSRF, validação zod, posse |
| Worker → RecordRoom | operações de tools | identidade no header; RBAC do DO |
| Worker → provedores | consulta e evidências | interruptores de custo, cotas, sem retry |
| Fontes externas → análise | texto de página | delimitado como dado não confiável |

O navegador **nunca** é autoridade: nem de sessão, nem de cota, nem de permissão. O Worker
decide identidade; o Durable Object reforça a posse; o serviço confere antes de cada
operação.

---

## 3. Camadas

### 3.1 `worker.ts` — assembly

Só montagem: manifesto de Durable Objects, export da classe `AppRecordRoom`, ponte entre
`env` e configuração, serviço de assets. Nenhuma regra de negócio.

O Worker constrói os serviços **por requisição**, porque o transporte de dados carrega a
identidade do chamador. Nada é compartilhado entre requisições, então não existe "usuário
ambiente" que possa vazar de uma chamada para a próxima.

### 3.2 `server/app.ts` — aplicação Hono

Plataforma-neutra: recebe serviços já montados e registra rotas, CSRF, handler de erro e
404. É o mesmo objeto nos dois runtimes.

### 3.3 `server/services/` — regras de negócio

Não conhecem HTTP nem SQL. Nove serviços, cada um com uma invariante:

| Serviço | Invariante |
| --- | --- |
| `investigations` | `requireOwned` antes de qualquer acesso |
| `evidence` | URL normalizada impede duplicata |
| `research` | reserva → chamada → settlement → atividade |
| `analysis` | referências validadas contra o conjunto real |
| `validation` | toda mudança é um evento novo |
| `activity` | trilha persistida, nunca em memória |
| `usage` | cota verificada no backend, sempre |
| `dashboard` | números derivados de linhas reais |
| `export` | apenas dados do chamador |

### 3.4 `server/repositories/` — persistência

`ports.ts` declara as interfaces. Dois adaptadores as implementam:

- `sqlite.ts` — o runtime local, e a referência de comportamento.
- `records/repositories.ts` — DeepSpace Records, via o endpoint de tools do Durable Object.

Nenhum serviço importa um adaptador concreto.

### 3.5 `server/integrations/` — provedores

Únicos módulos que fazem chamadas externas. Cada um valida que está utilizável antes de
tocar a rede, usa timeout explícito, mapeia cada status documentado e **nunca** repete uma
chamada automaticamente.

---

## 4. Identidade

`server/lib/auth-resolver.ts` é o único lugar que responde "quem está chamando?".

### 4.1 Modo DeepSpace (produção e `deepspace dev start`)

1. Lê o token do header `Authorization: Bearer` (o que o SDK anexa) ou, na ausência dele,
   do cookie de sessão da plataforma.
2. Verifica com `verifyJwt` do `deepspace/worker`, usando `AUTH_JWT_PUBLIC_KEY` e
   `AUTH_JWT_ISSUER` — material injetado pela plataforma, nunca um segredo compartilhado.
3. Deriva o `UserRecord` das claims verificadas, preferindo a linha `users` quando existe.

A aplicação **não emite, assina, renova ou armazena** JWT. Não há segredo que possa ser
usado para forjar um.

### 4.2 Modo local (exclusivo de teste)

Sessão opaca gravada em SQLite, hash SHA-256 apenas. Recusado por
`assertProductionSafety` quando o runtime é o Worker ou quando `NODE_ENV=production`.

### 4.3 A fronteira é testada

`tests/integration/auth-deepspace.test.ts` prova, entre outras coisas, que:

- o modo é derivado do runtime, não de uma variável que o cliente controle;
- sem chave/emissor o resolvedor falha fechado (não confia em header);
- o modo DeepSpace nunca consulta a sessão local;
- o modo local ignora um Bearer token;
- um Worker configurado para o adaptador local não sobe.

---

## 5. Isolamento em duas camadas

O requisito é que um usuário nunca leia nem escreva dados de outro. Isso é garantido duas
vezes, por mecanismos independentes:

1. **Serviço** — `requireOwned` compara `ownerId` e responde `404` (não `403`, que
   confirmaria a existência do registro).
2. **Durable Object** — as collections declaram `ownerField: 'ownerId'` com
   `read/update/delete: 'own'`. O Worker envia `X-User-Id` **sem** `X-App-Action`, então o
   DO avalia as `permissions` contra o papel real do chamador e recusa a linha antes de
   devolvê-la.

A segunda camada existe porque a primeira depende de o código lembrar de chamar
`requireOwned`. A segunda não depende de nada: é a política da collection aplicada no
armazenamento.

`tests/integration/records-security.test.ts` exercita o DO diretamente — leitura, escrita,
exclusão e `deleteWhere` entre dois usuários — sem passar pelos serviços, precisamente para
provar que a barreira inferior funciona sozinha.

### A única exceção, e por quê

O teto **global** de consumo diário precisa somar o consumo de todos os usuários. Uma
leitura com escopo de membro não vê linhas de outras contas, por desenho. Em vez de
afrouxar a política da collection, o Worker usa um transporte administrativo
(`X-App-Action: true`) para **uma** pergunta:

```
createGlobalUsageReader(env, ownerUserId).totalSince(operation, since) → number
```

Ela devolve um número. Nunca lista, lê ou retorna uma linha. É o único consumidor do
transporte administrativo em todo o backend, e está isolada em
`server/services/worker.ts`.

---

## 6. Fluxo: da pergunta à evidência validada

```
1. Criar investigação
   POST /api/investigations
   → requireUser (JWT verificado)
   → investigations.create + activity('investigation.created')

2. Pesquisar
   POST /api/investigations/:id/research
   → requireUser → requireOwned
   → exa.assertUsable        (interruptor + chave)
   → guarda de duplicata
   → usage.reserve           (cota do usuário + global + single-flight)
   → exa.search              (timeout, sem retry)
   → usage.settle            (sucesso ou falha classificada)
   → activity('research.executed')

3. Adicionar evidências
   POST /api/investigations/:id/evidence/bulk
   → normalização de URL
   → detecção de duplicata
   → score de relevância no momento da coleta
   → uniqueOn (investigationId, urlNormalized) no Durable Object

4. Analisar
   POST /api/investigations/:id/analyses
   → somente evidências armazenadas e do chamador
   → prompt com fontes delimitadas
   → Gemini com responseSchema
   → validateAnalysisPayload contra o conjunto real de ids
   → sucesso: analyses(status=completed) · falha: status=failed + erro tipado

5. Validar
   POST /api/evidence/:id/validation
   → justificativa obrigatória em rejected/needs_review
   → novo registro com previousStatus
   → activity('validation.recorded')

6. Exportar
   GET /api/investigations/:id/export?format=json|csv&scope=...
   → somente linhas do chamador
   → activity('export.generated')
```

---

## 7. Frontend

### 7.1 Árvore de provedores

```
PlatformProviders            (só quando o bundle carrega um app id real)
  DeepSpaceAuthProvider
    RecordProvider
      RecordScope(SCOPE_ID, schemas)
        AuthProvider         (contexto de sessão da aplicação)
          Routes
```

`PlatformProviders` monta os provedores do SDK **apenas** quando
`__DEEPSPACE_APP_ID__` foi injetado pelo `deepspaceBuild()`. No runtime local esse define
não existe, e abrir um WebSocket para um RecordRoom inexistente seria pior que não abrir.

As páginas não falam com o SDK diretamente: `useAuth` (de `src/app/AuthProvider.tsx`)
expõe `status`, `user`, `mode` e `signOut`, e todos os dados vêm de `/api/*`. Assim uma tela
não precisa saber qual adaptador está ativo.

### 7.2 Rotas

```
/                       landing (estática, sem fetch)
/login                  entrada (DeepSpace Auth ou adaptador local)
/dashboard              visão geral
/investigations         listagem
/investigations/new     criação
/investigations/:id     detalhe
/investigations/:id/{research,evidence,analysis,validation}
/validation             fila global
/history                trilha de auditoria
/settings               provedores, limites, conta
```

Todas exceto `/` e `/login` estão sob `<RequireAuth>`. A proteção real está no servidor: o
redirecionamento é conveniência.

### 7.3 Design system

Tokens em `src/styles.css` (Tailwind v4 `@theme`): cinco níveis de superfície, quatro
níveis de tinta todos acima de 4.5:1, três acentos com significado. A auditoria
automatizada (`npm run audit:design`) mede contraste WCAG AA, overflow, texto cortado,
alvos de toque e hierarquia em 13 rotas × 3 viewports.

---

## 8. Build

`vite.config.ts` decide o modo pelo `DEEPSPACE_APP_ID` real em `wrangler.toml`:

| Modo | Quando | O que produz |
| --- | --- | --- |
| Local | id é `__APP_ID__` | só a SPA; dados via `/api/*` |
| Plataforma | id `app_<ULID>` registrado | SPA + `worker.ts`, com app id injetado |

O plugin `deepspaceBuild()` **recusa** construir com o placeholder, porque a chave de
RecordRoom no navegador é derivada desse id: publicar um id vazio apontaria o cliente para
os dados de outro app. Registrar minta o id no servidor e trava a origem do código
permanentemente — por isso é um passo autorizado, nunca implícito no build.

`SIGNALMESS_REQUIRE_PLATFORM=1` transforma a ausência do id em erro em vez de build local,
para uso em CI de plataforma.

---

## 9. O que não existe de propósito

| Ausência | Motivo |
| --- | --- |
| IA gerenciada pela plataforma | Regra de custo do projeto |
| Proxy pago de pesquisa | Regra de custo do projeto |
| JWT emitido pela aplicação | A identidade é da plataforma |
| Servidor OAuth próprio | Idem |
| Retry automático em provedor | Cada tentativa pode ser cobrada |
| SQLite no Worker | Não existe sistema de arquivos; Records é o armazenamento |
| Compartilhamento entre usuários | Não especificado; implementá-lo sem modelo de permissão seria risco |
