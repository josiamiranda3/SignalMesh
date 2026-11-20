# Banco de dados

Duas implementações, um modelo.

| Runtime | Armazenamento | Arquivo |
| --- | --- | --- |
| Worker (produção) | DeepSpace Records — SQLite dentro de um Durable Object | `src/schemas.ts` + `server/repositories/records/` |
| Node (local/testes) | SQLite via `node:sqlite` | `server/db.ts` + `server/repositories/sqlite.ts` |

A modelagem é a mesma nos dois. Nomes de collection, nomes de campo, tipos e relações são
idênticos; a diferença é *como* cada um expressa a mesma restrição.

---

## 1. Modelo

```
users ──┬── sessions (só SQLite)
        │
        ├── investigations ──┬── evidence ──┬── validations
        │                    │              │
        │                    ├── analyses   │
        │                    ├── validations
        │                    ├── activity_logs
        │                    └── research_queries
        │
        ├── activity_logs
        ├── usage_records
        └── app_settings
```

---

## 2. Equivalência de restrições

| Restrição | SQLite | DeepSpace Records |
| --- | --- | --- |
| Isolamento por dono | `WHERE owner_id = ?` no repositório | `ownerField: 'ownerId'` + `read/update/delete: 'own'` avaliados no DO |
| Unicidade de fonte | `UNIQUE (investigation_id, url_normalized)` | `uniqueOn: ['investigationId', 'urlNormalized']` |
| Criação obrigatória | `NOT NULL` | `required: true` na coluna |
| Limite de texto | validado no zod | `maxLength` na coluna |
| JSON | `TEXT` + stringify manual | `{ kind: 'json' }` (serializa sozinho) |
| Booleano | `INTEGER` 0/1 | `storage: 'number'` + `{ kind: 'boolean' }` |
| Exclusão em cascata | `ON DELETE CASCADE` | deleção explícita nos serviços (não há FK entre collections) |
| Índices | `CREATE INDEX` explícito | o DO indexa as colunas consultadas |

### Por que `urlNormalized` é uma coluna

A constraint `uniqueOn` é avaliada pelo banco sobre valores **armazenados**. O banco não
normaliza URL por nós, então o adaptador grava o resultado de `normalizeUrl()` (sem `utm_*`,
`gclid`, fragmento ou barra final) em uma coluna própria e a usa na comparação. É a mesma
estratégia do `UNIQUE` do SQLite.

Consequência: a unicidade é garantida pelo armazenamento, não apenas pelo serviço. Um bug
no serviço não consegue criar duas evidências para a mesma fonte.

---

## 3. Collections

Todas as collections de domínio declaram `ownerField: 'ownerId'` e o bloco de permissões:

```ts
ownerField: 'ownerId',
permissions: {
  viewer: { read: 'own', create: false, update: false, delete: false },
  member: { read: 'own', create: true,  update: 'own', delete: 'own'   },
  admin:  { read: true,  create: true,  update: true,  delete: true     },
}
```

### 3.1 `investigations`

| Campo | Storage | Interpretação | Notas |
| --- | --- | --- | --- |
| `ownerId` | text | plain | obrigatório, fronteira de isolamento |
| `title` | text | plain | obrigatório, `maxLength: 160` |
| `description` | text | plain | `maxLength: 4000` |
| `objective` | text | plain | obrigatório, `maxLength: 2000` |
| `topic` | text | plain | obrigatório, `maxLength: 300` |
| `keywords` | text | json | array |
| `status` | text | select | `draft` \| `active` \| `completed` \| `archived` |
| `createdAt`, `updatedAt` | text | plain | ISO-8601 UTC |

### 3.2 `evidence`

Campos como no SQLite, mais `urlNormalized`. A `uniqueOn` é
`['investigationId', 'urlNormalized']`.

`retrievedContent`, `publishedAt` e `author` são nullable de propósito: o provedor pode não
devolvê-los, e o produto exige declarar a ausência em vez de preencher.

### 3.3 `analyses`

`referenceIds` guarda **só ids**. Títulos e URLs são resolvidos das evidências vivas no
momento da leitura, então renomear uma fonte não deixa um rótulo velho em uma análise
antiga.

`status` é `completed` | `failed`. Análises falhas são persistidas com `errorMessage` — o
usuário vê o que aconteceu, e o operador distingue falha de provedor de bug.

### 3.4 `validations`

Somente inserções. `previousStatus` registra o estado anterior, então o histórico é a
sequência de linhas ordenada por `createdAt`.

### 3.5 `activity_logs` e `usage_records`

**Append-only para membros**: `create: true`, `update: false`, `delete: false`. Uma trilha
de auditoria que o auditado pode reescrever não é uma trilha de auditoria, e uma cota que o
usuário pode apagar não é uma cota.

### 3.6 `research_queries`

Guarda o hash da consulta para a guarda de duplicata. Não guarda resultados.

### 3.7 `app_settings`

`uniqueOn: ['ownerId', 'key']`. Preferências por usuário; nunca segredos.

### 3.8 `users`

Obrigatório pelo SDK (`USERS_COLUMNS`). Nunca renomear, substituir ou remover. A linha é
provisionada pela plataforma quando alguém entra; o adaptador só lê.

---

## 4. Acesso

### 4.1 Pelo Worker

Todo acesso passa por `server/repositories/records/transport.ts`, que fala com o endpoint
de tools do Durable Object:

```
POST https://internal/api/tools/execute
x-user-id: <usuário verificado>
{ "tool": "records.query", "params": { ... } }
```

`X-App-Action` **não** é enviado (exceto no leitor de consumo global — ver §5). Sem esse
header, o DO:

1. resolve o papel do chamador a partir de `x-user-id`;
2. aplica as `permissions` da collection;
3. filtra linhas por `ownerField` antes de devolver.

### 4.2 Pelo navegador

O navegador **não** acessa Records para dados de negócio. `RecordProvider`/`RecordScope`
são montados para as superfícies do SDK (autenticação, presença, e qualquer view em tempo
real futura), com as mesmas `permissions` — mas as telas do SignalMesh leem `/api/*`, onde a
autorização e o cálculo acontecem. Não há caminho em que o cliente escreva direto em uma
collection sem passar pela validação e pelas regras do servidor.

---

## 5. Consumo global

O teto diário global precisa somar todas as contas. `countInWindow(null, …)` é respondido por
`createGlobalUsageReader`, que usa o transporte administrativo e devolve **um número**.

Nenhuma outra operação usa esse transporte. `tests/integration/records-security.test.ts`
verifica que a visão de membro vê apenas o próprio consumo e que a visão administrativa é a
única que soma a plataforma.

---

## 6. Migração de dados locais

O caminho é `npm run migrate:records`, implementado em `server/migration/records.ts`:

1. lê cada linha pela interface de repositório (fonte: SQLite);
2. grava com o **id original**, então as relações sobrevivem;
3. normaliza URLs na importação, para a constraint de unicidade concordar com o que o
   adaptador Records teria gravado;
4. é idempotente: uma segunda execução não duplica, e uma linha idêntica conta como
   `unchanged`;
5. `--dry-run` relata o que faria sem gravar;
6. **nunca apaga a origem**.

```
Migração 2026-… → 2026-…
investigations     lidos     1 · gravados     1 · iguais     0 · ignorados    0 · falhas 0
evidence           lidos     1 · gravados     1 · iguais     0 · ignorados    0 · falhas 0
…
Total: 6 lidos, 6 gravados, 0 inalterados, 0 ignorados, 0 falhas.
```

A migração escreve em nome dos donos originais, então roda com credencial de operador —
nunca pelo navegador. `tests/integration/migration.test.ts` cobre os sete cenários:
cópia completa, normalização de URL, idempotência, dry-run, origem intacta, filtro por dono
e relatório legível.

---

## 7. Schema local (SQLite)

O esquema em `server/db.ts` é aplicado com `CREATE TABLE IF NOT EXISTS`, WAL e
`foreign_keys = ON`. Tabelas: `users`, `sessions`, `investigations`, `evidence`,
`analyses`, `validations`, `activity_logs`, `usage_records`, `research_queries`,
`app_settings`.

`sessions` existe **apenas** aqui: a plataforma gerencia a sessão no runtime de produção.

Diferenças a lembrar ao mexer no adaptador Records:

- SQLite aplica FK (é preciso criar a linha em `users` antes); Records não tem FK entre
  collections.
- SQLite devolve `INTEGER` para booleano; Records devolve booleano pela interpretação.
- SQLite não tem `nextOffset`; o adaptador Records pagina e o repositório junta as páginas.

A suíte de paridade cobre esses pontos e falha se um adaptador divergir.

---

## 8. Evolução

Para adicionar um campo:

1. adicione a coluna em `src/schemas.ts` (Records) **e** em `server/db.ts` (SQLite);
2. adicione ao mapeamento no adaptador Records e no SQLite;
3. adicione ao DTO em `shared/domain.ts` se for exposto;
4. adicione um caso à suíte de paridade.

O SDK roda migrações **aditivas** automaticamente quando o Durable Object reinicia: criar
tabela e `ALTER TABLE ADD COLUMN` são seguros. Mudanças destrutivas (remover coluna, mudar
tipo, renomear campo) não são — nesse caso, exporte (JSON) e recrie.

Para uma mudança destrutiva em produção, o caminho é: exportar por investigação, migrar os
dados para a nova forma fora do app, e só então alterar o schema.
