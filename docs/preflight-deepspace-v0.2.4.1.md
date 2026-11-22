# Pré-verificação DeepSpace — v0.2.4.1

Diagnóstico somente leitura. Nenhuma operação de registro, publicação, alteração de recurso,
escrita de secret, migração, chamada externa ou paga foi executada. Nenhum arquivo do projeto
foi modificado.

**Veredito: BLOQUEADO** — por ausência de sessão autenticada, com o restante do ambiente
tecnicamente apto (§9).

---

## 1. Estado da conta

| Item | Estado |
| --- | --- |
| Conta autenticada | **nenhuma** |
| Identidade verificável | **não** — `auth whoami` retorna `not_authenticated` |
| Sessão em disco (`~/.deepspace`) | **não existe** |
| App registrado | **não** — `DEEPSPACE_APP_ID` ainda é `__APP_ID__` |
| Origem de código | **não reivindicada** |
| Créditos / cobrança | **NÃO CONFIRMADO** — `app usage` exige sessão |

Não há como confirmar identidade, titularidade, plano ou saldo sem sessão. Consultado apenas o
necessário; nenhum token, cookie ou credencial foi lido ou registrado.

---

## 2. Estado da autenticação

```
$ deepspace auth whoami
x  Not logged in on production. Run `deepspace auth login`
   (headless: `deepspace auth login --email you@example.com --password-stdin`,
    or set DEEPSPACE_EMAIL and DEEPSPACE_PASSWORD). [not_authenticated]
```

Comando confirmado como **somente leitura** (seu `--help` expõe apenas `--json`) e executado.
Nenhum login interativo foi iniciado, nenhuma credencial solicitada.

O CLI documenta três vias de autenticação: interativa (`auth login`), headless com
`--email`/`--password-stdin`, e variáveis `DEEPSPACE_EMAIL`/`DEEPSPACE_PASSWORD`. Nenhuma foi
usada — todas criam sessão, o que excede esta etapa.

---

## 3. Estado do SDK e CLI

| Item | Valor |
| --- | --- |
| `deepspace` declarado | `0.44.2` (sem caret) |
| `deepspace` instalado | `0.44.2` |
| CLI | `dist/cli.js` (entrada real; `package.json` → `bin: {deepspace: "dist/cli.js"}`) |
| Versão do CLI | `deepspace v0.44.2` (coincide com o SDK) |
| Wrangler | `4.79.0` |
| `@cloudflare/vite-plugin` | `1.33.0` |
| `deepspace/build` (plugin de build) | presente |

SDK e CLI são **o mesmo pacote e a mesma versão** — não há como divergirem.

**Comandos oficiais confirmados** (lidos do próprio CLI, não presumidos):

- Autenticação: `auth login | logout | whoami | agent`
- Registro: `app init` (cunha o `DEEPSPACE_APP_ID` no `wrangler.toml`)
- Secrets: `secrets list | set | get | delete | upload | download | configs`
- Deploy: `deploy [-e <env>] [--push|--no-push] [--json]`
- Estado: `status`, `app list`, `app usage`, `app source`, `releases`

---

## 4. Compatibilidade do ambiente

| Requisito | Situação |
| --- | --- |
| Node `>=22.15 <23 \|\| >=24 <25 \|\| >=26 <27` (projeto **e** SDK) | ✅ atual `24.22.0` satisfaz ambos |
| npm `>=11.6.0` | ✅ |
| Dependências instaladas | ✅ `status` reporta `Deps installed` |
| Schemas do app × SDK (`lintSchemas`) | ✅ **zero avisos** |
| SO | Windows — nenhuma incompatibilidade declarada nos tipos |

**Ressalva de Windows:** o `workerd` não executa nesta máquina (crash `std::terminate`,
diagnosticado em [validation-v0.2.4.1.md](validation-v0.2.4.1.md) §1.4). Isso afeta a
**verificação local** do runtime, não o deploy — o empacotamento via wrangler funciona
(17/17). Mas significa que o Worker não pode ser testado localmente antes de publicar.

---

## 5. Requisitos de Auth, Records e Worker

### Injetados pela plataforma (não devem ser definidos à mão)

| Binding | Uso |
| --- | --- |
| `DEEPSPACE_APP_ID` | identidade imutável do app |
| `AUTH_JWT_PUBLIC_KEY` | verificação ES256 do JWT |
| `AUTH_JWT_ISSUER` | emissor esperado |
| `OWNER_USER_ID` | dono do app; admin do RecordRoom |
| `RECORD_ROOMS` | namespace do Durable Object |
| `ASSETS` | binding de assets estáticos |

Confirmado nos tipos do SDK (`worker.d.ts:2941–2949`, `AccountStoreRouteEnv`) e no scaffold
oficial. O `wrangler.toml` do projeto declara apenas `RECORD_ROOMS` e `ASSETS` — correto,
porque os demais são injetados no deploy.

### Definidos pelo app (já no `wrangler.toml`)

`ENABLE_EXTERNAL_APIS=false`, `ENABLE_PAID_OPERATIONS=false`, limites diários, modelo Gemini,
`EXA_SEARCH_TYPE`, `DUPLICATE_GUARD_SECONDS`.

### Secrets a cadastrar na plataforma

`EXA_API_KEY`, `GEMINI_API_KEY` — declarados como detectados no próprio `wrangler.toml`.

### Auth e Records

- **Auth:** `RecordRoom` recebe `{ ownerUserId: env.OWNER_USER_ID }`; a autorização é por JWT
  verificado. Nenhuma configuração adicional é exigida além dos bindings injetados.
- **Records:** uma migration declarada (`tag = "v1"`, `new_sqlite_classes = ["AppRecordRoom"]`)
  e o binding `RECORD_ROOMS`. As 8 collections têm `ownerId` `userBound` + `immutable`.

---

## 6. Custos e quotas conhecidos

### Confirmado (lido do SDK instalado)

Limites de armazenamento por tier (`ACCOUNT_STORAGE_LIMIT_BYTES`, valores em runtime):

| Tier | Limite |
| --- | --- |
| test | 0 |
| **free** | **1 GiB** |
| starter | 10 GiB |
| premium | 30 GiB |
| admin | 100 GiB |

### NÃO CONFIRMADO

- **Custo de registro, deploy, execução e Durable Objects.** Não há tabela de preços no pacote
  instalado; `app usage` exige sessão. Não presumo que seja gratuito.
- **Tier da conta.** Desconhecido sem sessão.
- **Necessidade de cartão.** Desconhecida.
- **Cotas de subrequests e de DO.** Não localizadas.

### O que o app **não** usa (verificado por busca no código)

`meterAi`, `meterVectorize`, `meterUsage`, `tools.integration`, `apiWorkerFetch`,
`createDeepSpaceAI`, `deepspace/ai`, `knowledge`, `composio` — **todos ausentes**. As taxas de
`COST_RATES` do SDK (AI, Vectorize, AI Search) não se aplicam a este app.

Exa e Gemini são chamados **diretamente**, com chaves próprias, fora do proxy cobrado da
plataforma. Com `ENABLE_EXTERNAL_APIS=false`, nenhuma chamada ocorre hoje.

---

## 7. Impedimentos encontrados

| # | Impedimento | Severidade |
| --- | --- | --- |
| 1 | **Sem sessão autenticada** — bloqueia todo o resto | **bloqueante** |
| 2 | App não registrado (`__APP_ID__`) | esperado; requer autorização |
| 3 | Origem de código não reivindicada | decisão permanente pendente (§8) |
| 4 | `workerd` não executa localmente | não bloqueia deploy; impede teste local do runtime |
| 5 | Custos não confirmáveis sem sessão | risco financeiro não quantificado |
| 6 | Secrets `EXA_API_KEY`/`GEMINI_API_KEY` ausentes | só relevante se as APIs forem habilitadas |

---

## 8. Operações que exigirão autorização posterior

Em ordem, cada uma com autorização explícita e separada:

1. **`deepspace auth login`** — cria sessão. (Primeiro destravamento.)
2. **Decidir a origem do código antes do primeiro deploy.** `app source` informou:
   *"first source use latches permanently: a deploy with a GitHub remote claims GitHub; a first
   push or deploy without one claims DeepSpace."* O repositório local **tem 3 commits e nenhum
   remoto** — logo, o primeiro deploy fixaria **DeepSpace** como origem, permanentemente. Se a
   intenção for GitHub, o remoto precisa existir **antes**.
3. **`deepspace app init`** — cunha o `DEEPSPACE_APP_ID`. Permanente.
4. **`secrets set EXA_API_KEY=…` / `GEMINI_API_KEY=…`** — a primeira escrita também registra o app.
5. **`deepspace deploy`** — trava a origem e publica.
6. Verificação pós-deploy de `/api/health`, do RecordRoom real e do `/ws/*`.
7. Só então avaliar `ENABLE_EXTERNAL_APIS=true`.

---

## 9. Recomendação: **BLOQUEADO**

O ambiente está tecnicamente pronto — SDK e CLI alinhados em `0.44.2`, Node compatível,
dependências instaladas, schemas com zero avisos de lint, configuração do Worker correta e
nenhuma superfície cobrada em uso. O que falta não é engenharia: é **uma sessão autenticada**,
que não pode ser criada sem credenciais do proprietário.

Duas ressalvas além do bloqueio, ambas para decisão humana:

1. **A origem do código é irreversível na primeira vez.** Sem remoto GitHub, o primeiro deploy
   fixa DeepSpace. É a decisão mais consequente desta fase e não deve ser tomada por omissão.
2. **Os custos não estão confirmados.** Não afirmo que registro ou execução sejam gratuitos,
   porque não consegui verificar. O tier `free` comporta 1 GiB de armazenamento, mas isso não
   diz nada sobre cobrança de requisições, DO ou deploy.

Nenhum passo foi executado além de consultas locais e de `auth whoami`/`status`/`app source`,
todas somente leitura.
