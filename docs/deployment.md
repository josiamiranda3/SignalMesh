# Gate de implantação

**Estado: NÃO IMPLANTADO.** A auditoria de segurança da v0.2.1 corrigiu quatro defeitos reais (ver [audit-v0.2.1.md](audit-v0.2.1.md)); o app continua **não registrado** e a integração **não validada** em ambiente real. Nenhum `deepspace deploy`, `push`, `app init`, billing ou
contratação foi executado. O app **não está registrado** na plataforma: `wrangler.toml` ainda
carrega o placeholder `__APP_ID__`. Este documento é o relatório exigido antes de qualquer
publicação e **não** constitui autorização.

---

## 1. O que mudou na fase 2

| Item | Fase 1 | Fase 2 |
| --- | --- | --- |
| Runtime de produção | Hono em Node | **Cloudflare Worker** (`worker.ts`) |
| Persistência de produção | não definida | **DeepSpace Records** (Durable Object) |
| Autenticação de produção | não definida | **DeepSpace Auth** (JWT verificado) |
| `@hono/node-server` | único runtime | **ausente do bundle do Worker** |
| Runtime local | único | mantido para desenvolvimento e testes |
| Empacotamento do Worker | não testado | **verificado com wrangler** (17 checagens) |
| Execução em workerd | não testada | **SKIPPED neste ambiente** (ver §7) |
| App registrado | não | **não** |
| Origem do código | não decidida | **não decidida** |

A compatibilidade técnica mudou de "planejada" para "implementada e empacotável". O que
continua pendente é a parte que exige autorização, não engenharia.

---

## 2. Sessão e conta

| Item | Situação verificada |
| --- | --- |
| SDK/CLI `deepspace` | **0.44.2** instalado no projeto |
| Sessão de CLI | **ausente** — `~/.deepspace/session` não existe |
| Conta autenticada | **desconhecida** |
| `npx deepspace auth whoami` | não executado com sucesso (sem sessão) |
| App registrado | **não** — `DEEPSPACE_APP_ID = "__APP_ID__"` |
| Estado de cobrança | **desconhecido** — exigiria sessão e dashboard |

---

## 3. Quotas gratuitas identificadas

| Recurso | O que a documentação afirma | Status |
| --- | --- | --- |
| Hospedagem `app.space` | incluída; SSL incluído | **documentado** |
| Durable Objects | um conjunto de classes por app | **documentado** (existência); limites **não** |
| Records (DO SQLite) | migrações aditivas automáticas; estado persiste entre deploys | **documentado** |
| Secrets | 128 por config, 32 KB por valor, 128 KB por config, 64 configs | **documentado** |
| Assets estáticos | servidos pelo binding `ASSETS` | **documentado** (existência); limite **não** |
| Integrações (proxy) | **cobradas dos créditos do proprietário** | **documentado** |
| Créditos gratuitos | **não localizado** na documentação pública consultada | **pendente** |
| Necessidade de cartão | **não localizado** | **pendente** |

### Ponto crítico: nenhuma integração paga é usada

A plataforma oferece um proxy de integrações cobrado dos créditos do proprietário. O
SignalMesh **não o usa**: `tools.integration`, `deepspace/ai` e o endpoint
`/api/integrations` estão ausentes do código de negócio. Exa e Gemini são chamados
diretamente dos módulos em `server/integrations/`, com chaves próprias no ambiente.

Verificação: o bundle do Worker contém `api.exa.ai` e
`generativelanguage.googleapis.com` como URLs de fetch, e não contém chamadas ao proxy de
integrações.

### 2.6 A contradição de autorização da v0.2.2 (corrigida na v0.2.3)

A versão 0.2.2 continha duas regras incompatíveis entre si:

| Regra | Onde estava | Efeito |
| --- | --- | --- |
| Toda ação exige `userId === OWNER_USER_ID` | `ownerOnly` em `server/actions/index.ts` | Só o dono do app podia executar. |
| A migração exige `ownerId === userId` | `migrateRecords` | Só se migrava o dado do próprio chamador. |

Juntas, elas significavam que **apenas o dono do app podia migrar, e apenas os dados do
próprio dono do app**. O dado de qualquer outra conta era inalcançável por qualquer pessoa.
Isso não é uma propriedade de segurança — é uma impossibilidade, num sistema explicitamente
multi-tenant.

**O que a plataforma realmente exige.** Nada disso. Lendo os tipos instalados
(`deepspace@0.44.2`) e o scaffold oficial:

- O SDK **não monta** a rota de ações. Ela é implementada pelo app — o scaffold
  `create-deepspace` registra `app.post('/api/actions/:name')` à mão, exatamente como este
  repositório.
- O SDK declara que *"this worker is the only authorization boundary"*: `resolveAuth`
  estabelece quem chama, e o resto roda com essa identidade e nenhuma checagem adicional.
- `OWNER_USER_ID` serve para duas coisas: tornar o dono do app administrador do RecordRoom
  (`new RecordRoom(state, env, schemas, { ownerUserId })`) e, no scaffold, escolher
  `APP_OWNER_JWT` para integrações cobradas do desenvolvedor. **Nenhuma delas é condição
  para despachar uma ação.**

**A correção.** `migrateRecords` passou a usar `selfScoped`, e `ownerOnly` permanece
disponível para operações genuinamente globais (sem escopo por linha). Ver §5.5.

### 2.7 Camadas de responsabilidade (o que é nosso e o que é da plataforma)

Distinção que a v0.2.2 embaralhava em comentários:

| Camada | Responsável | Onde |
| --- | --- | --- |
| Rota HTTP `POST /api/actions/:name` | **SIGNALMESH** | `server/http/action-routes.ts`, montada por `worker.ts` |
| Verificação do JWT | **SIGNALMESH**, usando `verifyJwt` do SDK | `resolveIdentity` em `worker.ts` |
| Política de autorização por ação | **SIGNALMESH** | `server/actions/index.ts` |
| Contrato de handler e tipos | SDK | `deepspace/worker` (`ActionHandler`, `ActionContext`) |
| Transporte até o RecordRoom (RBAC off) | SDK | `X-App-Action`, via `createActionTools` |
| RBAC por linha, `userBound`, `immutable` | SDK (Durable Object) | `src/schemas.ts` declara; o DO aplica |

A consequência prática: como o transporte desliga o RBAC por linha, **a checagem de posse é
responsabilidade do handler**. O SDK diz isso explicitamente e adverte que uma ação que
repassa um id vindo de `params` "não autorizou nada".

---

## 4. Limites que **não** foram verificados

Não afirmo nenhum destes valores:

- [ ] Créditos gratuitos por mês e o que consomem.
- [ ] Invocações de Worker por dia.
- [ ] Operações de Durable Object e tempo de CPU.
- [ ] Requisições por segundo ao RecordRoom.
- [ ] Armazenamento de Records (MB por app / por conta).
- [ ] Tamanho máximo do bundle do Worker.
- [ ] Limite de apps por conta.
- [ ] Comportamento ao exceder: bloqueio, cobrança automática ou suspensão.
- [ ] Exigência de cartão para ativar o `app.space`.
- [ ] Suspensão por inatividade.
- [ ] Retenção de dados após undeploy.

**Risco específico desta arquitetura:** cada operação de dados é um subrequest ao Durable
Object. O código pagina agressivamente (200 linhas por chamada) para reduzir a contagem, mas
uma listagem de coleção grande gasta vários subrequests. Se a plataforma limitar subrequests
por requisição, o ponto de atenção é o dashboard (agrega várias coleções). Isso precisa ser
medido no ambiente real antes de definir os limites diários para um público maior.

---

## 5. Condições de deploy

### 5.1 Pré-requisitos técnicos

- [x] Node `>=22.15 <23 || >=24 <25 || >=26 <27` — 24.22.0 neste ambiente.
- [x] `deepspace@0.44.2` instalado.
- [x] `wrangler@4.79.0` instalado.
- [x] `worker.ts` empacota com `wrangler deploy --dry-run` (17 checagens passam).
- [x] `@hono/node-server` e o adaptador SQLite ausentes do bundle.
- [x] Nenhum segredo embutido no bundle.
- [x] 224 testes automatizados passam.
- [x] Build da SPA funciona.
- [ ] App registrado (`app init`) — **requer autorização**.
- [ ] Sessão de CLI válida — **requer ação do proprietário**.
- [ ] Execução ao vivo em workerd — **não possível neste ambiente** (ver §7).

### 5.2 Decisão de origem de código (permanente)

A documentação é explícita: **a origem trava no primeiro uso de fonte e não há como
desfazer.** Não existe setter, unclaim ou transferência.

- Deploy com remote GitHub → trava **GitHub** permanentemente.
- `deepspace push`, ou deploy **sem** remote GitHub (incluindo `--no-push`) → trava
  **DeepSpace** permanentemente.

O requisito do projeto é preservar a possibilidade de usar **GitHub como fonte oficial**.
Portanto, na primeira publicação:

1. criar o repositório no GitHub;
2. `git remote add origin git@github.com:<org>/<repo>.git`;
3. `git push -u origin main`;
4. **só então** `npx deepspace app init` e o primeiro deploy.

**Não execute `app init` nem `deploy` antes dos passos 1–3.** Este é o ponto de não retorno.

### 5.3 Comandos que serão executados (e o que cada um faz)

Nenhum destes foi executado. Cada um precisa de autorização explícita.

| Comando | Efeito | Reversível |
| --- | --- | --- |
| `npx deepspace auth login` | abre o navegador; cria `~/.deepspace/session` | sim (logout) |
| `npx deepspace app init` | **registra o app e minta o `DEEPSPACE_APP_ID`**; grava em `wrangler.toml` | **não** (id é permanente) |
| `npx deepspace secrets set EXA_API_KEY=…` | grava segredo no store; primeira escrita também **registra o app** | sim (delete) |
| `npx deepspace deploy` | **trava a origem do código**; publica em `<nome>.app.space` | parcial (undeploy tira do ar; origem permanece) |
| `npm run migrate:records` | copia dados locais para o app implantado (uma conta por execução) | sim (não apaga origem) |

### 5.4 Trabalho técnico restante após autorização

| Item | Esforço | Observação |
| --- | --- | --- |
| Registrar o app | baixo | decisão permanente de origem |
| Definir secrets | baixo | `secrets set`, depois deploy |
| Verificar em workerd | baixo | `npm run test:worker` em ambiente que permita o runtime |
| Verificar o RecordRoom real | médio | o fake não é o binário do SDK; validar RBAC e `uniqueOn` reais |
| Executar a migração de dados | baixo | `migrate:records --dry-run` primeiro (ver §5.5) |
| Ajustar limites diários ao público | baixo | `wrangler.toml` |

Nenhum desses itens é uma reescrita: a arquitetura já está no formato da plataforma.

### 5.5 Migração SQLite → Records (v0.2.2)

O procedimento mudou em relação à v0.2.1: o CLI não abre mais a origem para escrita e
passou a enviar o cabeçalho anti-CSRF. Esta seção é o manual operacional.

**Estado.** Nada aqui foi executado. Não existe app registrado, nem destino, nem token de
proprietário — logo a migração real continua **bloqueada** por falta de credencial, que é o
desenho.

#### Pré-requisitos

1. App **registrado** (`DEEPSPACE_APP_ID` diferente de `__APP_ID__`) e **implantado** — a
   ação só existe no runtime Worker.
2. Token de sessão **do proprietário dos dados**, obtido fora de banda. O chamador precisa
   ser o dono das linhas, **não** o proprietário do app: a autorização é individual.
3. Banco SQLite de origem existente em `DATABASE_URL` (ou `.data/signalmess.sqlite`).

`OWNER_USER_ID` **não** é pré-requisito da migração. Ele é usado pela plataforma para tornar
o dono do app administrador do RecordRoom e, no scaffold, para escolher o JWT de cobrança de
integrações — não é uma condição para despachar uma ação. Na v0.2.2 a migração estava
indevidamente presa a ele (§2.6); desde a v0.2.3 não está.

#### Modelo de autorização

A migração é uma operação **multi-tenant**, e a autorização reflete isso:

| Quem | Pode migrar | Por quê |
| --- | --- | --- |
| Dono dos dados (qualquer conta) | **os próprios dados** | `selfScoped`: o `ownerId` declarado precisa ser igual ao sujeito verificado do JWT. |
| Dono dos dados | dados de outra conta | **não** — recusado com 403 antes de qualquer escrita. |
| Dono do app (`OWNER_USER_ID`) | dados de outra conta | **não**. Ser dono do app não é uma chave-mestra sobre dados de usuários. |
| Anônimo | nada | **não** — 401 antes do despacho. |

Três camadas independentes sustentam o isolamento:

1. **JWT verificado** — a identidade vem de `verifyJwt` com a chave e o emissor injetados
   pela plataforma. Nenhum header do cliente é consultado como prova.
2. **`selfScoped` no registro** — recusa antes de executar o handler quando o `ownerId`
   declarado não é o do chamador.
3. **`userBound` + `immutable` no schema** — o Durable Object carimba o id do chamador em
   toda escrita e recusa alteração de posse, mesmo que o handler tentasse.

Além disso, o handler relê cada linha antes de escrever e recusa tocar em registro cujo dono
seja outro. Uma execução por conta, com o token daquela conta, é o procedimento correto.

#### Parâmetros

| Parâmetro | Obrigatório | Efeito |
| --- | --- | --- |
| `--owner <userId>` | sim | Dono cujas linhas serão lidas e importadas. Precisa ser **igual** ao sujeito verificado do token. |
| `--token-stdin` | sim (ou `MIGRATION_TOKEN`) | Lê o token da entrada padrão, para não deixá-lo no histórico do shell nem na lista de processos. |
| `--target-url <url>` | sim (ou `MIGRATION_TARGET_URL`) | Base do app implantado. O CLI acrescenta `/api/actions/migrateRecords`. |
| `--dry-run` | não | Simula. **Nenhuma escrita** é enviada. |
| `--from <índice>` | não | Retoma a partir do índice indicado (ver "Recuperação"). |
| `--timeout-ms <n>` | não | Teto por chamada HTTP. Padrão 60000. |
| `--retries <n>` | não | Repetições para falhas de transporte. Padrão 2. |

#### Variáveis de ambiente

| Variável | Uso |
| --- | --- |
| `MIGRATION_TARGET_URL` | Alternativa a `--target-url`. |
| `MIGRATION_TOKEN` | Alternativa a `--token-stdin`. Preferir o stdin. |
| `DATABASE_URL` | Caminho do SQLite de origem. Só leitura. |

#### Endpoint utilizado

`POST <target>/api/actions/migrateRecords`, com `Authorization: Bearer <token>` e
`x-signalmess-request: 1`.

**O cabeçalho anti-CSRF não é autenticação.** Ele é um sinalizador de mesma origem que
qualquer página do app envia; a credencial é o token, que o servidor **verifica**
criptograficamente antes de qualquer despacho. Enviá-lo não concede identidade: um
requisição anônima com o cabeçalho continua recebendo 401 da rota de ação.

O servidor hoje **dispensa** esse cabeçalho para clientes bearer cujo token verificou e que
não carregam cookie de sessão (`server/lib/csrf-policy.ts`). O CLI o envia mesmo assim
porque é o caminho que funciona em qualquer topologia, inclusive atrás de um proxy que
remove o `Origin`.

#### Dry-run versus migração efetiva

| Aspecto | `--dry-run` | Migração efetiva |
| --- | --- | --- |
| Lê a origem | sim | sim |
| Chama a ação | sim | sim |
| Grava no destino | **não** | sim |
| `update` / `create` | nunca executados | por linha, conforme o caso |
| O que retorna | `created`/`updated`/`unchanged` **previstos** | o resultado real de cada linha |
| Contagem `created` | previsão | gravações confirmadas |

O dry-run classifica usando a mesma leitura que a migração real faria, então ele é um ensaio
fiel — mas "previsto" não é "gravado": a única prova de escrita é a execução real.

#### Limitações do runtime Node

No runtime Node (local, testes) a rota `/api/actions/migrateRecords` **existe e autentica**,
mas as ferramentas de dados não: `server/app.ts` injeta uma implementação que apenas lança
*"requer o runtime DeepSpace (RecordRoom)"*. Consequências:

- é possível testar CSRF, autenticação e autorização localmente;
- **não** é possível migrar dados localmente — a migração precisa do Worker implantado;
- o CLI falha de forma explícita nesse caso, sem gravar nada.

#### Recuperação após falha parcial

A migração envia lotes de até 100 linhas. Uma interrupção no lote *N* deixa os lotes
`0..N-1` aplicados. Como cada escrita é idempotente, **a recuperação é reenviar**:

1. O CLI imprime quantas linhas já foram processadas e o comando de retomada.
2. Reexecute com `--from <linhas já processadas>` para não reenviar o que já está feito.
3. Ou reexecute **sem** `--from`: o que já foi aplicado volta como `unchanged` e nada é
   reescrito. É mais lento, não é incorreto.

Nunca é necessário limpar o destino. A origem **não é alterada** em nenhum cenário: o
coletor abre o SQLite em modo somente leitura e nunca emite `INSERT`, `UPDATE` ou `DELETE`.

**Ordem de dependência.** As linhas são coletadas na ordem `investigations → evidence →
analyses → validations → activity_logs → usage_records`. Um lote interrompido no meio deixa
filhos órfãos até a retomada — visível como contagem incompleta, nunca como corrupção;
reexecutar completa as relações porque os ids são preservados.

---

## 6. Possíveis cobranças

| Vetor | Risco | Mitigação atual |
| --- | --- | --- |
| Proxy de integrações | **não usado** | arquitetura evita o proxy |
| IA gerenciada pela plataforma | **não usada** | chamadas diretas ao Gemini |
| Excedente de créditos | desconhecido | `RESEARCH_GLOBAL_DAILY_LIMIT=30`, `ANALYSIS_GLOBAL_DAILY_LIMIT=30` |
| Subrequests ao RecordRoom | desconhecido | paginação de 200 linhas por chamada |
| Armazenamento de Records | desconhecido | dados são texto; sem upload de arquivos |
| R2 | baixo | o app não usa upload |
| Domínio customizado | cobrado | não solicitado |
| Exa acima do free tier | **real** | chaves próprias + US$ 10/mês grátis + limites |
| Gemini acima do free tier | **real** | free tier + 3 análises/dia/usuário |

**Risco mais provável:** ultrapassar o crédito gratuito da **Exa**, não a plataforma. Com 8
resultados por pesquisa e contents habilitado, cada pesquisa consome search + páginas. Os
limites existentes são suficientes para uma demonstração; para uso aberto é preciso revisar.

---

## 7. Execução em workerd: por que não foi verificada

`npm run test:worker` verifica o **empacotamento** (17 checagens, todas passam) e tenta a
**execução ao vivo**. A execução ao vivo reporta `SKIPPED` neste ambiente.

**Evidência de que é limitação de ambiente, não do código:**

1. Um Worker **mínimo de controle** — `export default { async fetch() { return new
   Response('ok') } }`, sem dependências, sem Durable Object — falha com a mesma mensagem:
   `*** std::terminate() called with no exception` / "The Workers runtime failed to start".
2. Um caminho de falha independente foi reproduzido: o wrangler não consegue escrever em
   `.wrangler/tmp` fora do workspace ("Acesso negado").

**Consequência para o gate:** antes de publicar, `npm run test:worker` deve ser executado em
um ambiente que permita ao workerd criar subprocessos e escrever seus bundles temporários.
Até lá, o status honesto é: **empacotamento verificado, execução em runtime de produção não
verificada**.

---

## 8. Alternativas avaliadas

Se a plataforma não permitir demonstração gratuita:

| Alternativa | Gratuito | Compatível | Veredito |
| --- | --- | --- | --- |
| **Cloudflare Workers + D1** | sim (plano free) | **alto** — o Worker já é Hono; D1 é SQLite | **melhor alternativa**: um adaptador D1 sobre `ports.ts`, sem tocar em serviço |
| Supabase Free | sim, com pausa por inatividade | médio — novo adaptador, segundo provedor | viável |
| Manter local | sim | total | estado atual; demonstração por execução local |

A migração para D1 seria menor do que foi a migração para Records: o esquema SQL já existe
em `server/db.ts`, e o adaptador só precisaria de um cliente D1.

**Não migrar automaticamente.** A plataforma é requisito do exercício; a decisão é do
proprietário.

---

## 9. Checklist do gate

### Verificado (executado)

- [x] Worker empacota com `wrangler deploy --dry-run`
- [x] Durable Object e manifesto presentes no bundle
- [x] `verifyJwt` presente; nenhuma emissão de JWT
- [x] `@hono/node-server` ausente do bundle
- [x] Adaptador SQLite tree-shaken do bundle
- [x] Nenhum segredo embutido no bundle
- [x] Interruptores de custo lidos em runtime, default `false`
- [x] 416 testes automatizados passam no runtime Node
- [ ] 56 + 22 verificações em navegador real — **não executadas nesta versão** (o
      navegador não inicia neste ambiente; ver `docs/testing.md` §9)
- [ ] Auditoria de design — não executada nesta versão, pelo mesmo motivo
- [x] Migração idempotente e testada **contra o duplo de contrato**, não contra o DO real
- [x] Autorização de migração individual (`selfScoped`), sem depender de `OWNER_USER_ID`
- [x] Isolamento entre duas contas provado com identidades distintas (A e B)
- [x] Coletor da migração abre a origem em modo somente leitura
- [x] CLI envia o cabeçalho anti-CSRF e não o usa como identidade
- [x] `.gitignore` cobre `.env`, `.dev.vars`, `.wrangler*`, banco local

### Pendente de ação do proprietário

- [ ] Criar/conectar conta DeepSpace e executar `auth login`
- [ ] Confirmar `auth whoami`
- [ ] Ler quotas e condições de cobrança no dashboard
- [ ] Decidir e criar o repositório GitHub **antes** do primeiro `app init`
- [ ] Autorizar o registro do app (permanente)
- [ ] Autorizar (ou negar) `ENABLE_EXTERNAL_APIS=true`
- [ ] Definir `EXA_API_KEY` e `GEMINI_API_KEY` via `secrets set`
- [ ] Revisar limites diários para o público esperado
- [ ] Autorizar o deploy

### Pendente de execução

- [ ] `npm run test:worker` em ambiente que permita workerd
- [ ] Validar o RecordRoom real (RBAC, `uniqueOn`, paginação)
- [ ] Medir subrequests por requisição no app implantado
- [ ] `migrate:records --dry-run` e depois a migração real (procedimento em §5.5)

---

## 10. Estado final

| Afirmação | Verdadeiro? |
| --- | --- |
| A aplicação funciona localmente, ponta a ponta | **sim**, verificado |
| O runtime de produção é um Cloudflare Worker | **sim**, empacotado e verificado |
| O Worker executa em workerd | **não verificado neste ambiente** |
| O Worker usa DeepSpace Auth | **sim**, implementado e testado unitariamente |
| Os dados usam DeepSpace Records | **sim**, implementado e testado por paridade |
| O RecordRoom real foi exercitado | **não** — só o fake fiel ao contrato |
| Está publicado no DeepSpace | **não** |
| Fez chamadas reais a Exa/Gemini | **não** |
| Gerou qualquer cobrança | **não** |
| App registrado na plataforma | **não** |
| Pronto para deploy após autorização | **sim**, com as verificações de §9 |
