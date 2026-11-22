# Auditoria de segurança — v0.2.4: `authorizedParties` na rota privilegiada

Auditoria pontual executada **sem** `app init`, `deploy`, `push`, `secrets set`, registro de
app, migração real, chamada paga ou acesso ao DeepSpace real. Nenhuma dependência foi
adicionada; nenhuma configuração de plataforma foi tocada.

---

## 1. O defeito

`resolveIdentity()` em `worker.ts` chamava `verifyJwt()` com apenas `publicKey` e `issuer`:

```ts
const outcome = await verifyJwt(
  { publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER },
  token,
)
```

O projeto **já calculava** `config.authorizedParties`, e o `AuthResolver` a usava para
restringir tokens às origens autorizadas. Mas `/api/actions/*` não passa por `AuthResolver`:
ele autentica por `resolveIdentity`. Resultado — três caminhos, duas políticas:

| Caminho | Função | `authorizedParties` |
| --- | --- | --- |
| Rotas de negócio | `requireUser` → `AuthResolver` | ✅ aplicado |
| `/api/actions/*` | `resolveIdentity` | ❌ **ausente** |
| `/ws/*` | `handleWebSocket` | ✅ aplicado |

**Impacto concreto.** Um JWT legítimo, com assinatura, emissor e validade corretos, emitido
para **outro app** da mesma plataforma, era aceito na superfície privilegiada — que executa
com `X-App-Action` e, portanto, com o RBAC por linha desligado. Todas as outras rotas o
recusavam. A rota mais poderosa era a menos restrita.

**Severidade:** média-alta. Não é exploração trivial — exige um token válido de outro app da
mesma plataforma, ou seja, uma conta real em outro contexto. Mas o propósito declarado do
`azp` é exatamente conter esse caso, e ele estava inativo justamente onde mais importa.

**Agravante de processo.** O `void config` no fim da função, com o comentário "Reserved:
`config` is threaded for future audience/party checks", indicava que a checagem era
conhecida e adiada — e nenhum teste falhava por isso.

---

## 2. Correção

Uma única mudança de comportamento, em `resolveIdentity`:

```ts
const verifierConfig: { publicKey: string; issuer: string; authorizedParties?: string[] } = {
  publicKey: env.AUTH_JWT_PUBLIC_KEY,
  issuer: env.AUTH_JWT_ISSUER,
}
if (config.authorizedParties.length > 0) {
  verifierConfig.authorizedParties = config.authorizedParties
}
const outcome = await verifyJwt(verifierConfig, token)
```

Pontos deliberados:

- **Mesma forma que o `AuthResolver` constrói.** A propriedade é *omitida* quando a lista
  está vazia, porque no SDK lista vazia significa "sem restrição" e `[]` significa "negar
  tudo". Replicar o padrão evita uma divergência sutil entre os dois caminhos.
- **Sem regra nova de validação.** Nada de regex próprio, nada de comparação de prefixo. A
  semântica de `azp` é a do SDK.
- **`config` passou a ser usada**; o `void config` foi removido, junto com o `void config`
  equivalente em `handleWebSocket`, para que o código não sugira mais que a configuração é
  ignorada.

---

## 3. Contrato do SDK (verificado, não presumido)

Lido em `deepspace@0.44.2`:

- `dist/worker.d.ts` — `JwtVerifierConfig.authorizedParties?: string[]`, com
  `clockSkewMs` (padrão 5000) e `acceptScope`, que não são usados aqui.
- `dist/worker.js`, `verifyJwt` → aplica `matchesAuthorizedParty` **somente** quando
  `authorizedParties` é não vazio.
- `dist/worker.js`, `matchesAuthorizedParty`:
  - `if (!azp) return true` — **token sem `azp` é aceito**;
  - igualdade literal;
  - `*` → `[^/]*` em regex ancorada;
  - forma `*.dominio` também casa o domínio raiz.

Esse comportamento foi confirmado empiricamente antes de escrever os testes: um `azp` ausente
passa, um `azp` divergente falha com *"Authorized party ... does not match any allowed
pattern"*.

**Nuance registrada em vez de "corrigida".** A aceitação de token sem `azp` parece uma
brecha, mas é o contrato do SDK: a plataforma não emite `azp` em todos os fluxos, e o
estreitamento é opcional por desenho. Endurecer isso aqui (exigir `azp`) quebraria sessões
legítimas. A documentação registra o comportamento; o código segue o SDK.

---

## 4. Testes

### O que é real

`tests/integration/auth-authorized-parties.test.ts` — **18 casos, sem mock do verificador**:

- gera par **ES256 real** (`jose.generateKeyPair`);
- assina JWTs **reais** com `jose.SignJWT`;
- chama o **`verifyJwt` do SDK** (`deepspace/worker`), a mesma função que
  `resolveIdentity` e `AuthResolver` chamam.

| Cenário | Esperado | Resultado |
| --- | --- | --- |
| `azp` autorizado | aceito | ✅ |
| `azp` entre vários autorizados | aceito | ✅ |
| `azp` por curinga | aceito | ✅ |
| `azp` não autorizado | recusado | ✅ |
| Assinatura/emissor/validade ok, `azp` de outro app | recusado **só** com `authorizedParties` | ✅ |
| Origem parecida (`signalmess.app.space.atacante.example`, `http://…`, domínio pai) | recusado | ✅ |
| **Sem `azp`** | **aceito** (contrato do SDK) | ✅ |
| Lista vazia | `azp` ignorado | ✅ |
| Assinatura inválida / expirado / emissor divergente / malformado / `sub` ausente | recusado | ✅ |
| Chave/emissor ausentes | falha fechado | ✅ |
| `config.authorizedParties` derivada de `APP_ORIGIN` e de `AZP_ORIGINS` | correta e efetiva | ✅ |

O caso "assinatura ok, `azp` de outro app" é o teste que fecha o defeito: ele demonstra que o
token **passava** sem `authorizedParties` e **é recusado** com ela.

### O que é estático

`tests/worker/worker-contract.test.ts` (31 casos) — asserções sobre o fonte, porque
`resolveIdentity` é privada e o Worker não inicia neste ambiente:

- `resolveIdentity` consulta `config.authorizedParties` e as passa ao `verifyJwt`;
- a propriedade é omitida quando a lista é vazia;
- nenhum `void config` resta na função;
- os três caminhos consultam o mesmo campo.

### O que é preservado (reconfirmado nesta versão)

- `action-security.test.ts` (22): chamador anônimo → 401; headers forjados não autenticam.
- `migration-multitenant.test.ts` (14): A↔B recusados com 403; dono do app não migra dados
  de terceiros; `userBound`/`immutable` intactos; idempotência e dry-run preservados.

---

## 8. Achados colaterais durante a verificação

Dois defeitos **não relacionados** ao `authorizedParties` apareceram enquanto eu verificava a
suíte. Ambos são reais e foram corrigidos; registro-os porque afetam a confiança nas versões
anteriores.

### 8.1 `package.json` corrompido desde a v0.2.2

O campo `description` saiu com três caracteres no lugar do travessão: `a` circunflexo, símbolo
de euro, e aspas curvas — a sequência que resulta de ler os bytes UTF-8 `E2 80 94` como
Windows-1252. Foi introduzido ao incrementar a versão na v0.2.2 por um `Set-Content` do
PowerShell, e permaneceu nas v0.2.2 e v0.2.3.

**Por que ninguém viu.** O `check:encoding` reportava OK. Ele detecta U+FFFD (bytes inválidos),
mas aquela sequência é ASCII perfeitamente válido — só está errada. O detector de mojibake
existia, porém seu padrão cobria apenas Latin-1 (`\u0080-\u00BF`) e perdia a faixa que o
**Windows-1252** mapeia para pontuação tipográfica (0x94 → U+201D).

Restaurado do baseline 0.2.1 e reaplicada apenas a versão. O padrão do detector foi ampliado e
ganhou teste de regressão (`encoding-guard.test.ts`).

### 8.2 O relatório do `check:encoding` era descartado

`console.error(...)` seguido de `process.exit(1)` não espera o flush quando o destino é um pipe.
Sob um processo pai (runner de teste, CI), o relatório de problemas saía **vazio** — o script
sinalizava falha sem dizer onde. Trocado por `writeSync(2, …)` + `process.exitCode`.

Isso significa que, em qualquer automação anterior, uma falha de encoding teria aparecido como
"exit 1 sem motivo". Era um defeito do guard, não do código sob guarda.

### 8.3 `ECONNRESET` intermitente — segunda causa

A correção da v0.2.3 (destruir sockets no teardown) reduziu a falha de 3/6 para ~1/14, mas não
a eliminou: o pool de conexões do `fetch` global ainda reaproveitava sockets de servidores já
derrubados entre suítes. Corrigido fazendo o listener de teste responder `Connection: close`.
Verificação: 5 execuções completas consecutivas, 440/440.

---

## 9. Limitações — o que **não** foi provado

1. **Nenhuma validação em DeepSpace real.** Não há app registrado, não há workerd, não há
   token de plataforma. Os testes usam a *função* do SDK com chaves que **nós** geramos. Isso
   prova o comportamento do verificador, **não** a integração com a plataforma.
2. **`resolveIdentity` não é exercitada em runtime.** Ela é privada e depende de bindings
   injetados pelo runtime (`AUTH_JWT_PUBLIC_KEY`, `AUTH_JWT_ISSUER`). A ligação é verificada
   por leitura do fonte, não por execução.
3. **A chave pública real da plataforma nunca foi usada.** Formato PEM, cadeia de confiança e
   rotação de chave não foram observados.
4. **`azp` sem valor continua aceito** — por contrato do SDK. Se a plataforma passar a emitir
   `azp` sempre, vale reavaliar; hoje endurecer seria divergir do SDK e quebrar sessões.
5. **`audience` e `acceptScope` não são configurados.** O `verifyJwt` os suporta; nenhum dos
   dois é usado neste app. Não foram alterados nesta versão.

---

## 10. Riscos remanescentes

| Risco | Estado |
| --- | --- |
| Token de outro app na rota privilegiada | **corrigido** (v0.2.4) |
| Token sem `azp` aceito | **por desenho do SDK**; documentado, não "corrigido" |
| `resolveIdentity` divergir de novo do `AuthResolver` | mitigado por teste de contrato; a duplicação de configuração permanece |
| Rota privilegiada ser a mais permissiva | mitigado; os três caminhos agora compartilham a política |
| Ausência de prova em runtime real | **pendente** — bloqueia qualquer declaração de "integração validada" |

---

## 11. Conclusão

Defeito real, escopo estreito, correção pequena: uma função, um objeto de configuração, dois
`void` removidos. A superfície privilegiada deixou de ser a exceção à política de origem.

A verificação, porém, encontrou **três defeitos adicionais** que não estavam no escopo pedido
(§8): uma corrupção de encoding que sobreviveu a duas versões, um guard que descartava o próprio
relatório, e uma segunda causa de instabilidade na suíte. Os três estavam invisíveis porque
suas ferramentas de detecção estavam quebradas — o que é a razão de registrá-los aqui com
detalhe em vez de mencioná-los de passagem.

**Não há declaração de integração validada.** O que existe é: o verificador do SDK foi
exercitado com JWTs reais e se comporta conforme o contrato documentado; o Worker passa a
aplicar a mesma política nos três caminhos, o que está provado por leitura do fonte. A
verificação ponta a ponta exige um app registrado e `workerd`, nenhum dos dois disponível
aqui — e ambos fora do escopo autorizado desta tarefa.
