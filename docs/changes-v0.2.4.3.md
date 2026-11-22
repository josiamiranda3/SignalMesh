# Alterações — v0.2.4.3: proteção financeira efetiva

Primeira etapa da preparação para integração externa. Torna `ENABLE_PAID_OPERATIONS` um
gate obrigatório para qualquer operação que possa gerar cobrança.

Nenhuma chamada real a provedor, nenhum secret lido ou alterado, nenhum deploy, push ou
registro. A baseline v0.2.4.2 foi preservada e verificada por hash.

---

## 1. O defeito

`server/services/usage.ts:77-80` continha:

```ts
if (this.config.paidOperationsEnabled) {
  // Paid mode is a deliberate owner decision; ...
}
```

Um `if` com corpo vazio. O interruptor existia na configuração, aparecia na UI
(`api-routes.ts:358`) e era documentado como proteção de custo — mas **não bloqueava nada**.
O par `ENABLE_EXTERNAL_APIS=true` + `ENABLE_PAID_OPERATIONS=false` executava chamadas
cobráveis normalmente.

---

## 2. Correção

Em `reserve()`, logo após o gate de `ENABLE_EXTERNAL_APIS`:

```ts
if (!this.config.paidOperationsEnabled) {
  const operation = input.operation === 'research' ? 'pesquisa' : 'análise'
  throw errors.externalDisabled(
    `Operações que podem gerar cobrança estão desabilitadas (ENABLE_PAID_OPERATIONS=false). ` +
      `A ${operation} não foi executada e nenhuma cota foi consumida.`,
  )
}
```

**Por que `reserve()` é o lugar certo.** É o único caminho até os dois provedores:
`research.ts:72` e `analysis.ts:69` o chamam antes do seu único `fetch`. Um gate aqui não
pode ser esquecido por uma rota nova, e roda **antes** de qualquer contagem de cota — uma
recusa não consome nada.

**Resposta HTTP:** `503` com código `external_disabled`, idêntico ao gate existente e já
mapeado no cliente. É indisponibilidade por configuração, não erro do pedido nem falta de
permissão.

**Rótulo singular.** `labelFor()` devolve plural ("pesquisas"), correto nas mensagens de cota
mas errado em "A pesquisas não foi executada". A mensagem nova usa um rótulo próprio, sem
alterar o existente.

---

## 3. Arquivos alterados

| Arquivo | Mudança |
| --- | --- |
| `server/services/usage.ts` | gate efetivo em `reserve()`; comentário explicando os dois interruptores |
| `tests/integration/providers-and-quota.test.ts` | `PAID=true` como padrão do `boot()`; 3 testes novos; 1 teste existente fixado em `PAID=false` |
| `tests/integration/crud-export.test.ts` | `PAID=true` (executa pesquisa e análise simuladas) |
| `tests/integration/auth-isolation.test.ts` | `PAID=true` (executa pesquisa simulada) |
| `tests/e2e/run-e2e.ts` | `PAID=true` |
| `tests/e2e/run-flows.ts` | `PAID=true` |
| `package.json`, `package-lock.json`, `server/app.ts` | versão `0.2.4.3` |

**Não alterados:** `worker.ts`, `wrangler.toml`, `exa.ts`, `gemini.ts`, `analysis.ts`,
`research.ts`, `route-security.test.ts` (usa `EXTERNAL=false` e já espera 503).

---

## 4. Testes

### Novo — 3 casos em `providers-and-quota.test.ts`

1. **`blocks every provider call when paid operations are disabled`**
   `EXTERNAL=true` + `PAID=false` → pesquisa **503** e análise **503**, código
   `external_disabled`, mensagem contendo `ENABLE_PAID_OPERATIONS`, e
   **`exaRequests === 0` e `geminiRequests === 0`**.
   A análise valida entrada antes de reservar, então o caso semeia evidência pelo endpoint
   manual (v0.2.4.2) — assim a recusa é do gate, não da ausência de fontes.

2. **`consumes no quota when paid operations are disabled`**
   Verifica `quota.analysis.used` e `quota.research.used` antes e depois: ambos permanecem
   `0`, e `remaining` fica em `2`. Prova que o bloqueio ocorre **antes** da contagem.

3. **`runs paid operations when both switches are on`**
   Controle positivo: `EXTERNAL=true` + `PAID=true` → pesquisa 200 (1 requisição à Exa) e
   análise 201 (1 requisição ao Gemini). Garante que o gate não bloqueia operação legítima.

### Corrigido — 1 caso existente

`blocks every provider call when external APIs are disabled` passou a fixar também
`PAID=false`.

**Motivo:** com `PAID=true` como padrão do `boot()`, o caso ficava com
`EXTERNAL=false` + `PAID=true`, combinação que `assertProductionSafety` (`config.ts:200`)
recusa no boot. A falha aparecia como `Unsafe configuration` — não como o 503 esperado.
Fixar ambos em `false` é também a descrição honesta de "tudo desligado".

### Suítes atualizadas para `PAID=true`

Necessárias porque executam operações pagas simuladas: `crud-export` (4 chamadas),
`auth-isolation` (2), `run-e2e`, `run-flows`. Sem isso retornariam 503 e falhariam por
motivo alheio ao que testam.

### Resultados

```
typecheck (cliente)      ✅ 0 erros
typecheck (servidor)     ✅ 0 erros
lint                     ✅ 0 erros, 0 avisos
check:encoding           ✅ 144 arquivos
build (SPA)              ✅ concluído
unit + integração + contrato ✅ 466/466   (baseline: 463)
```

`providers-and-quota.test.ts`: 31/31, verificado em 4 execuções independentes.

---

## 5. Confirmação de zero chamadas externas reais

| Verificação | Resultado |
| --- | --- |
| URLs reais de provedor nos testes | **nenhuma ocorrência** de `api.exa.ai` ou `generativelanguage.googleapis.com` |
| Base URL injetada nos testes | `EXA_BASE_URL` e `GEMINI_BASE_URL` apontam para `127.0.0.1` (`harness.ts:241,244`) |
| Chamadas ao mock | contadas por asserção: `0` nos bloqueios, `1` no controle positivo |
| `ENABLE_EXTERNAL_APIS` em produção | inalterado (`wrangler.toml` não foi tocado) |
| Secrets | nenhum lido, impresso ou alterado |

---

## 6. Risco de regressão identificado

⚠️ **Qualquer suíte futura que execute pesquisa ou análise precisará de `PAID=true`.**
A falha será `503 external_disabled`, que pode ser confundida com o gate de
`ENABLE_EXTERNAL_APIS` por quem ler apenas o status. A mensagem distingue os dois casos
nomeando o interruptor, e o padrão de `boot()` já resolve isso em
`providers-and-quota.test.ts`.

⚠️ **O aviso de "hang" observado durante a verificação não era do código.** A suíte
`providers-and-quota` pareceu travar duas vezes; medições posteriores mostraram término em
~2s com 31/31, repetido 4 vezes. A causa foi contenção de recursos do ambiente (processos
de navegador e jobs paralelos), não os testes. Registro porque um `timeout` mal interpretado
poderia ter levado a "corrigir" algo que não estava quebrado.

---

## 7. O que esta etapa **não** faz

- **Não implementa `QuotaRoom`.** O `inFlight` continua em memória e segue sem proteger
  contra concorrência entre isolates — problema da próxima etapa.
- **Não altera** `worker.ts`, `wrangler.toml` ou a arquitetura DeepSpace.
- **Não adiciona dependências.**

---

## 8. Baseline preservada

```
signalmess-v0.2.4.2-baseline.zip
SHA256: B7F14C7AC17541AEA08CB084A69E4AE1D1E421DCB0781948F9F9494340B6D387
Tamanho: 493.4 KB
```
