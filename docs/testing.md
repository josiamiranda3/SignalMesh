# Testes

Estratégia, o que cada suíte garante e os resultados reais obtidos neste ambiente.

---

## 1. Como executar

```bash
npm run typecheck       # tsc cliente + servidor
npm run lint            # eslint (zero avisos)
npm run test            # 479 testes (unit + integração + contrato do Worker)
npm run test:unit       # 74 testes
npm run test:integration # 374 testes
npm run test:contract   # 31 testes de estrutura do Worker
npm run check:encoding  # auditoria de UTF-8
npm run test:e2e        # 56 verificações em navegador real
npm run test:flows      # 22 verificações de fluxos complementares
npm run audit:design    # auditoria de design em 3 viewports
npm run test:worker     # empacotamento do Worker (+ execução ao vivo quando possível)
npm run verify          # typecheck + lint + build + test
npm run verify:all      # verify + e2e + flows + audit + worker
```

Os testes de navegador exigem Chrome ou Edge. Defina `CHROME_PATH` se necessário.

---

## 2. Por que `node:test` e CDP

O sandbox de execução bloqueia scripts de pós-instalação e processos que capturem stdio por
pipe. Isso impediu `vitest` (binário com postinstall) e `playwright` (download de
navegadores).

`node:test` roda TypeScript nativamente via `--experimental-transform-types`; o navegador é
o Chrome/Edge já instalado, controlado por Chrome DevTools Protocol. Os testes exercitam o
app real (Hono + middleware + serviços + persistência + React), não mocks de framework.

---

## 3. Testes unitários — 74

| Arquivo | Testes | Cobre |
| --- | --- | --- |
| `relevance.test.ts` | 12 | índice em [0,1]; justificativa por componente; ausência de data; data futura; domínio institucional vs UGC; marca famosa sem conteúdo não pontua alto; pesos; renormalização; determinismo |
| `analysis-contract.test.ts` | 20 | referência inexistente rejeitada; `citedEvidenceIds` inválido; finding sem fonte; payload incompleto; enum de confiança; texto livre; coleta de citações; `insufficientEvidence`; schema do Gemini; prompt sem credenciais |
| `sanitize.test.ts` | 16 | normalização de URL; rejeição de `javascript:`/`data:`/`file:`; `stripHtml`; domínio; excerpt; janela de meia-noite |
| `schemas.test.ts` | 22 | PATCH parcial sem injeção de default; limites; defaults de criação; URL perigosa; paginação; status inválido |
| `encoding-guard.test.ts` | 4 | o guard de UTF-8 detecta corrupção por Latin-1 e Windows-1252 (inclui o travessão que escapava antes) |

---

## 4. Testes de integração — 335

### 4.1 `auth-isolation.test.ts` — 19

Autenticação, CSRF/origem, isolamento entre dois usuários via HTTP, integridade da validação
(justificativa obrigatória, histórico com `previousStatus`, status repetido recusado).

### 4.2 `providers-and-quota.test.ts` — 28

Exa (consulta montada, proveniência, vazio, 401/429/500/JSON inválido/timeout, duplicata),
evidências (persistência, deduplicação, skip com motivo, URL perigosa), Gemini (análise
válida, **referência fabricada rejeitada e registrada como failed**, schema inválido, recusa
sem evidências, 403/429/503, truncamento) e proteção de custo (cotas, snapshot, bloqueio
global, chave ausente, registro de bloqueios).

### 4.3 `crud-export.test.ts` — 17

CRUD completo, cascata, dashboard derivado de dados, histórico persistido, export JSON com
relações íntegras, CSV parseável, nome de arquivo, `no-store`, ausência de credenciais.

### 4.4 `adapter-parity.test.ts` — 36 (novo na fase 2)

Executa os mesmos cenários contra **SQLite** e **DeepSpace Records**, comparando o resultado
observável:

- criação e leitura com campos idênticos;
- atualização parcial sem perturbar o resto;
- listagem com busca, filtro de status e ordenação;
- contagem por status;
- evidência com breakdown de relevância intacto;
- duplicata por URL normalizada;
- rejeição de segunda evidência com a mesma URL (no armazenamento);
- atualização de nota e status;
- ordenação de evidências;
- contagem por status de validação;
- histórico de validação append-only;
- trilha de atividade ordenada, incluindo entrada com `investigationId: null`;
- soma de consumo apenas de sucessos na janela;
- consultas de pesquisa por hash;
- preferências por dono;
- ocultação de linhas de outro dono;
- **igualdade ponta a ponta**: o mesmo ciclo de vida produz objetos profundamente iguais nos
  dois adaptadores;
- **igualdade de cascata**.

Esta é a suíte que sustenta a afirmação "trocar o banco não muda o comportamento".

### 4.5 `records-security.test.ts` — 26 (novo na fase 2)

Testa o **armazenamento** diretamente, sem passar pelos serviços:

- toda collection de domínio declara `ownerField`;
- nenhuma concede `read/update/delete: true` a membro;
- `activity_logs` e `usage_records` são append-only;
- leitura, leitura por id, atualização e exclusão de outro usuário são recusadas pelo DO;
- escrita anônima recusada;
- consulta de evidências com escopo de chamador;
- consumo de um usuário não conta para outro;
- campo obrigatório ausente recusado;
- `maxLength` recusado;
- `uniqueOn` de evidência e de settings;
- mesma URL permitida em investigação diferente;
- JSON e booleano round-trip;
- paginação com `nextOffset`;
- `where` com campo desconhecido recusado;
- `deleteWhere` sem filtro recusado;
- `deleteWhere` só remove o que o chamador pode excluir;
- visão de membro vs visão administrativa do consumo.

### 4.6 `auth-deepspace.test.ts` — 21 (novo na fase 2)

Prova a fronteira de autenticação:

- modo derivado do runtime (Node → local; Worker → deepspace; `DEEPSPACE_APP_ID` presente →
  deepspace);
- Worker com adaptador local não sobe;
- `NODE_ENV=production` com adaptador local não sobe;
- token Bearer verificado com a chave e o emissor corretos;
- cookie de plataforma quando não há Bearer;
- Bearer tem precedência sobre cookie;
- falha de verificação → não autenticado;
- sem token → não chama o verificador;
- **bindings ausentes → falha fechada**;
- modo DeepSpace nunca consulta a sessão local;
- linha de usuário derivada das claims quando não existe;
- nome derivado do e-mail quando a claim não traz nome;
- modo local resolve e rejeita sessão;
- modo local ignora Bearer.

### 4.7 `migration-action.test.ts` — 14 (migração por server action)

Cópia completa com ids e relações preservados, normalização de URL, idempotência, dry-run sem
gravação, origem intacta, filtro por dono, relatório legível, recusa de `ownerId` divergente,
guarda de upsert contra linha de outra conta.

> O nome mudou de `migration.test.ts` para `migration-action.test.ts` quando a migração
> passou a usar a server action em vez de um endpoint próprio; a referência antiga ficou
> para trás e foi corrigida na v0.2.2.

### 4.8 `migration-idempotency.test.ts` — 23 (novo na v0.2.2)

Regras de igualdade da migração, por interpretação de coluna: colunas geradas pelo
armazenamento, coluna opcional ausente no payload, JSON comparado por valor (ordem de chave
irrelevante, ordem de array relevante), booleano `0/1`/`"true"` e número `"3"`/`3`, chave
desconhecida presente nos dois lados, e a segunda execução completa sem nenhum `updated`.

### 4.9 `migration-source-readonly.test.ts` — 10 (novo na v0.2.2)

Origem em disco real: abrir não cria `-wal`/`-shm`, o handle recusa `CREATE TABLE` e
`UPDATE`, o arquivo permanece byte-idêntico após a coleta, arquivo ausente e `:memory:` são
recusados, e um WAL com conteúdo pendente cai no modo `readOnly`.

### 4.10 `cli-csrf-flow.test.ts` — 18 (novo na v0.2.2)

O caminho HTTP do CLI de ponta a ponta: com o cabeçalho anti-CSRF a requisição **não** é
recusada por CSRF e chega à rota de ação (401 por falta de identidade local, não 403); sem o
cabeçalho, uma requisição com cookie recebe 403; `Origin` cruzada continua recusada com o
cabeçalho presente; a isenção vale para bearer **verificado** e nunca para bearer forjado,
nem quando há cookie de sessão, nem em `/api/auth/*`.

### 4.11 `migration-cli-transport.test.ts` — 8 (novo na v0.2.2)

Contra um servidor que se comporta mal de propósito: cabeçalhos enviados pelo CLI, timeout
encerrando a chamada, 500 e recusa de conexão classificados como repetíveis, 403 como final,
resposta HTML tratada como inválida, e resposta lenta porém saudável não abortada.

### 4.12 `migration-multitenant.test.ts` — 14 (novo na v0.2.3)

Dois donos de dados (A e B) e um dono do app distinto de ambos. Prova a propriedade que o
gate da v0.2.2 quebrava: cada dono migra os próprios dados e só os próprios, **sem ser o dono
do app**. Cobre: A migra A; B migra B na mesma sala sem tocar em A; A→B e B→A recusados com
`forbidden`; o dono do app também não migra dados de terceiros; linha com `ownerId` forjado
no payload é pulada; linha existente de outro dono não é sobrescrita; `userBound` carimba o
chamador mesmo com payload forjado; `immutable` recusa alteração de posse; idempotência e
dry-run preservados.

### 4.13 `action-security.test.ts` — 22 (reescrito na v0.2.3)

O modelo multi-tenant no nível da rota HTTP: identidade verificada antes do despacho,
headers do cliente ignorados, `ownerOnly` ainda estrito para operações globais, e
`selfScoped` recusando escopo alheio com `code: 'forbidden'` (que a rota mapeia para 403).

### 4.14 `auth-authorized-parties.test.ts` — 18 (novo na v0.2.4)

O único conjunto desta suíte que assina **JWTs reais** (par ES256 gerado em teste, `jose`) e
chama o **`verifyJwt` do SDK**, sem mock do verificador. Cobre `authorizedParties`/`azp`:
autorizado, não autorizado, curinga, origem parecida, ausente (aceito — contrato do SDK),
assinatura inválida, expirado, emissor divergente, malformado, `sub` ausente e ausência de
material de verificação.

### 4.15 `encoding-guard.test.ts` — 4 (novo na v0.2.4)

Vive em `tests/unit/` (é o que `npm run test:unit` executa) e está descrito também na §3.
Executa o `scripts/check-encoding.ts` real contra fixtures e verifica que ele detecta
corrupção por decodificação em página de código única (Latin-1 **e** Windows-1252), inclusive
o travessão que escapava antes.

A captura da saída do filho usa **file descriptors**, não pipes: este sandbox nega ao
processo filho escrever em um pipe do pai, e `stdio: 'pipe'` devolve string vazia sem erro.
É a mesma restrição que faz `wrangler` falhar com `spawn EPERM`.

### 4.16 `ownership-hardening.test.ts` — 18

Toda coluna de posse é `userBound` + `immutable`, e nenhuma outra coluna é `userBound`;
tentativa de criar linha em nome de outro é recusada; `ownerId` não pode ser alterado por
`update`; o fake reproduz a semântica do Durable Object.

### 4.17 `records-protocol.test.ts` — 28

Contrato do transporte de Records: nomes de tool, formato do envelope, erros de `immutable`
e de `uniqueOn`, paginação e mapeamento de falhas.

### 4.18 `route-security.test.ts` — 15

Auditoria de rota: toda rota privada recusa anônimo, nenhuma resposta vaza segredo, os
interruptores de custo são obedecidos, o endpoint fantasma do CLI antigo continua ausente e
a rota de ação exige identidade.

### Mapa de fidelidade dos testes

Nem todo teste desta suíte exercita o sistema como ele roda em produção. A distinção:

| Camada | Fidelidade | Exemplos |
| --- | --- | --- |
| **Real** | HTTP em socket real, Hono, middleware, serviços e SQLite | `auth-isolation`, `crud-export`, `route-security`, `cli-csrf-flow`, `migration-source-readonly` |
| **Real (cripto)** | JWT assinado de verdade + `verifyJwt` do SDK | `auth-authorized-parties` |
| **Real (processo)** | Executa o script real e lê a saída | `encoding-guard` |
| **Real (transporte)** | Servidor HTTP real que falha de propósito | `migration-cli-transport` |
| **Fake** | `FakeRecordRoom` no lugar do Durable Object | `migration-multitenant`, `migration-idempotency`, `records-protocol`, `adapter-parity` |
| **Mock** | `verifyJwt` substituído por função de teste | `auth-deepspace` (só os casos de resolução) |
| **Estático** | Asserção sobre o texto do fonte | `worker-contract` |

O `FakeRecordRoom` reproduz o contrato documentado (RBAC, `userBound`, `immutable`,
`uniqueOn`, interpretações, paginação), mas **não é o binário do SDK**. Nenhum teste desta
suíte executa no workerd.

### 4.19 O que o sandbox bloqueia — e como executar assim mesmo

As suítes de navegador e o empacotamento do Worker falharam por muito tempo com sintomas que
pareciam defeitos do projeto. Não eram. O diagnóstico completo está em
[docs/validation-v0.2.4.1.md](validation-v0.2.4.1.md); em resumo:

| Sintoma | Causa real |
| --- | --- |
| Chrome sai com `0xFFFF7001` | `mojo platform_channel` e `crashpad OpenProcess`: o sandbox nega **named pipes** e `OpenProcess`. Vale também para o Edge. |
| `wrangler` falha com `spawn EPERM` | O wrapper do wrangler usa `stdio: ['inherit','inherit','inherit','ipc']`; o esbuild mantém um *service* por `spawn` com pipes. Ambos são negados. |
| `workerd` não inicia | `std::terminate()` interno do próprio binário, **mesmo com acesso total**. Não é permissão. |

**Como executar.** Os três primeiros bloqueios são de confinamento, não de código: com o
comando executado fora da confinação, as suítes passam. Verificado nesta versão:

```
run-e2e.ts       56/56   exit 0
run-flows.ts     22/22   exit 0
design-audit.ts  0 problemas, exit 0
worker smoke     17/17 empacotamento, exit 0 (workerd ao vivo ainda SKIP)
```

Nenhuma linha de código foi alterada para obter esses resultados. Um teste que só passa quando
o ambiente é relaxado continua sendo um teste válido — desde que a dependência seja declarada,
que é o que esta seção faz.

### 4.20 `evidence-manual.test.ts` — 23 (novo na v0.2.4.2)

Cadastro manual de evidências sobre HTTP real e SQLite real: entrada válida e campos
opcionais, campos obrigatórios ausentes ou vazios, URLs perigosas (`javascript:`, `data:`,
relativa, `ftp:`), **procedência** (`manual` nunca `exa`; `exa` preservado no caminho bulk;
ambos distinguíveis no mesmo registro), persistência relida do banco, isolamento entre dois
usuários e contra anônimo, duplicatas incluindo variantes com `utm_*`, e a procedência
sobrevivendo às exportações JSON e CSV.

O diálogo em si não é coberto aqui: foi verificado manualmente pelo driver CDP
([docs/changes-v0.2.4.2.md](changes-v0.2.4.2.md) §5).

---

## 5. Testes de ponta a ponta — 78 verificações

Executados em navegador real, com provedores mockados.

| Suíte | Verificações | Cobre |
| --- | --- | --- |
| `run-e2e.ts` | 56 | landing → login → investigação → pesquisa → evidência → análise → validação → histórico → exportação → configurações → isolamento → logout |
| `run-flows.ts` | 22 | demo rotulada, edição, arquivamento, notas, filtros, busca, fila global, exclusão com confirmação, 404 |

---

## 6. Verificação do Worker — 17 (novo na fase 2)

`tests/worker/run-worker-smoke.ts` tem duas camadas.

### 6.1 Empacotamento (sempre executa)

Roda `wrangler deploy --dry-run` — o empacotador real da Cloudflare — e inspeciona o
artefato:

- `AppRecordRoom` e `__DO_MANIFEST__` presentes;
- `verifyJwt` e `createWorkerServices` presentes;
- protocolo de Records presente;
- **`@hono/node-server` ausente**;
- **`node:http` ausente**;
- **adaptador SQLite, sua fábrica, o esquema e os pragmas ausentes** (tree-shaken);
- **nenhum import estático de `node:sqlite`** (a única referência é um `await import()`
  dentro de `try/catch` no próprio SDK, marcado `@vite-ignore`, que nunca executa);
- nenhum valor de chave embutido;
- interruptor de custo lido em runtime, não fixado no bundle.

### 6.2 Execução ao vivo (quando o runtime inicia)

Sobe o Worker em `wrangler dev` e exercita `/api/health` (runtime=worker, storage=records,
authMode=deepspace), 401 nas rotas privadas, ausência de login local, SPA pelo binding de
assets, 404 em asset ausente e JSON em rota de API desconhecida.

**Neste ambiente esta camada reporta `SKIPPED`.** O binário `workerd` não inicia: um Worker
**mínimo de controle** (`export default { fetch: () => new Response('ok') }`) falha com a
mesma mensagem (`std::terminate` / "The Workers runtime failed to start"), o que isola a
causa como limitação do ambiente (o sandbox bloqueia subprocessos e escrita de bundles
temporários) e não como defeito do código. O resultado é registrado em
`tests/worker/artifacts/worker-verification.txt` e deve ser reexecutado em um ambiente que
permita ao workerd iniciar.

---

## 7. Auditoria de design

13 rotas × 3 viewports, medindo no DOM real: contraste WCAG AA com composição de
transparência, ordem de títulos, distribuição tipográfica, overflow horizontal, texto
cortado, alvos de toque, gutters e paddings.

Resultado atual: **nenhum problema**.

---

## 8. Resultados reais

Executados neste ambiente (Windows, Node 24.22.0).

### v0.2.4.1 — o que rodou

```
unit (74) + integração (374) + contrato (31) ✅ 479/479
```

A v0.2.4.1 é manutenção: lockfile e documentação. Nenhuma alteração em código de aplicação,
autenticação ou testes.

As linhas abaixo foram **executadas na validação operacional da v0.2.4.1**, com o comando
rodado fora da confinação do sandbox (§4.19). Todas passaram:

```
e2e fluxo principal      ✅ 56/56
e2e fluxos               ✅ 22/22
auditoria de design      ✅ 0 problemas (13 rotas × 3 viewports)
worker (empacotamento)   ✅ 17/17
worker (workerd ao vivo) ⏭ SKIPPED — o binário crasha com std::terminate neste ambiente
```

Uma sonda isolada (`chrome --headless=new` com perfil temporário) sai imediatamente com
`0xFFFF7001` sob confinamento; sem ele, o navegador sobe normalmente. É limitação do ambiente,
não do app.

### v0.2.1 (histórico)

```
unit + integração + contrato ✅ 306/306
e2e fluxo principal      ✅ 56/56
e2e fluxos               ✅ 22/22
auditoria de design      ✅ 0 problemas
check:encoding           ✅ 120 arquivos, nenhum problema
```

A auditoria da v0.2.1 acrescentou 82 testes e corrigiu quatro defeitos reais — ver
[docs/audit-v0.2.1.md](audit-v0.2.1.md).

A v0.2.2 acrescentou 87 testes (393 − 306), a v0.2.3 mais 23 (416 − 393), a v0.2.4 mais
24 (440 − 416), a v0.2.4.2 mais 23 (463 − 440), a v0.2.4.3 mais 3 (466 − 463) e o
fechamento mais 13 (479 − 466), todos executáveis sem navegador. A v0.2.4.1 não alterou a
contagem: foi manutenção de lockfile e documentação.

### 4.21 `quota-reservation.test.ts` — 9 (fechamento)

Reservas exclusivas no adaptador SQLite: primeiro vence, segundo é recusado; usuários e
operações distintos não competem; **corrida de 10 tentativas simultâneas com exatamente um
vencedor**; liberação só pelo detentor do token; reserva expirada é retomada; expiradas são
purgadas.

### 4.22 `quota-concurrency.test.ts` — 4 (fechamento)

A mesma garantia sobre HTTP real, contra o adaptador SQLite: duas análises simultâneas
produzem `[201, 429]` e **exatamente uma chamada ao Gemini**; a recusa não deixa reserva presa
(a próxima requisição passa); pesquisa e análise do mesmo usuário não se bloqueiam; usuários
distintos não competem.

---

## 9. Limites desta suíte

1. **Nenhuma chamada real a provedor.** Por decisão de custo, a integração é exercitada
   contra um mock fiel ao formato documentado.
2. **Nenhuma chamada real à plataforma DeepSpace.** O app não está registrado; nenhuma
   operação de deploy, push ou billing foi executada.
3. **O Durable Object é simulado.** `FakeRecordRoom` reproduz o contrato documentado —
   RBAC, `uniqueOn`, required, `maxLength`, interpretações e paginação — mas não é o binário
   do SDK. A verificação contra o DO real exige o runtime de plataforma.
4. **workerd não executou aqui** (ver §6.2).
5. **Rate limiting por minuto** não é testado em carga.
6. **Sem teste de acessibilidade com leitor de tela**; contraste, alvos, foco, ARIA e ordem
   de títulos são verificados.
7. **Sem diff visual por pixel**; a auditoria mede propriedades calculadas.

### Limites específicos da migração (v0.2.2)

8. **A idempotência foi provada contra o duplo de contrato, não contra o DO real.** As regras
   de igualdade (`migration-idempotency.test.ts`) são exercitadas com o `FakeRecordRoom`.
   Elas assumem que o armazenamento devolve um `json` como estrutura (ou como texto
   parseável), um `boolean` como `0`/`1`/`true` e um `number` como número ou string
   numérica. **Se o DO real devolver outra forma, o resultado será `updated` desnecessário,
   não corrupção** — mas isso não está verificado até o runtime de plataforma rodar. Um
   dry-run em ambiente real é o teste que falta.
9. **A isenção de CSRF para bearer não foi exercitada com JWT real.** O runtime Node não
   verifica JWT, então os testes locais cobrem a *política* (a mesma função que o guard
   chama) e o *caminho com cookie*; a verificação de um token Deepspace de verdade só ocorre
   no Worker.
10. **O CLI não é executado de ponta a ponta.** `scripts/migrate-to-records.ts` roda
    `main()` no import, então importá-lo dispararia uma migração. O contrato do transporte é
    verificado contra um servidor real (`migration-cli-transport.test.ts`) e a forma do
    código é verificada estaticamente, mas o processo completo — incluindo `readStdin` e o
    laço de lotes — depende de execução manual.

### Limites da autorização multi-tenant (v0.2.3)

11. **A autorização foi provada na lógica, não com dois JWTs reais.** `selfScoped` recebe o
    `userId` já verificado; os testes injetam esse valor, porque este ambiente não tem chave
    pública da plataforma nem token de usuário. A verificação criptográfica em si
    (`verifyJwt`) é a mesma já usada por todas as rotas e não foi alterada, mas **a
    combinação "JWT de A verificado → `userId` de A → escopo de A" não foi exercitada de
    ponta a ponta contra a plataforma.**
12. **O `X-App-Action` desliga o RBAC por linha no DO real.** Os testes confirmam que o
    handler recusa linha de terceiro, mas isso é verificado contra o `FakeRecordRoom`. Se o
    DO real se comportar de forma diferente em algum caso de borda (por exemplo, `get` de
    um id inexistente versus de outro dono), o efeito seria conhecido apenas em runtime
    real. O teste que falta é um dry-run com um app implantado e duas contas reais.
13. **A premissa documental vem dos tipos instalados, não de comportamento observado.** A
    conclusão de que a plataforma não exige `OWNER_USER_ID` para despachar ações foi
    derivada de `deepspace@0.44.2` (`server.d.ts`: *"the app's server-side code IS the trust
    boundary"*; `worker.d.ts`: `ActionContext`/`ActionTools`) e do scaffold oficial
    `create-deepspace`. Nenhuma dessas leituras foi confirmada contra um app em execução.

### Instabilidade de teardown HTTP (corrigida na v0.2.3)

A suíte completa falhava de forma intermitente (3 em 6 execuções) em
`auth-isolation.test.ts › rejects unauthenticated access to protected routes`, com
`ECONNRESET` numa requisição que não tinha relação com o teste.

**Causa.** Não era o teste nem a aplicação. Dois servidores de teste deixavam conexões
keep-alive abertas no teardown:

- `harness.ts` tem um modo de mock que **nunca responde** (`exaMode: 'timeout'`) — o socket
  fica aberto por desenho. `server.close()` espera as conexões abertas terminarem.
- `serveApp` fechava com `server.close()` apenas, deixando sockets keep-alive pendentes.

Como o runner compartilha um processo entre suítes (`--test-isolation=none`), o listener
meio-fechado de uma suíte era herdado pela seguinte e aparecia como reset longe da origem.

**Correção.** Ambos passaram a destruir as conexões no teardown (`closeAllConnections`).
Verificação: **8 execuções completas consecutivas, 416/416 em todas** (antes: 3 falhas em 6).

### Resíduo de connection pooling (corrigido na v0.2.4)

Destruir os sockets no teardown não bastou: em ~14 execuções completas na v0.2.3/v0.2.4,
uma ainda falhou com `ECONNRESET` em outro teste (`cli-csrf-flow`). O motivo restante não era
o servidor, e sim o **cliente**: o `fetch` global do Node mantém um pool de conexões por
origem. Um socket pertencente a um servidor já derrubado podia ser reaproveitado por uma
requisição posterior — de outra suíte, na mesma porta efêmera.

**Correção.** O listener de teste passou a responder com `Connection: close`
(`serveApp` em `server/bootstrap.ts`), de modo que nenhum socket é guardado no pool. A
mudança é no servidor de teste, não no código de produção, e não exige dependência nova
(`undici` é apenas transitiva aqui, via `wrangler`).

Verificação: **5 execuções completas consecutivas, 440/440 em todas**.

A lição vale registrar: uma falha "intermitente" tinha **duas** causas independentes. Corrigir
a primeira reduziu a frequência, o que quase a fez passar por resolvida.
