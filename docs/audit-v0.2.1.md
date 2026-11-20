# Auditoria de segurança e compatibilidade — v0.2.1

Auditoria técnica executada **antes** de qualquer registro, publicação ou operação na
plataforma. Nenhum `app init`, `deploy`, `push` ou `secrets set` foi executado; nenhuma
chamada paga; nenhuma integração via proxy.

O objetivo era verificar a versão 0.2 contra os contratos reais do SDK instalado
(`deepspace@0.44.2`) e corrigir o que estivesse errado. Quatro defeitos reais foram
encontrados, três deles capazes de quebrar a aplicação ou violar isolamento em produção.

---

## 1. Problemas encontrados

### P1 — CRÍTICO: `ownerId` sem `userBound` permitia falsificação de posse

**Severidade:** crítica — violação de isolamento entre usuários.

**Evidência.** O próprio lint do SDK, executado contra `src/schemas.ts`:

```
[investigations] ownerField is 'ownerId' but that column is not marked userBound: true.
Client role(s) member can create a row with someone else's id in this field, bypassing
'own' permission checks.
```

Oito collections, oito avisos.

**Causa.** O Durable Object avalia `permissions.member.read: 'own'` comparando
`record.data[ownerField] === userId`. Se o cliente pode escolher o valor de `ownerId` no
`create`, ele pode gravar `ownerId: <vítima>` — e a linha passa a satisfazer `'own'` para a
vítima, não para o autor. Na prática: criação de registros em nome de outra conta,
inclusive `usage_records` (burlar cota) e `activity_logs` (forjar auditoria).

**Agravação.** O modo de falha era silencioso: a linha era criada com sucesso.

### P2 — CRÍTICO: a rota WebSocket do RecordRoom não existia

**Severidade:** crítica — o cliente realtime não funcionaria em produção.

**Evidência.** O SDK abre `GET /ws/<roomId>?token=<jwt>`:

```js
const url = `${baseUrl}${pathPrefix}/${config.roomId}?${params.toString()}`
```

`worker.ts` só tratava `/api/*`. Um upgrade para `/ws/app:<APP_ID>` caía no handler de
assets, recebia o shell HTML (ou 404) e o `RecordScope` entrava em laço de reconexão
infinito.

**Agravante.** O build local não monta os provedores (`HAS_PLATFORM_APP_ID` é falso), então
nenhum teste local exercitava esse caminho.

### P3 — ALTO: `{ ...repos, usage }` destacava os métodos do seu `this`

**Severidade:** alta — toda operação de dados lançaria exceção no Worker.

**Evidência.** `server/services/worker.ts` fazia:

```ts
repos: { ...repos, usage: usageWithGlobal }
```

Os repositórios são **instâncias de classe** cujos métodos usam `this.store`. Espalhar um
objeto copia as funções para um novo literal, sem o receptor: `this` passa a ser
`undefined` e a primeira chamada a `this.store.get(...)` lança `TypeError`.

O caminho local não expõe isso (usa os repositórios SQLite diretamente), e o fake não
exercita `createWorkerServices`.

### P4 — MÉDIO: migração reatribuiria todas as linhas ao operador

**Severidade:** média — corrupção de dados em uma migração real.

**Causa.** Consequência de corrigir P1. Com `ownerId: userBound`, o DO carimba a identidade
do **transporte**, ignorando o payload. A migração gravava com transporte administrativo e
esperava preservar o dono original — o que deixaria de ser verdade: todas as linhas
passariam a pertencer ao operador.

### P5 — BAIXO: token não era vinculado à origem do app

`verifyJwt` valida assinatura, `iss`, `exp`, `nbf` e `scope`, mas `authorizedParties` só é
aplicado quando configurado. Sem ele, um token válido emitido para outro app seria aceito.

### P6 — INFORMATIVO: nenhum outro problema encontrado

Verificado e considerado correto: chaves de API nunca no bundle nem em resposta; ausência de
`tools.integration` e de IA gerenciada; ausência de retry nos clientes; `records.count`
corretamente inexistente (o adaptador pagina `records.query`); `deleteWhere` com `where`
obrigatório; paginação via `nextOffset`; mapeamento de erros do DO.

---

## 2. Problemas corrigidos

| # | Correção | Arquivo |
| --- | --- | --- |
| P1 | `ownerId` agora é `userBound: true` + `immutable: true` em todas as 8 collections de domínio | `src/schemas.ts` |
| P2 | Rota `/ws/*` implementada: verifica o token, falha fechado sem bindings, fixa o escopo no app id, delega via `authenticatedRoomRequest` | `worker.ts` |
| P3 | Mapa de repositórios reconstruído em vez de espalhado | `server/services/worker.ts` |
| P4 | Migração exige `transportOwnerId === ownerId` (recusa antes de gravar) e ignora linha de dono divergente com aviso | `server/migration/records.ts`, `scripts/migrate-to-records.ts` |
| P5 | `authorizedParties` derivado de `APP_ORIGIN`/`AZP_ORIGINS` e passado ao verificador (API e socket) | `server/config.ts`, `server/lib/auth-resolver.ts`, `server/services/worker.ts`, `worker.ts` |

### Por que `userBound` em todas, e não em algumas

O briefing pede para não aplicar indiscriminadamente. A análise foi por collection:

| Collection | Escrita pelo cliente? | Dono correto | `userBound` |
| --- | --- | --- | --- |
| `investigations` | sim (`member.create`) | o próprio autor | **sim** |
| `evidence` | sim | o próprio autor | **sim** |
| `analyses` | sim | o próprio autor | **sim** |
| `validations` | sim | o próprio autor | **sim** |
| `activity_logs` | sim (append) | o próprio autor | **sim** |
| `usage_records` | sim (append) | o próprio autor | **sim** |
| `research_queries` | sim | o próprio autor | **sim** |
| `app_settings` | sim | o próprio autor | **sim** |
| `users` | **não** (a plataforma provisiona) | a plataforma | não se aplica |

Todas as oito têm `member.create: true`, então todas eram exploráveis. Nenhuma precisa que
o servidor grave em nome de outro usuário no fluxo normal. A única operação que precisa
escrever por outro dono é a migração — e ela foi ajustada para rodar **como** o dono, em vez
de contornar a proteção.

`immutable: true` acompanha porque um `ownerId` que pode ser alterado depois é a mesma falha
com outro nome: o atacante criaria a linha como própria e a transferiria.

### Efeito nos testes existentes

Dois testes de paridade passaram a falhar — corretamente. Eles assumiam que `ownerId` do
payload era honrado pelo adaptador Records. Foram reescritos para afirmar a garantia mais
forte: **nenhuma linha de outro dono é jamais retornada ao chamador**, por qualquer camada.

---

## 3. Arquivos alterados

```
src/schemas.ts                                ownerId: userBound + immutable (8x)
worker.ts                                     rota /ws, authorizedParties no socket
server/services/worker.ts                     sem spread de repos, authorizedParties
server/lib/auth-resolver.ts                   opção authorizedParties, config do verificador
server/config.ts                              campo authorizedParties
server/migration/records.ts                   contrato owner-bound, warnings no relatório
scripts/migrate-to-records.ts                 transportOwnerId + assertOwnerBound
server/repositories/records/fake-room.ts      userBound e immutable fiéis ao SDK
package.json                                  versão 0.2.1, scripts de auditoria
```

Testes novos:

```
tests/integration/ownership-hardening.test.ts   18  posse, falsificação, imutabilidade, lint do SDK
tests/integration/route-security.test.ts        12  401 em 26 rotas, segredos, bloqueio de integrações
tests/integration/records-protocol.test.ts      28  ferramentas, parâmetros, erros, paginação
tests/integration/migration-ownership.test.ts    7  recusa de transporte divergente
tests/worker/worker-contract.test.ts            17  rotas, headers, ausência de proxy
scripts/check-encoding.ts                        —  auditoria de codificação UTF-8
```

---

## 4. Testes executados e resultados

Executados neste ambiente (Windows, Node 24.22.0):

```
typecheck (cliente)          ✅ sem erros
typecheck (servidor)         ✅ sem erros
lint                         ✅ 0 erros, 0 avisos
check:encoding               ✅ 120 arquivos, nenhum problema
build (SPA)                  ✅ concluído
test (unit+integr+contract)  ✅ 306/306
e2e fluxo principal          ✅ 56/56
e2e fluxos complementares    ✅ 22/22
auditoria de design          ✅ 0 problemas
worker (empacotamento)       ✅ 17/17
worker (workerd ao vivo)     ⏭ SKIPPED — workerd não inicia no ambiente
lint de schema do SDK        ✅ 0 avisos (era 8)
```

Antes desta fase: 224 testes. Depois: **306** (+82).

### O que os testes novos cobrem

**Posse (`ownership-hardening`)**
- o lint do SDK não emite aviso;
- toda collection de domínio tem `ownerId` `userBound` + `immutable`;
- nenhuma coluna não-dono é `userBound`;
- `create` com `ownerId` de outro usuário grava o do chamador;
- o outro usuário não lê a linha criada "em seu nome";
- o carimbo vale nas 8 collections;
- `update` que muda `ownerId` é recusado; reenviar o mesmo valor é aceito;
- caminho administrativo também carimba;
- admin lê entre donos (necessário ao agregado global), membro não;
- membro não usa o caminho admin;
- `usage_records` e `activity_logs` não são editáveis nem apagáveis por membro;
- paginação não vaza linha de outro dono entre páginas.

**Rotas (`route-security`)**
- 26 rotas privadas respondem `401 unauthorized` sem sessão;
- header `x-user-id`/`x-app-action` do cliente não autentica;
- cookie forjado não autentica;
- health é público e não expõe nomes de segredo;
- settings/auth-config/export não contêm valores de chave;
- pesquisa e análise bloqueiam com `503 external_disabled`;
- POST sem CSRF e cross-origin → `403`;
- o navegador não alcança `/api/tools/execute` nem `/api/internal/records/tools`.

**Protocolo (`records-protocol`)**
- usa exatamente `records.query/get/create/update/delete/deleteWhere`;
- `update` envia `data`, nunca `patch`;
- `create` omite `recordId` quando o servidor deve gerar;
- `deleteWhere` envia `where` + `limit`;
- nunca chama `records.count` (não existe);
- mapeia os 11 formatos de erro do DO para códigos tipados;
- segue `nextOffset` até esgotar;
- envia apenas `{ tool, params }`.

**Worker (`worker-contract`)**
- declara `/ws/*` e `/api/*`;
- o socket verifica o token e falha fechado sem bindings;
- fixa o escopo no `DEEPSPACE_APP_ID`;
- `resolveIdentity` lê apenas `authorization` e `cookie`;
- `x-app-action` aparece em um único ponto, guardado por `appAction`;
- o mapa de repositórios não é espalhado;
- não importa `tools.integration`, `apiWorkerFetch` nem `deepspace/ai`.

---

## 5. Riscos que permanecem

| Risco | Impacto | Por que permanece |
| --- | --- | --- |
| **Nenhuma execução em workerd** | alto | O binário não inicia neste ambiente; reproduzido com um Worker mínimo de controle |
| **Durable Object real não exercitado** | alto | O fake implementa o contrato documentado (`userBound`, `immutable`, `uniqueOn`, RBAC, paginação), mas não é o binário do SDK |
| **`authorizedParties` é estreitamento, não barreira total** | médio | O SDK aceita token sem `azp`; assinatura/emissor/exp continuam sendo a barreira principal |
| **Sem chamada real a Exa/Gemini** | médio | Regra de custo; validado contra mock fiel ao formato documentado |
| **Subrequests ao DO não medidos** | médio | Cada operação de dados é um subrequest; listagens grandes paginam. Precisa de medição no app real |
| **Host de preview aceito pelo CSRF** | baixo | `csrfGuard` aceita a origem da própria requisição; em produção com domínio único, é o comportamento correto |
| **Rate limiting em memória** | baixo | Suficiente para uma instância |
| **Sem TLS termination própria** | baixo | Fornecido pela plataforma |

### Sobre o fake

O briefing é explícito: não considerar o fake como comprovação de compatibilidade real.
Concordo, e por isso:

- o fake foi **corrigido nesta fase** para implementar `userBound` e `immutable` — ele não
  fazia isso antes, o que mascarava exatamente o P1;
- os testes de protocolo verificam o **cliente**, não o servidor;
- `worker-contract` faz asserções **estáticas** sobre o código;
- o status de "integração validada" continua **não atingido** (§7).

---

## 6. Funcionalidades comprovadas localmente

- Autenticação por sessão, login/logout, rotas protegidas, CSRF, isolamento entre usuários.
- CRUD de investigações, evidências, análises, validações, histórico, exportação JSON/CSV.
- Bloqueio de integrações desabilitadas, cotas, single-flight, guarda de duplicata.
- Análise estruturada com validação de referências contra o conjunto real.
- Os dois adaptadores de persistência com comportamento equivalente (paridade).
- Posse: impossível criar, alterar ou ler linha de outro dono, em ambas as camadas.
- Migração idempotente, com recusa de transporte divergente e origem intacta.
- Worker empacota para Cloudflare sem runtime Node, sem SQLite e sem segredo embutido.
- Interface: 13 rotas, 3 viewports, contraste WCAG AA, sem overflow.

## 7. Funcionalidades que dependem do ambiente DeepSpace real

- Execução do Worker em `workerd`.
- Comportamento do `AppRecordRoom` real (RBAC, `uniqueOn`, `userBound`, paginação, erros).
- Handshake WebSocket `/ws/*` até o Durable Object.
- `verifyJwt` com chaves reais da plataforma e `azp` efetivo.
- Provisionamento da linha `users` pelo fluxo de conexão da plataforma.
- Medição de subrequests por requisição.

**A integração DeepSpace não está validada.** O que está comprovado é o empacotamento e a
coerência com os contratos documentados.

## 8. Próximos passos para publicação

1. **Autorização do proprietário** (nada abaixo pode começar sem ela).
2. Criar o repositório GitHub e dar push **antes** do primeiro uso do app — a origem trava
   permanentemente.
3. `npx deepspace auth login` + `auth whoami`.
4. Ler quotas e condições de cobrança no dashboard.
5. `npx deepspace app init` (registra o app — decisão permanente).
6. `npx deepspace secrets set EXA_API_KEY=… GEMINI_API_KEY=…`.
7. `npm run test:worker` em ambiente que permita workerd; confirmar execução ao vivo.
8. Deploy de staging; exercitar o RecordRoom real com **dois usuários** e confirmar:
   - `create` com `ownerId` alheio grava o do chamador;
   - `update` de `ownerId` é recusado;
   - `uniqueOn` recusa duplicata;
   - `/ws` conecta e o `RecordScope` fica `connected`.
9. Medir subrequests do dashboard; ajustar `RESEARCH_GLOBAL_DAILY_LIMIT`.
10. `migrate:records --dry-run` e depois a migração real, por dono.
11. Só então avaliar `ENABLE_EXTERNAL_APIS=true`, com limites revisados.

## 9. Conclusão

**Critério de conclusão não atingido**, deliberadamente: não há comprovação em ambiente
real, e nenhuma operação de registro, publicação, secrets ou cobrança foi autorizada.

O que esta fase entregou: quatro defeitos reais encontrados e corrigidos, sendo três
capazes de quebrar a aplicação ou violar isolamento em produção; o lint de schema do SDK
passou de 8 avisos para 0; a suíte cresceu de 224 para 306 testes; e o fake foi corrigido
para não mascarar mais a falha de posse.
