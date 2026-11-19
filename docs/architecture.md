# Arquitetura

Este documento explica **por que** o SignalMesh está estruturado assim, não apenas como.
Cada decisão abaixo tem uma consequência verificável no código e nos testes.

---

## 1. Visão geral

O sistema tem três camadas de execução e duas fronteiras de confiança.

```
Navegador ──(1)──► Servidor Hono ──(2)──► Provedores externos
    ▲                    │
    └──(3)── SQLite ◄────┘
```

| Fronteira | O que cruza | Como é controlado |
| --- | --- | --- |
| (1) | JSON, cookie de sessão | Validação zod, CSRF, verificação de posse |
| (2) | Consulta e evidências | Interruptores de custo, cotas, chaves só no servidor |
| (3) | Dados persistidos | Queries parametrizadas, isolamento por `owner_id` |

O navegador **nunca** é a autoridade de nada: nem de sessão, nem de cota, nem de
permissão. Ele é uma superfície de apresentação e de intenção.

---

## 2. As quatro camadas do servidor

### 2.1 HTTP (`server/http/`)

Responsabilidade única: traduzir HTTP em chamadas de serviço.

- `middleware.ts` — anexa serviços ao contexto, aplica CSRF, resolve a sessão.
- `auth-routes.ts` — login, logout, `/me`, configuração do adaptador.
- `api-routes.ts` — todos os endpoints de negócio.

Nenhuma regra de negócio vive aqui. Um handler típico são seis linhas: parse do corpo com
schema, chamada ao serviço, envelope de resposta.

**Por que:** sem isso, a mesma regra acaba duplicada entre a rota e o serviço, e a
divergência só aparece em produção — quando o cliente e o servidor discordam sobre o que é
válido.

### 2.2 Serviços (`server/services/`)

Onde a regra de negócio mora. Não conhecem HTTP, não conhecem SQL.

| Serviço | Responsabilidade | Invariante que protege |
| --- | --- | --- |
| `investigations` | Ciclo de vida e posse | `requireOwned` antes de qualquer leitura/escrita |
| `evidence` | Armazenamento e priorização | URL normalizada impede duplicata |
| `research` | Orquestração da Exa | reserva → chamada → settlement → atividade |
| `analysis` | Orquestração do Gemini | referências validadas antes de persistir |
| `validation` | Decisão humana | toda mudança é um evento novo |
| `activity` | Trilha de auditoria | registro persistido, nunca em memória |
| `usage` | Proteção de custo | cota checada no backend, sempre |
| `dashboard` | Agregação | números derivados de linhas reais |
| `export` | Serialização | apenas dados do chamador |

**Por que uma classe por serviço:** cada um tem uma invariante única. Misturar
"autorização" com "montagem de CSV" produz um módulo onde é impossível provar que a
autorização aconteceu antes da leitura.

### 2.3 Repositórios (`server/repositories/`)

`ports.ts` declara interfaces. `sqlite.ts` implementa.

Nenhum serviço importa `sqlite.ts`; todos importam `ports.ts`. Isso é verificado pelos
testes de integração, que constroem o app com um banco em memória e exercitam a mesma
API pública.

**Por que:** o requisito explícito é poder trocar DeepSpace Records (ou outro banco) sem
reescrever regra de negócio. Com portas, isso é um novo arquivo, não um refactor.

### 2.4 Integrações (`server/integrations/`)

`exa.ts` e `gemini.ts` são os únicos módulos que fazem chamadas externas.

Cada um:
- valida que está utilizável (`assertUsable`) antes de tocar a rede;
- usa `AbortController` com timeout explícito;
- mapeia **cada** status documentado do provedor para um erro tipado;
- **nunca** repete automaticamente.

**Por que nenhum retry:** um retry automático em uma API cobrada por requisição é uma
cobrança que o usuário não autorizou. A repetição é uma ação explícita na interface.

---

## 3. Contrato compartilhado (`shared/`)

Cliente e servidor importam os mesmos tipos e os mesmos schemas zod.

```
shared/
├── domain.ts      entidades e enums
├── api.ts         envelope ApiResponse<T> e DTOs
├── schemas.ts     validação de entrada (usada nos dois lados)
├── relevance.ts   função pura de priorização
└── analysis.ts    schema da análise + validação de referências
```

**Por que:** o formulário e o endpoint não podem discordar sobre "o que é um título
válido". Quando existe uma única definição, essa classe de bug deixa de existir.

Um caso concreto aprendido durante o desenvolvimento: `investigationUpdateSchema` não pode
ser derivado de `.partial()` sobre um schema com `.default()`, porque o zod injeta os
defaults em campos ausentes e o PATCH apaga silenciosamente campos que o usuário não
enviou. Isso está corrigido com um schema base sem defaults e coberto por teste
(`tests/unit/schemas.test.ts`).

---

## 4. Fluxo: da pergunta à evidência validada

```
1. Criar investigação
   POST /api/investigations
   → investigations.create + activity('investigation.created')

2. Pesquisar
   POST /api/investigations/:id/research
   → requireOwned
   → exa.assertUsable        (interruptor + chave)
   → guarda de duplicata     (janela configurável)
   → usage.reserve           (cota do usuário + global + single-flight)
   → exa.search              (timeout, sem retry)
   → usage.settle            (sucesso ou falha classificada)
   → activity('research.executed')
   → resposta com contentNotice honesto

3. Adicionar evidências
   POST /api/investigations/:id/evidence/bulk
   → normalização de URL
   → detecção de duplicata por investigação
   → score de relevância no momento da coleta
   → activity('evidence.added')

4. Analisar
   POST /api/investigations/:id/analyses
   → somente evidências armazenadas e do chamador
   → prompt com fontes delimitadas como não confiáveis
   → Gemini com responseSchema
   → validateAnalysisPayload contra o conjunto real de ids
   → sucesso: analyses(status=completed)
     falha:    analyses(status=failed) + erro tipado ao chamador

5. Validar
   POST /api/evidence/:id/validation
   → justificativa obrigatória em rejected/needs_review
   → novo registro em validations com previousStatus
   → espelho de status em evidence para filtragem
   → activity('validation.recorded')

6. Exportar
   GET /api/investigations/:id/export?format=json|csv&scope=...
   → apenas linhas do chamador
   → activity('export.generated')
```

**Ponto crítico:** a etapa 4 nunca confia no modelo. O `responseSchema` reduz a
probabilidade de erro de formato; a validação de referências garante a propriedade que
importa. São defesas diferentes para riscos diferentes.

---

## 5. Fluxo de uma requisição

```
POST /api/investigations/:id/research
  │
  ├─ withServices        anexa serviços e requestId
  ├─ csrfGuard           rejeita sem header ou com origem estranha
  ├─ requireUser         resolve cookie → usuário real (revalida no banco)
  ├─ parseBody(zod)      rejeita com detalhes por campo
  ├─ service             regra de negócio
  │
  └─ onError             converte AppError → envelope + status
                         loga contexto sem credenciais
```

Se algo escapar como exceção não tratada, o cliente recebe `500` com mensagem genérica e
um `requestId`; o detalhe vai apenas para o log do servidor. Isso é intencional: um stack
trace no navegador é um mapa do sistema para um atacante.

---

## 6. Frontend

### 6.1 Rotas

```
/                       landing (estática, sem fetch)
/login                  autenticação
/dashboard              visão geral
/investigations         listagem com busca/filtro/ordenação
/investigations/new     criação
/investigations/:id     detalhe + gerenciamento
/investigations/:id/research
/investigations/:id/evidence
/investigations/:id/analysis
/investigations/:id/validation
/validation             fila global de validação
/history                trilha de auditoria
/settings               provedores, limites, conta
```

Todas exceto `/` e `/login` estão dentro de `<RequireAuth>`, que redireciona para
`/login?next=<destino>` preservando o caminho pretendido.

### 6.2 Estado

- **Sessão:** `AuthProvider` — o servidor é a fonte de verdade; um `401` significa
  deslogado. Nada de usuário em `localStorage`.
- **Dados remotos:** `useAsync`, que modela `loading`, `error`, `refreshing` e `reload`.
  Em refetch, mantém os dados anteriores visíveis (a tabela não colapsa em skeleton a cada
  tecla digitada).
- **Estado local:** `useState` por tela. Não há store global porque não há estado global
  real — apenas sessão (contexto) e dados por rota.

**Por que não Redux/Zustand:** adicionar uma store global para dois tipos de estado
(sessão e dados de rota) cria uma camada de sincronização que precisa ser mantida e
testada, sem resolver nenhum problema existente.

### 6.3 Design system

Tokens em `src/styles.css` (Tailwind v4 `@theme`):

- superfícies em cinco níveis (`canvas` → `overlay`);
- quatro níveis de tinta, **todos** acima de 4.5:1 de contraste no fundo mais escuro;
- três acentos (azul, violeta, ciano) usados com significado, não como decoração;
- semânticos: sucesso, atenção, erro.

Componentes em `src/components/ui/` são primitivas reais, com estados de foco, erro,
desabilitado e carregamento. A auditoria automatizada de design (`npm run audit:design`)
verifica contraste WCAG AA, overflow horizontal, texto cortado, alvos de toque e
hierarquia em 13 rotas × 3 viewports.

---

## 7. Decisões de execução local

O runtime local roda o mesmo `app.ts` que seria montado em um worker. A diferença está
apenas no bootstrap (`server/dev.ts` serve o build e o Vite faz proxy em desenvolvimento).

**Por que:** testar o app real, com middleware e serviços reais, em vez de testar handlers
isolados. Os testes de integração exercitam cookies, CSRF, streaming e erros exatamente
como o navegador faria.

---

## 8. O que não existe de propósito

| Ausência | Motivo |
| --- | --- |
| Chamada de IA gerenciada pela plataforma | Proibido pela regra de custo do projeto |
| Proxy pago de pesquisa | Proibido pela regra de custo do projeto |
| Scraping de páginas | A Exa já fornece conteúdo; scraping ampliaria superfície e custo |
| Retry automático em provedor | Cada tentativa pode ser cobrada |
| Compartilhamento entre usuários | Não especificado, e implementá-lo sem requisito de permissão seria um risco de privacidade |
| Editor rich-text | O produto é sobre integridade de evidência, não formatação |
