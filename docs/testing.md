# Testes

Estratégia, o que cada suíte garante e os resultados reais obtidos neste ambiente.

---

## 1. Como executar

```bash
npm run typecheck       # tsc cliente + servidor
npm run lint            # eslint (zero avisos)
npm run test            # 224 testes (unit + integração)
npm run test:unit       # 70 testes
npm run test:integration # 154 testes
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

## 3. Testes unitários — 70

| Arquivo | Testes | Cobre |
| --- | --- | --- |
| `relevance.test.ts` | 12 | índice em [0,1]; justificativa por componente; ausência de data; data futura; domínio institucional vs UGC; marca famosa sem conteúdo não pontua alto; pesos; renormalização; determinismo |
| `analysis-contract.test.ts` | 12 | referência inexistente rejeitada; `citedEvidenceIds` inválido; finding sem fonte; payload incompleto; enum de confiança; texto livre; coleta de citações; `insufficientEvidence`; schema do Gemini; prompt sem credenciais |
| `sanitize.test.ts` | 20 | normalização de URL; rejeição de `javascript:`/`data:`/`file:`; `stripHtml`; domínio; excerpt; janela de meia-noite |
| `schemas.test.ts` | 26 | PATCH parcial sem injeção de default; limites; defaults de criação; URL perigosa; paginação; status inválido |

---

## 4. Testes de integração — 154

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

### 4.7 `migration.test.ts` — 7 (novo na fase 2)

Cópia completa com ids e relações preservados, normalização de URL, idempotência, dry-run sem
gravação, origem intacta, filtro por dono, relatório legível.

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

Executados neste ambiente (Windows, Node 24.22.0):

```
typecheck (cliente)     ✅ sem erros
typecheck (servidor)    ✅ sem erros
lint                    ✅ 0 erros, 0 avisos
build (SPA)             ✅ concluído
unit + integração       ✅ 224/224
e2e fluxo principal     ✅ 56/56
e2e fluxos              ✅ 22/22
auditoria de design     ✅ 0 problemas
worker (empacotamento)  ✅ 17/17
worker (workerd ao vivo)⏭ SKIPPED — workerd não inicia no ambiente
```

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
