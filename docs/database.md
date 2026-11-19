# Banco de dados

Persistência local em **SQLite** através do módulo nativo `node:sqlite` do Node 24 (sem
dependência compilada, sem binário externo).

O esquema é aplicado de forma idempotente na inicialização (`server/db.ts`), com
`PRAGMA journal_mode = WAL` e `PRAGMA foreign_keys = ON`.

---

## 1. Modelo relacional

```
users ──┬── sessions
        │
        ├── investigations ──┬── evidence ──┬── validations
        │                    │              │
        │                    ├── analyses   │
        │                    ├── validations
        │                    ├── activity_logs
        │                    └── research_queries
        │
        ├── activity_logs
        └── usage_records
```

Todas as chaves estrangeiras usam `ON DELETE CASCADE` a partir de `investigations` e
`users`, exceto `activity_logs.investigation_id`, que aceita `NULL` para preservar o
evento de exclusão.

---

## 2. Collections

### 2.1 `users`

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | TEXT PK | `usr_...` |
| `email` | TEXT UNIQUE NOT NULL | identidade no adaptador local |
| `name` | TEXT NOT NULL | exibição |
| `avatar_url` | TEXT | opcional |
| `created_at` | TEXT | ISO-8601 UTC |

### 2.2 `sessions`

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `token_hash` | TEXT PK | SHA-256 do token; o token em si nunca é gravado |
| `user_id` | TEXT FK → users | cascade |
| `created_at`, `expires_at` | TEXT | expiração absoluta |

Índice: `idx_sessions_user (user_id)`.

### 2.3 `investigations`

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | TEXT PK | `inv_...` |
| `owner_id` | TEXT FK → users | **fronteira de isolamento** |
| `title` | TEXT NOT NULL | 3–160 |
| `description` | TEXT NOT NULL | pode ser vazio |
| `objective` | TEXT NOT NULL | 10–2000, obrigatório |
| `topic` | TEXT NOT NULL | base da consulta |
| `keywords` | TEXT (JSON) | array de até 20 |
| `status` | TEXT NOT NULL | `draft` \| `active` \| `completed` \| `archived` |
| `created_at`, `updated_at` | TEXT | ISO-8601 UTC |

Índice: `idx_investigations_owner (owner_id, updated_at DESC)`.

### 2.4 `evidence`

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | TEXT PK | `evi_...` |
| `investigation_id` | TEXT FK → investigations | cascade |
| `owner_id` | TEXT FK → users | redundante de propósito: permite checar posse sem join |
| `title`, `url`, `domain` | TEXT | |
| `url_normalized` | TEXT | usada só para deduplicação |
| `snippet` | TEXT | trecho exibido |
| `retrieved_content` | TEXT NULL | conteúdo integral **quando o provedor retornou** |
| `published_at` | TEXT NULL | `NULL` quando a fonte não informa data |
| `author` | TEXT NULL | |
| `collected_at` | TEXT NOT NULL | momento da coleta (≠ data de publicação) |
| `source` | TEXT | `exa` \| `demo` |
| `source_metadata` | TEXT (JSON) | request id, disponibilidade de conteúdo |
| `content_availability` | TEXT (JSON) | `['text','highlights','summary']` |
| `relevance_score` | REAL NULL | 0..1 |
| `relevance_breakdown` | TEXT (JSON) NULL | componentes, pesos, justificativa, ausentes |
| `validation_status` | TEXT | espelho da última decisão |
| `note` | TEXT | observação do pesquisador |
| `created_at`, `updated_at` | TEXT | |

Restrição: `UNIQUE (investigation_id, url_normalized)` — a garantia de não duplicação
existe no banco, não só na aplicação.

Índices: `idx_evidence_investigation`, `idx_evidence_owner`.

### 2.5 `analyses`

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | TEXT PK | `ana_...` |
| `investigation_id`, `owner_id` | TEXT FK | cascade |
| `evidence_ids` | TEXT (JSON) | **exatamente** o conjunto enviado |
| `model` | TEXT | ex.: `gemini-2.5-flash` |
| `status` | TEXT | `completed` \| `failed` |
| `executive_summary` | TEXT | |
| `findings` | TEXT (JSON) | `[{ statement, evidenceIds, confidence }]` |
| `key_points`, `supported_claims` | TEXT (JSON) | arrays de string |
| `contradictions` | TEXT (JSON) | `[{ description, evidenceIds }]` |
| `limitations`, `information_gaps` | TEXT (JSON) | arrays de string |
| `objective_alignment` | TEXT | |
| `reference_ids` | TEXT (JSON) | ids citados, todos verificados |
| `insufficient_evidence` | INTEGER | 0/1 |
| `raw_structured_output` | TEXT (JSON) NULL | payload validado, para auditoria |
| `usage` | TEXT (JSON) NULL | tokens |
| `error_message` | TEXT NULL | preenchido em falhas |
| `created_at` | TEXT | |

Índice: `idx_analyses_investigation (investigation_id, created_at DESC)`.

**Por que análises falhas são persistidas:** o usuário vê o que aconteceu, e o operador
consegue distinguir "o modelo inventou uma referência" de "o botão não fez nada".

### 2.6 `validations`

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | TEXT PK | `val_...` |
| `investigation_id`, `evidence_id`, `owner_id` | TEXT FK | cascade |
| `status` | TEXT | `pending` \| `accepted` \| `rejected` \| `needs_review` |
| `previous_status` | TEXT NULL | status no momento da decisão |
| `justification` | TEXT | obrigatória em `rejected`/`needs_review` |
| `created_at` | TEXT | |

Índices: `idx_validations_evidence`, `idx_validations_investigation`.

**Somente inserções.** Alterar uma decisão cria uma nova linha. O histórico é a sequência.

### 2.7 `activity_logs`

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | TEXT PK | `act_...` |
| `investigation_id` | TEXT FK NULL | `NULL` para eventos de escopo de conta |
| `owner_id` | TEXT FK → users | cascade |
| `event_type` | TEXT | enum em `shared/domain.ts` |
| `description` | TEXT | legível por humano |
| `metadata` | TEXT (JSON) | detalhes específicos do evento |
| `created_at` | TEXT | |

Índices: `idx_activity_owner`, `idx_activity_investigation`.

### 2.8 `usage_records`

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | TEXT PK | `use_...` |
| `owner_id` | TEXT FK → users | |
| `provider` | TEXT | `exa` \| `gemini` |
| `operation` | TEXT | `research` \| `analysis` |
| `status` | TEXT | `success` \| `error` \| `blocked` |
| `quantity` | INTEGER | 0 para bloqueios |
| `investigation_id` | TEXT NULL | |
| `error_code` | TEXT NULL | código tipado |
| `metadata` | TEXT (JSON) | custo informado, tokens, etc. |
| `created_at` | TEXT | |

Índices: `idx_usage_owner_time`, `idx_usage_operation`.

**Por que registrar bloqueios:** a cota é uma decisão de produto. Sem o registro de
recusas, não há como responder "quantas vezes o limite interrompeu o usuário?".

### 2.9 `research_queries`

Guarda o hash da consulta para a guarda de duplicata. Não armazena resultados — apenas o
fato de a consulta ter ocorrido, quando e com qual retorno.

| Coluna | Tipo |
| --- | --- |
| `id` | TEXT PK |
| `investigation_id`, `owner_id` | TEXT FK |
| `query_hash` | TEXT (SHA-256) |
| `query` | TEXT |
| `result_count` | INTEGER |
| `provider_request` | TEXT NULL |
| `created_at` | TEXT |

Índice: `idx_research_hash (owner_id, query_hash, created_at DESC)`.

### 2.10 `app_settings`

Chave/valor para preferências administrativas (limites por usuário). Não guarda segredos.

---

## 3. Regras de isolamento

Toda tabela com dado de usuário carrega `owner_id`. A verificação acontece em duas
camadas:

1. **Serviço** — `requireOwned(id, userId)` carrega a linha e compara. Se não bater,
   lança `not_found` (não `forbidden`): a API não confirma que o registro existe.
2. **Query** — listagens sempre filtram por `owner_id` no `WHERE`.

Não existe caminho de código que aceite um `ownerId` vindo do cliente. O valor vem sempre
da sessão verificada.

### Testes que provam isso

`tests/integration/auth-isolation.test.ts` cobre, com dois usuários reais:

- leitura, atualização, exclusão e exportação de investigação alheia → `404`;
- listagem não inclui investigações de outro usuário;
- pesquisa em investigação alheia → `404` **e nenhuma chamada ao provedor**;
- validação de evidência alheia → `404`.

---

## 4. Índices e desempenho

Os índices cobrem exatamente as consultas que existem:

| Consulta | Índice |
| --- | --- |
| Listar investigações do usuário por atualização | `idx_investigations_owner` |
| Evidências de uma investigação | `idx_evidence_investigation` |
| Contagem de evidências por dono | `idx_evidence_owner` |
| Análises de uma investigação | `idx_analyses_investigation` |
| Histórico de uma evidência | `idx_validations_evidence` |
| Feed global | `idx_activity_owner` |
| Cota do dia | `idx_usage_owner_time` |
| Guarda de duplicata | `idx_research_hash` |

Não há índice "preventivo": cada um corresponde a uma query que o código executa.

---

## 5. Migrações

O esquema usa `CREATE TABLE IF NOT EXISTS`, aplicado na inicialização. Para evolução:

1. adicione a nova coluna/tabela ao `SCHEMA` em `server/db.ts`;
2. escreva um `ALTER TABLE ... ADD COLUMN` idempotente se a tabela já existir;
3. adicione um teste de integração que exercite a leitura após a migração.

Para uma mudança destrutiva, o caminho é exportar (o export JSON já existe) e recriar —
não há migração automática que apague dados sem confirmação.

---

## 6. Equivalência com DeepSpace Records

Para portar o esquema, use `CollectionSchema` de `deepspace/schema`:

```ts
import type { CollectionSchema } from 'deepspace/schema'

export const investigationsSchema: CollectionSchema = {
  name: 'investigations',
  columns: [
    { name: 'ownerId',      storage: 'text', interpretation: 'plain' },
    { name: 'title',        storage: 'text', interpretation: 'plain' },
    { name: 'description',  storage: 'text', interpretation: 'plain' },
    { name: 'objective',    storage: 'text', interpretation: 'plain' },
    { name: 'topic',        storage: 'text', interpretation: 'plain' },
    { name: 'keywords',     storage: 'text', interpretation: { kind: 'json' } },
    { name: 'status',       storage: 'text', interpretation: { kind: 'select', options: ['draft','active','completed','archived'] } },
  ],
  permissions: {
    member: { read: 'own', create: true, update: 'own', delete: 'own' },
    admin:  { read: true,  create: true, update: true,  delete: true },
  },
}
```

Diferenças a considerar:

| SQLite local | DeepSpace Records |
| --- | --- |
| `TEXT` com JSON serializado manualmente | `{ kind: 'json' }` serializa/deserializa automaticamente |
| `UNIQUE(investigation_id, url_normalized)` | `uniqueOn: ['investigationId', 'urlNormalized']` |
| `owner_id` checado no serviço | `permissions.member.read: 'own'` reforça no banco |
| `CASCADE` no `DELETE` | deleção explícita em cascata nos serviços |
| `REAL` para score | `storage: 'number'`, `interpretation: 'plain'` |

O adaptador DeepSpace deve implementar as mesmas interfaces de
`server/repositories/ports.ts`. Nenhum serviço muda.
