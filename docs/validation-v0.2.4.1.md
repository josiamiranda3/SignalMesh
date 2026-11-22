# Validação operacional local — v0.2.4.1

Investigação dos quatro bloqueios que impediam a execução de E2E, fluxos, auditoria de design
e empacotamento do Worker. Nenhuma operação externa foi executada: sem `app init`, deploy,
push, registro, secrets, migração real ou chamada a provedor.

---

## 1. Causas dos bloqueios

Os três primeiros tinham a **mesma causa raiz** e o quarto tinha outra, independente.

### 1.1 Chrome sai com `0xFFFF7001`

`0xFFFF7001` = `4294930433` — é o código que o Windows reporta para um processo encerrado por
exceção não tratada. A mensagem real, capturada com stderr redirecionado:

```
[ERROR:crashpad_client_win.cc:431] OpenProcess: Acesso negado. (0x5)
[ERROR:crashpad_client_win.cc:145] crash server failed to launch, self-terminating
[FATAL:mojo\public\cpp\platform\platform_channel.cc:112] Check failed: . : Acesso negado. (0x5)
```

Duas operações negadas: `OpenProcess` (usado pelo crashpad para inspecionar um processo filho)
e `platform_channel` (o canal **named pipe** que o Mojo usa para IPC entre os processos do
Chromium). O Chrome não chega a iniciar um renderer — por isso o driver CDP nunca vê um
DevTools ativo e reporta "encerrou antes de expor o DevTools".

**Não é específico do Chrome.** Testado com o Microsoft Edge, instalado na máquina:

```
[FATAL:mojo\public\cpp\platform\platform_channel.cc:187] Check failed: . : Acesso negado. (0x5)
```

**Não é configuração.** Testadas quatro variações, todas falharam do mesmo jeito:
`--headless=new`, `--no-sandbox`, `--disable-crash-reporter`/`--disable-breakpad`, e
`stdio: 'ignore'` em vez de pipes. O bloqueio está abaixo da linha de flags.

### 1.2 Wrangler falha com `spawn EPERM`

Duas camadas distintas, ambas por `spawn`:

**Camada 1 — o wrapper.** `node_modules/wrangler/bin/wrangler.js:35` inicia o CLI real com:

```js
stdio: ["inherit", "inherit", "inherit", "ipc"]
```

O quarto descritor é um **canal IPC**, que no Windows é um named pipe. `spawn` é negado.

**Camada 2 — o esbuild.** Invocando `wrangler-dist/cli.js` diretamente (contornando o
wrapper), o `--version` funciona, mas o empacotamento falha:

```
Error: spawn EPERM
  at ensureServiceIsRunning (node_modules/wrangler/node_modules/esbuild/lib/main.js:1978)
  at startSyncServiceWorker (...:2184)
```

O esbuild mantém um *service worker* — um processo filho falando por pipes. `ESBUILD_WORKER_THREADS=0`
não ajuda: essa variável só controla a escolha entre thread e processo, e o serviço é exigido
de qualquer forma.

**O binário nativo está presente e saudável** (`@esbuild/win32-x64/esbuild.exe --version` →
`0.27.7`), então não é dependência ausente nem versão incompatível.

### 1.3 Por que isso apareceu como "bug do projeto"

Em ambos os casos o erro surge na inicialização, antes de qualquer código do SignalMesh rodar.
Um relatório que dissesse apenas "E2E falhou" ou "wrangler falhou" convidava à conclusão errada.

**Prova experimental.** Executando os mesmos comandos fora do confinamento do sandbox:

| Suíte | Antes | Depois |
| --- | --- | --- |
| `run-e2e.ts` | exit 1, `0xFFFF7001` | **56/56, exit 0** |
| `run-flows.ts` | exit 1, `0xFFFF7001` | **22/22, exit 0** |
| `design-audit.ts` | exit 1, `0xFFFF7001` | **0 problemas, exit 0** |
| worker smoke | exit 1, `spawn EPERM` | **17/17 empacotamento, exit 0** |

Nenhuma linha de código foi alterada entre as duas colunas.

### 1.4 workerd: causa **diferente**, ainda bloqueado

O workerd não sofre do bloqueio de pipes. O binário existe e responde:

```
node_modules/@cloudflare/workerd-windows-64/bin/workerd.exe --version
→ workerd 2026-04-20
```

Mas ao servir qualquer configuração — inclusive um Worker mínimo de controle — ele crasha:

```
*** std::terminate() called with no exception
stack: 7ff8d31f1239 7ff7f8e96695 ...
```

Isso acontece **também fora do confinamento**, o que descarta permissão como causa. É uma
falha interna do runtime nesta máquina. O smoke reporta `SKIPPED` com essa justificativa, o
que é o comportamento correto: empacotamento verificado, execução ao vivo não verificada.

---

## 2. Arquivos modificados

**Código de aplicação: nenhum.** Verificado por hash SHA-256 contra a baseline
`signalmess-v0.2.4.1-baseline.zip`:

```
worker.ts                       UNCHANGED
server/actions/index.ts         UNCHANGED
server/actions/migrate-records.ts UNCHANGED
server/lib/auth-resolver.ts     UNCHANGED
server/lib/csrf-policy.ts       UNCHANGED
server/http/action-routes.ts    UNCHANGED
src/schemas.ts                  UNCHANGED
tests/worker/run-worker-smoke.ts UNCHANGED
tests/e2e/cdp.ts                UNCHANGED
```

Documentação atualizada:

| Arquivo | Mudança |
| --- | --- |
| `docs/testing.md` | §4.19 (nova): causas dos bloqueios e como executar; §8 corrigida de "não executado" para os resultados reais |
| `docs/validation-v0.2.4.1.md` | este relatório |

Artefatos regenerados pelas execuções (`tests/e2e/artifacts/*.png`,
`tests/e2e/artifacts/design-audit.json`, `tests/worker/artifacts/worker-verification.txt`) são
saída de teste, não código.

---

## 3. Comandos executados

Sob confinamento (diagnóstico):

```
chrome.exe --headless=new --user-data-dir=... about:blank     # 0xFFFF7001 + stderr
msedge.exe --headless=new --user-data-dir=... about:blank     # mesmo erro
node node_modules/wrangler/bin/wrangler.js --version          # spawn EPERM
node node_modules/wrangler/wrangler-dist/cli.js --version     # 4.79.0 (ok)
node node_modules/wrangler/wrangler-dist/cli.js deploy --dry-run --outdir=.wrangler-dryrun
node_modules/@esbuild/win32-x64/esbuild.exe --version         # 0.27.7 (ok)
node_modules/@cloudflare/workerd-windows-64/bin/workerd.exe --version   # ok
workerd.exe serve <minimal.capnp>                             # std::terminate
node -e "spawnSync(node, ..., {stdio:'pipe'})"                # EPERM
node -e "spawnSync(node, ..., {stdio:'inherit'})"             # ok
```

Fora do confinamento (execução):

```
node --experimental-transform-types tests/e2e/run-e2e.ts
node --experimental-transform-types tests/e2e/run-flows.ts
node --experimental-transform-types tests/e2e/design-audit.ts
node --experimental-transform-types tests/worker/run-worker-smoke.ts
```

---

## 4. Resultados

### Executados com sucesso

| Verificação | Resultado |
| --- | --- |
| typecheck — cliente | ✅ 0 erros |
| typecheck — servidor | ✅ 0 erros |
| lint | ✅ 0 erros, 0 avisos |
| check:encoding | ✅ 140 arquivos |
| build SPA (vite/rolldown) | ✅ concluído |
| suíte automatizada (unit + integração + contrato) | ✅ **440/440** |
| E2E fluxo principal | ✅ **56/56** |
| E2E fluxos complementares | ✅ **22/22** |
| auditoria de design (13 rotas × 3 viewports) | ✅ **0 problemas** |
| Worker — empacotamento (wrangler dry-run) | ✅ **17/17** |

### Ignorados por decisão do próprio teste

| Verificação | Motivo |
| --- | --- |
| Worker — execução ao vivo no workerd | `std::terminate()` do binário neste ambiente; reportado como `SKIPPED`, não como aprovado |

### Bloqueados (e por quê)

Nenhum teste ficou bloqueado nesta rodada. O único item não executado é o workerd ao vivo,
que é uma limitação do binário e está registrado como tal.

---

## 5. Problemas ainda existentes

1. **Workerd não executa nesta máquina.** Empacotamento verificado; comportamento em runtime de
   produção, não. Nenhuma alteração de código resolve isso — depende de outro ambiente.
2. **O binário do Vite não empacota o Worker.** O build de plataforma exige `DEEPSPACE_APP_ID`
   real, que só existe após `app init` — proibido nesta fase. Por isso a validação de bundle
   passa pelo wrangler.
3. **E2E, fluxos e design audit exigem execução fora do confinamento.** Está documentado; quem
   rodar dentro do sandbox vai ver os mesmos erros e precisa saber que não são do projeto.
4. **Nada foi validado contra o DeepSpace real.** Sem app registrado, sem JWT de plataforma,
   sem RecordRoom real.

---

## 6. Próximos requisitos para a validação real

Em ordem, cada um exigindo autorização própria:

1. **Um ambiente onde o workerd inicie** (Linux, macOS, ou Windows sem a restrição de
   `std::terminate`) — pré-requisito para saber se o Worker sobe.
2. **Sessão DeepSpace** (`auth login`) e **registro do app** (`app init`) — decisão permanente
   de origem, precisa de autorização explícita do proprietário.
3. **Secrets** (`EXA_API_KEY`, `GEMINI_API_KEY`) via `secrets set`.
4. **Deploy** e verificação de `/api/health` em `runtime=worker, storage=records`.
5. **Validação do RecordRoom real** — RBAC, `userBound`, `immutable`, `uniqueOn` e paginação
   contra o Durable Object de verdade, não contra o `FakeRecordRoom`.
6. **Migração real** por proprietário, começando com `--dry-run`.
7. **`/ws/*`** conectando e o `RecordScope` ficando `connected`.
8. Só então discutir `ENABLE_EXTERNAL_APIS=true`, com limites revisados.

Nenhum desses passos foi executado, e nenhum resultado aqui deve ser lido como validação da
plataforma.
