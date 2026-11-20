# Decisões técnicas

Registro das decisões que moldaram o projeto, com a alternativa descartada e o motivo.
Decisões não especificadas no briefing foram tomadas por conta própria e estão aqui para
serem contestáveis.

As decisões D1–D5 foram **revisadas na fase 2**, quando o runtime passou a ser o Cloudflare
Worker com DeepSpace. Onde a decisão mudou, o registro diz o que era antes, por que mudou e
o que a substituiu.

---

## D1. Dois runtimes, uma aplicação: Worker em produção, Node para testes

**Fase 1.** O núcleo era um app Hono servido por `@hono/node-server`, com um adaptador para
Workers apenas documentado. O motivo era concreto: sem sessão da CLI não era possível
registrar o app, e registrar é uma decisão permanente (trava a origem do código) que exige
autorização do proprietário.

**Fase 2.** O runtime de produção passou a ser o Worker de verdade:

- `worker.ts` exporta o handler e a classe `AppRecordRoom`;
- `wrangler.toml` declara o Durable Object e as assets;
- `server/app.ts` é plataforma-neutra e monta as mesmas rotas nos dois runtimes;
- `@hono/node-server` **não** está no bundle do Worker (verificado em `npm run test:worker`).

`server/dev.ts` continua existindo, explicitamente como runtime de desenvolvimento e teste,
porque:

1. o SQLite local é uma implementação de primeira classe e testável;
2. ele permite exercitar o app inteiro sem depender da plataforma;
3. ele é a referência de comportamento da suíte de paridade.

**O que não mudou.** Continua não havendo deploy nem registro do app: ambos exigem
autorização separada. `wrangler deploy` sem registro não funcionaria (o
`deepspaceBuild()` recusa o placeholder `__APP_ID__`), e é por isso que o build local não
carrega o plugin da plataforma.

**Consequência.** A frase "não mantenha `@hono/node-server` como runtime de produção" está
satisfeita: ele é uma dependência de desenvolvimento do runtime Node, ausente do artefato
que iria para a Cloudflare.

---

## D2. Persistência: dois adaptadores atrás das mesmas portas

**Decisão.** `server/repositories/ports.ts` declara as interfaces. Dois adaptadores as
implementam:

- `repositories/sqlite.ts` — runtime Node e referência de comportamento;
- `repositories/records/repositories.ts` — DeepSpace Records via o endpoint de tools do
  Durable Object.

Nenhum serviço importa um adaptador concreto; `services/index.ts` só conhece as portas.

**Alternativa descartada.** Ter dois backends completos (regras duplicadas). Descartada
porque a primeira divergência entre eles seria invisível até produzir dados errados.

**Como a equivalência é sustentada.** `tests/integration/adapter-parity.test.ts` executa 17
cenários contra os dois adaptadores e compara o resultado observável — incluindo um teste
que compara objetos profundamente iguais ao fim de um ciclo de vida completo. Um adaptador
que se comporte diferente quebra a suíte.

---

## D3. Isolamento em duas camadas: serviço **e** Durable Object

**Contexto.** A fase 1 tinha uma camada: `requireOwned` no serviço. Ela funciona, mas
depende de o código lembrar de chamá-la em cada novo caminho.

**Decisão.** Além de `requireOwned`, cada collection declara `ownerField: 'ownerId'` com
`read/update/delete: 'own'`. O Worker envia `X-User-Id` ao RecordRoom **sem**
`X-App-Action`, então o DO resolve o papel do chamador e aplica as `permissions` **antes** de
devolver ou gravar.

**O detalhe que importa.** `X-App-Action: true` desliga o RBAC por linha. Enviá-lo seria o
caminho fácil — e transformaria o armazenamento em um balcão aberto onde só o serviço
protege. O transporte de membro **não o envia**, e é isso que dá a segunda camada real.

**Custo aceito.** Toda operação passa por um subrequest ao DO, e um `count` de coleção
pagina até o fim. Para os volumes deste produto (centenas a milhares de linhas) isso é
aceitável; para milhões, o caminho seria um binding D1, não uma coleção.

---

## D4. Uma exceção ao RBAC, isolada em uma função

**Problema.** O teto **global** de consumo diário soma todas as contas. Uma leitura com
escopo de membro não vê linhas de outras contas, por desenho — e é bom que não veja.

**Alternativas descartadas.**

- Afrouxar `usage_records.permissions.member.read` para `true`: destruiria o isolamento para
  resolver um contador.
- Guardar o total global em um único registro compartilhado: cria contenção de escrita (todo
  mundo incrementa a mesma linha) e uma condição de corrida entre leitura e escrita.
- Desistir do teto global: deixaria o custo sem limite de plataforma, contrariando o
  requisito.

**Decisão.** `createGlobalUsageReader(env, ownerUserId)` usa o transporte administrativo para
**uma** pergunta e devolve **um número**:

```ts
totalSince(operation, since): Promise<number>
```

Nunca lista, nunca lê, nunca retorna linha. É o único consumidor do transporte
administrativo em todo o backend, e está isolada em `server/services/worker.ts` com o
comentário explicando por quê.

`tests/integration/records-security.test.ts` verifica as duas metades: a visão de membro vê
só o próprio consumo, e a visão administrativa soma a plataforma.

---

## D5. DeepSpace Auth: verificar, nunca emitir

**Decisão.** A identidade vem de um JWT assinado pela plataforma, verificado com
`verifyJwt` e as bindings `AUTH_JWT_PUBLIC_KEY`/`AUTH_JWT_ISSUER`. A aplicação não emite,
assina, renova nem armazena JWT.

**Por que isso é mais forte que a fase 1.** O adaptador local da fase 1 tinha uma chave de
sessão própria. Mesmo sendo hash-only, era um segredo que a aplicação precisava guardar. Com
JWT verificado por chave pública, **não existe segredo de assinatura** no código, no
repositório ou no bundle: não há o que vazar para forjar uma identidade.

**O adaptador local permanece, e é test-only.** Ele é necessário para os testes de
isolamento (dois usuários reais, sessões reais) e é recusado por
`assertProductionSafety` quando o runtime é o Worker ou quando `NODE_ENV=production`. Em
modo DeepSpace, `POST /api/auth/login` responde `404`: não há entrada alternativa.

**Testado em** `tests/integration/auth-deepspace.test.ts`, incluindo falha fechada quando as
bindings faltam e a garantia de que o modo DeepSpace nunca consulta a sessão local.

---

## D6. `deepspaceBuild()` só roda com um app id real

**Contexto.** `deepspaceBuild()` recusa construir com `DEEPSPACE_APP_ID = "__APP_ID__"`:

> The browser keys its RecordRooms to this id, so the build stops rather than ship a wrong
> or empty one. Run `npx deepspace app init` to register this app.

**Decisão.** `vite.config.ts` lê o id de `wrangler.toml`. Se for o placeholder, o build é
**local** (só a SPA). Se for um `app_<ULID>` válido, carrega o plugin Cloudflare e o
`deepspaceBuild()`. `SIGNALMESS_REQUIRE_PLATFORM=1` transforma ausência em erro para CI de
plataforma.

**Por que não rodar `app init` para destravar.** Porque registra o app **e trava a origem do
código permanentemente** — a documentação é explícita: o primeiro uso de fonte decide
GitHub ou DeepSpace para sempre, sem setter nem transferência. Fazer isso para "fazer o
build passar" seria exatamente a operação que o gate de implantação proíbe.

**Consequência.** O build funciona hoje (modo local), e o modo plataforma funciona assim que
o app for registrado com autorização. O que **não** acontece é um deploy acidental.

---

## D7. `PlatformProviders` só monta com app id injetado

**Decisão.** `DeepSpaceAuthProvider`/`RecordProvider`/`RecordScope` são montados apenas
quando `__DEEPSPACE_APP_ID__` foi injetado pelo build.

**Motivo.** No runtime Node esse define não existe. Montar os provedores abriria um WebSocket
para um RecordRoom que não existe, e a tela falharia de um jeito confuso. A condição é
avaliada uma vez, no build, não por variável de ambiente em runtime.

**Consequência.** As páginas nunca falam com o SDK diretamente: `useAuth` (contexto da
aplicação) expõe `status`/`user`/`mode`/`signOut`, e os dados vêm de `/api/*`. Um adaptador
novo não exige mudança de tela.

---

## D8. O Durable Object é testado por um fake fiel, não por um mock de repositório

**Decisão.** `FakeRecordRoom` reimplementa o contrato documentado do endpoint de tools sobre
SQLite: seleção de identidade por header, bypass por `X-App-Action`, avaliação de
`permissions` com `'own'`, `uniqueOn`, `required`, `maxLength`, interpretações, paginação e
`deleteWhere` limitado.

**Por que não mockar no repositório.** Um mock no repositório testaria o adaptador contra
uma suposição sobre o DO. O fake testa o adaptador contra as **regras documentadas**, então
uma suposição errada sobre RBAC ou unicidade aparece como teste falhando.

**Limite reconhecido.** O fake não é o binário do SDK. A verificação contra o DO real exige o
runtime de plataforma; está registrada como pendência em
[docs/testing.md](testing.md#9-limites-desta-suíte).

---

## D9. Verificação do Worker em duas camadas, com `SKIPPED` honesto

**Decisão.** `npm run test:worker` sempre verifica o **empacotamento** (com o `wrangler`
real) e tenta a **execução ao vivo**; se o `workerd` não iniciar, reporta `SKIPPED` com a
causa observada em vez de fingir que passou.

**O que foi descoberto.** O `workerd` não inicia neste ambiente. A prova não é uma
suposição: um Worker **mínimo de controle** (`fetch: () => new Response('ok')`) falha
identicamente com `std::terminate` / "The Workers runtime failed to start". Também foi
possível reproduzir a causa em outro caminho — o wrangler não consegue escrever em
`.wrangler/tmp` fora do workspace ("Acesso negado"). É limitação de ambiente, não do código.

**Por que não esconder isso.** Declarar "testado em runtime de produção" sem ter executado
seria a mentira mais fácil deste relatório. O artefato
`tests/worker/artifacts/worker-verification.txt` registra `liveWorkerd: skipped` e o motivo.

**O que o empacotamento prova.** Que o Worker compila para a Cloudflare com o DO declarado,
que o adaptador SQLite é tree-shaken, que nenhum runtime Node vaza, que nenhum segredo é
embutido e que a configuração é lida em runtime. É a maior parte do risco, e é verificável
sem a plataforma.

---

## D10. Migração idempotente, com a origem intacta

**Decisão.** `npm run migrate:records` lê pela interface de repositório, grava com o id
original, é idempotente (segunda execução não duplica), tem `--dry-run` e **nunca apaga a
origem**.

**Por que idempotente.** Uma migração que só funciona uma vez é uma migração que você não
pode reexecutar depois de corrigir um problema no meio. Preservar o id torna o
`records.create` um upsert, e a comparação de conteúdo distingue "já estava igual" de
"atualizado".

**Por que escreve como operador.** As linhas pertencem a vários donos. Um transporte de
membro não pode gravá-las (e não deve). Por isso a migração é um CLI com credencial de
operador, nunca um endpoint do app — e por isso ela se recusa a rodar sem
`MIGRATION_TARGET_URL`.

**Testado em** `tests/integration/migration.test.ts` (7 casos).

---

## D11. CSRF aceita a origem da própria requisição

**Decisão.** Além de `APP_ORIGIN`/`ALLOWED_ORIGINS`, o guard aceita a origem da própria
requisição.

**Por que não é um afrouxamento.** O navegador não consegue reportar a origem do atacante e a
do app ao mesmo tempo, e o header marcador (`x-signalmess-request`) não pode ser definido
cross-origin sem um preflight que o app nunca concede. Aceitar a origem da requisição
resolve proxy reverso que reescreve host, que é o caso do runtime de plataforma.

**Efeito colateral bom.** Os testes de integração deixaram de precisar de reconstruir o app
para saber a porta — o que simplificou o harness e removeu uma classe de flakiness.

---

## D12. Testes: `node:test` + CDP

Mantido da fase 1. O sandbox bloqueia scripts de pós-instalação e processos com stdio por
pipe; `vitest` e `playwright` não instalam. `node:test` roda TypeScript nativamente e o
Chrome é controlado por CDP.

**Consequência.** Os testes exercitam o app real, sem bundler e sem mock de framework. O
custo é um driver menor que o do Playwright.

---

## D13. Auditoria de design por medição

**Decisão.** Medir no DOM real: contraste WCAG (com composição de transparência), overflow,
texto cortado, alvos de toque, hierarquia, espaçamento.

**Por que.** O agente não tem capacidade de visão neste ambiente; screenshots não podem ser
inspecionados. A auditoria encontrou problemas reais que uma revisão desatenta perderia —
contraste de 2.59:1 e botões de 28px.

**Limite reconhecido.** Medição não é gosto. Uma interface pode passar em todos os critérios
e ainda ser sem graça; as decisões estéticas foram tomadas deliberadamente e estão nos tokens.

---

## D14. Schema de update separado do schema de criação

**Problema descoberto por teste (fase 1, mantido).** `zod.partial()` sobre um schema com
`.default()` injeta os defaults em campos ausentes. Um PATCH só com `title` apagava
`description`, `keywords` e `status`.

**Decisão.** Definir os campos uma vez **sem** defaults; derivar criação (com defaults) e
atualização (`.partial()` sobre a base sem defaults).

**Consequência.** Bug corrigido, com teste de regressão explícito. É o exemplo mais claro de
por que a suíte existe: o bug não produzia erro, apenas perda de dados.

---

## D15. Sem retry automático em provedores

**Decisão.** Nenhum cliente repete uma chamada. O usuário repete conscientemente.

**Motivo.** Cada requisição a Exa e Gemini pode ser cobrada. Um laço de retry é uma cobrança
que o usuário não autorizou.

**Consequência.** 429/500 aparecem como erro claro com ação sugerida. Os testes verificam que
apenas **uma** requisição chega ao mock.

---

## D16. Dois interruptores de custo independentes

`ENABLE_EXTERNAL_APIS` (interruptor geral) e `ENABLE_PAID_OPERATIONS` (autorização de
cobrança), ambos `false` por padrão. "Consegui configurar a chave" não é o mesmo que "autorizo
gastar".

**No Worker**, os dois estão em `[vars]` do `wrangler.toml` com valor `"false"`, e o bundle
lê em runtime — verificado pelo teste de empacotamento. Mudar exige editar a configuração e
republicar, não alterar um arquivo local.

---

## D17. Demo data atrás de flag explícita

`SEED_DEMO_DATA=false` por padrão. Quando ativado, cria uma investigação com título
`[DEMONSTRAÇÃO]`, fontes fictícias em `example.org`, `source: 'demo'`, nota explicativa e
metadados marcados.

---

## D18. O que **não** foi feito, deliberadamente

| Ausência | Motivo |
| --- | --- |
| `npx deepspace app init` | Registra o app e trava a origem do código permanentemente |
| `deepspace deploy` / `push` | Gate de implantação exige autorização do proprietário |
| Chamadas reais a Exa/Gemini | Regra de custo zero; nenhuma autorização financeira |
| IA gerenciada pela plataforma | Proibida explicitamente |
| Proxy pago de integrações | Proibido explicitamente |
| JWT próprio em produção | A identidade é da plataforma |
| Servidor OAuth próprio | Idem |
| Scraping de páginas | A Exa fornece conteúdo |
| Compartilhamento entre usuários | Não especificado; sem modelo de permissão seria risco |
| i18n | Interface em pt-BR por escopo |
