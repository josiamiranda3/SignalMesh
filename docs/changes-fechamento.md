# Fechamento — concorrência de reservas

Conclui o defeito remanescente da v0.2.4.3: o controle `inFlight` vivia em memória e não
garantia exclusividade entre instâncias do Worker. Nenhuma funcionalidade nova foi adicionada.

---

## 1. O defeito e a solução

**Fato confirmado no código:** `worker.ts:168,178` constroem os serviços **por requisição**
(`services/worker.ts:24` documenta o motivo). O `Map` de `usage.ts` nascia vazio a cada
invocação, então duas requisições concorrentes do mesmo usuário passavam ambas. Em Node o
`Map` funcionava porque há uma instância só — a assimetria é que escondia o problema.

**Primitiva escolhida — verificada, não inventada.** O SDK não expõe transaction nem API de
lock (verificado: `transaction`=0 ocorrências, `atomic`=0 em `worker.d.ts`). Expõe `uniqueOn`,
que o RecordRoom materializa como índice único real:

```js
// node_modules/deepspace/dist/worker.js
sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${tbl}" (${uniqueCols.join(", ")})`)
```

Isso basta: o `INSERT` ou entra, ou viola a restrição. Não há janela entre checar e escrever, e
não foi necessário criar infraestrutura especulativa.

**Desenho:** nova collection `quota_reservations` com `uniqueOn: ['ownerId', 'operation']`,
`ownerId` userBound + immutable (o contrato de todas as collections), `token` para que só o
detentor libere, e `expiresAt` para que uma requisição morta não bloqueie para sempre.

O adaptador SQLite espelha a mesma semântica com tabela + `UNIQUE INDEX`, então os dois
runtimes se comportam igual e o teste de um vale como contrato do outro.

---

## 2. Arquivos modificados

| Arquivo | Mudança |
| --- | --- |
| `src/schemas.ts` | collection `quota_reservations` + `COLLECTIONS.quotaReservations` |
| `server/db.ts` | tabela + índice único no SQLite local |
| `server/repositories/ports.ts` | porta `QuotaReservationRepository` |
| `server/repositories/sqlite.ts` | adaptador com `INSERT` + índice único |
| `server/repositories/records/repositories.ts` | adaptador sobre `uniqueOn` do RecordRoom |
| `server/services/usage.ts` | `reserve()` usa a reserva; `release()` vira async; `Map` removido |
| `server/services/worker.ts` | repassa `repositories.reservations` |
| `tests/integration/quota-reservation.test.ts` | novo — 9 testes |
| `tests/integration/quota-concurrency.test.ts` | novo — 4 testes |
| `README.md`, `docs/testing.md` | contagens |

---

## 3. Testes executados

```
typecheck (cliente)      ✅ 0 erros
typecheck (servidor)     ✅ 0 erros
lint                     ✅ 0 erros, 0 avisos
check:encoding           ✅ 147 arquivos
build (SPA)              ✅ concluído
lintSchemas (SDK)        ✅ [] — zero avisos no schema novo
unit + integração + contrato ✅ 479/479   (456 → 479, +13)
E2E navegador real       ✅ 56/56
Fluxos funcionais        ✅ 22/22
Auditoria de design      ✅ 0 problemas (13 rotas × 3 viewports)
Worker — empacotamento   ✅ 17/17
```

**Prova da concorrência:** corrida de 10 `acquire` simultâneos produz exatamente 1 vencedor;
duas requisições HTTP de análise simultâneas produzem `[201, 429]` e **exatamente uma chamada
ao Gemini**.

**Prova do bundle:** re-empacotado e inspecionado — `quota_reservations` presente,
`CREATE UNIQUE INDEX` presente, `reservations.acquire` presente, gate
`ENABLE_PAID_OPERATIONS=false` presente. (Os 7 `inFlight` restantes no bundle são do
`JobRoom` **do SDK**, não do nosso código.)

---

## 4. Achado durante a validação

O primeiro `run-worker-smoke` reportou 17/17 usando um bundle de **09:18**, anterior às
mudanças — o diretório `.wrangler-dryrun` era reaproveitado. Limpei os artefatos e re-empacotei,
que é quando a verificação passou a valer. **Um smoke test que reutiliza bundle velho valida o
passado**, e isso quase passou despercebido.

---

## 5. Limitação técnica que permanece

⚠️ **A atomicidade do adaptador Records não foi verificada em runtime.** O `uniqueOn` gera a
restrição — isso está no código do SDK e foi lido — mas se o Durable Object real se comporta
como o SQLite local sob concorrência **não foi observado**, porque o `workerd` não inicia neste
ambiente (`std::terminate`, reproduzido com um Worker mínimo). Os testes provam o contrato no
adaptador SQLite; o adaptador Records foi escrito contra o mesmo índice e validado apenas por
empacotamento.

---

## 6. Pendências externas

Exigem autorização ou credenciais, não implementação:

1. **Ambiente com workerd funcional** — pré-requisito para observar a concorrência real.
2. **Sessão DeepSpace** (`auth login`) e **registro do app** (`app init`).
3. **Decisão sobre a origem do código** — o primeiro deploy a fixa permanentemente; sem remoto
   GitHub, fixa DeepSpace.
4. **Secrets** `EXA_API_KEY` e `GEMINI_API_KEY`.
5. **Deploy** e validação de `/api/health` em `runtime=worker, storage=records`.
6. **Autorização para habilitar** `ENABLE_EXTERNAL_APIS` / `ENABLE_PAID_OPERATIONS` — sem ela,
   pesquisa e análise permanecem bloqueadas por desenho.

---

## 7. Adendo — observações posteriores em produção

Após a redação deste relatório, a aplicação foi publicada e o responsável confirmou, em
validação manual, o funcionamento dos fluxos de autenticação, pesquisa real via Exa, análise
real via Gemini, persistência dos registros e atualizações em tempo real. Os detalhes
observados estão em [production-validation.md](production-validation.md).

Esse resultado posterior atualiza o estado operacional da aplicação, mas não altera
retroativamente o escopo dos testes descritos nas seções anteriores.

**Distinção importante:** persistência e atualização em tempo real foram observadas no fluxo
manual de produção. Isso, isoladamente, não demonstra que duas requisições simultâneas disputando
a mesma reserva sejam serializadas pelo Durable Object real. A garantia de concorrência só deve
ser declarada como validada após um teste concorrente específico, reproduzível e documentado no
ambiente de produção.
