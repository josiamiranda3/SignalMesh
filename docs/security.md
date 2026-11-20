# Segurança

Modelo de ameaças e os controles implementados, com o teste que prova cada um.

---

## 1. Fronteiras de confiança

| Fronteira | Confiança | Controle |
| --- | --- | --- |
| Navegador → Worker | **não confiável** | JWT verificado, CSRF, validação zod, posse |
| Worker → RecordRoom | autenticada | identidade no header + RBAC do Durable Object |
| Worker → provedores | confiável na saída, **não na entrada** | timeout, mapeamento de erro, validação de resposta |
| Conteúdo de fontes | **não confiável** | delimitado no prompt, nunca interpretado como instrução |
| Worker → armazenamento | confiável | operações parametrizadas pelo protocolo de tools |

O princípio: **o servidor é a única autoridade**. O cliente pede; ele não decide.

---

## 2. Autenticação

### 2.1 DeepSpace Auth (produção)

- A identidade chega como **JWT assinado** pela plataforma e é verificada com `verifyJwt`
  usando `AUTH_JWT_PUBLIC_KEY` + `AUTH_JWT_ISSUER`, ambos injetados pelo runtime.
- A aplicação **não emite, assina, renova nem armazena** JWT. Não existe segredo de
  assinatura no código, no repositório ou no bundle.
- Token lido do header `Authorization: Bearer` (o que o SDK anexa) ou, na navegação
  same-origin, do cookie de sessão da plataforma.
- Sem chave ou emissor configurados, o resolvedor **falha fechado**: retorna "não
  autenticado" em vez de confiar em um header.

### 2.2 Adaptador local (exclusivo de teste)

- Token opaco de 256 bits; só o SHA-256 é persistido.
- Cookie `HttpOnly`, `SameSite=Lax`, `Secure` sob HTTPS.
- Recusado por `assertProductionSafety` quando:
  - o runtime é o Worker, **ou**
  - `NODE_ENV=production`.
- O endpoint `POST /api/auth/login` responde `404` em modo DeepSpace: não existe caminho
  alternativo de entrada em produção.

### 2.3 Verificação por requisição

`requireUser` resolve a identidade em **toda** requisição privada e carrega o `UserRecord`.
Nenhuma rota de negócio executa sem esse passo.

### Testes

`tests/integration/auth-deepspace.test.ts` (21 casos), incluindo:

- o modo é derivado do runtime, não de variável controlável pelo cliente;
- falha fechada quando as bindings de verificação faltam;
- o modo DeepSpace nunca consulta a sessão local;
- o modo local ignora um Bearer token;
- um Worker configurado para o adaptador local não sobe.

---

## 3. Autorização — duas camadas independentes

### 3.1 Serviço

`requireOwned` compara `ownerId` e responde **`404`** (não `403`): `403` confirmaria a
existência do registro.

### 3.2 Durable Object

As collections declaram `ownerField: 'ownerId'` com `read/update/delete: 'own'`. O Worker
envia `X-User-Id` **sem** `X-App-Action`, então o DO resolve o papel do chamador e aplica
`permissions` **antes** de devolver ou gravar.

`ownerId` é ainda `userBound: true` + `immutable: true`, o que fecha a falha de falsificação
de posse: sem `userBound`, um membro cria a linha com o id da vítima e a linha passa a
satisfazer `'own'` para ela. Sem `immutable`, ele a cria como própria e transfere depois.
O lint do SDK detecta a primeira omissão, e a suíte falha se ela voltar.

A camada inferior não depende de o código lembrar de chamar `requireOwned` — ela aplica a
política da collection no armazenamento.

### 3.3 Nenhum caminho alternativo

- O cliente nunca envia `ownerId`; o servidor ignora se enviar.
- Pesquisa e análise só acontecem depois do `requireOwned`.
- Exportação lê apenas a investigação do chamador.

### Testes

`tests/integration/auth-isolation.test.ts` (8 casos via HTTP) e
`tests/integration/records-security.test.ts` (9 casos **diretamente no armazenamento**),
incluindo leitura por id, atualização, exclusão, `deleteWhere` e consulta entre dois
usuários.

---

## 4. CSRF e origem

Métodos mutantes exigem:

1. header `x-signalmess-request: 1`;
2. `Origin` igual à origem do próprio app (a mesma da requisição) ou a `APP_ORIGIN` /
   `ALLOWED_ORIGINS`.

Aceitar a origem da própria requisição é correto e não afrouxa nada: o navegador não
consegue reportar a origem do atacante e a do app ao mesmo tempo, e o header marcador não
pode ser definido cross-origin sem um preflight que o app não concede. A checagem por
`APP_ORIGIN` cobre proxy reverso que reescreve host.

Sem header → `403`.

---

## 5. Entrada e conteúdo

### 5.1 Validação

Todo corpo e query passam por schema zod antes do serviço. Nenhum handler usa
`c.req.json()` diretamente.

### 5.2 Injeção

Todas as consultas SQLite usam parâmetros posicionais. O adaptador Records não monta
consulta: envia operações tipadas ao DO, que valida o nome de cada campo do `where`
(um campo desconhecido é recusado).

### 5.3 URLs

`isSafeHttpUrl` só aceita `http:` e `https:`, bloqueando `javascript:`, `data:` e `file:`.
Aplicado na entrada de evidência e antes de renderizar qualquer `<a href>` vindo de
provedor.

### 5.4 Conteúdo de fontes

1. `stripHtml` remove `script`/`style`/tags;
2. no prompt, cada fonte vai dentro de `<fonte id="…">…</fonte>`;
3. a instrução de sistema diz que o conteúdo é dado, não comando;
4. a saída do modelo é validada por schema — um desvio de instrução não vira estrutura
   aceita.

### 5.5 Limites de tamanho

`maxLength` declarado nas collections e no zod. O Durable Object recusa um valor acima do
limite antes de gravar (verificado em `records-security.test.ts`).

---

## 6. Segredos

| Segredo | Onde vive | Onde **não** vive |
| --- | --- | --- |
| `EXA_API_KEY` | secrets do Worker / ambiente | cliente, banco, export, logs, bundle |
| `GEMINI_API_KEY` | secrets do Worker / ambiente | idem |
| Chave de sessão local | ambiente (só runtime Node) | cliente |

Verificações automatizadas:

- `tests/worker/run-worker-smoke.ts` inspeciona o bundle e confirma que nenhum valor de
  chave foi embutido e que o interruptor de custo é lido em runtime;
- `tests/integration/crud-export.test.ts` confirma que export JSON/CSV não contém chaves nem
  sessão;
- o teste E2E confirma que a interface não exibe chaves.

`.gitignore` cobre `.env`, `.env.*`, `.dev.vars*`, `*.pem`, `*.key`, `.data/`, `*.sqlite`,
`.wrangler*`.

**Nunca** use `secrets get --plain` para levar um valor a um lugar onde ele vaze.

---

## 7. Proteção de custo como controle de segurança

Uma cobrança não autorizada é um incidente tanto quanto um vazamento.

| Controle | Implementação | Teste |
| --- | --- | --- |
| Interruptor global | `ENABLE_EXTERNAL_APIS=false` por padrão | `blocks every provider call when external APIs are disabled` |
| Chave ausente | erro explícito citando a variável | `blocks the provider when the API key is missing` |
| Cota por usuário/dia | `usage.reserve` no backend | `enforces the per-user daily research limit` |
| Cota global/dia | leitor administrativo de agregado | idem |
| Uma operação simultânea | single-flight por `userId:operation` | protegido no mesmo caminho |
| Consulta duplicada | hash + janela configurável | `blocks an identical research query inside the duplicate guard window` |
| Sem retry automático | nenhum laço nos clientes | testes de 401/429/500 verificam 1 requisição |
| Registro de bloqueios | `usage_records.status = 'blocked'` | `records blocked attempts so the operator can audit refusals` |

O teto global usa um transporte administrativo **apenas** para somar; ele devolve um número
e nunca uma linha. Ver [docs/database.md](database.md#5-consumo-global).

---

## 8. Erros e logs

| Situação | Cliente recebe |
| --- | --- |
| Erro de validação | `400` + detalhes por campo |
| Sem sessão | `401` + mensagem de ação |
| Recurso de outro usuário | `404` |
| CSRF ausente / origem estranha | `403` |
| Cota esgotada | `429` + `quota_exceeded` |
| Provedor 429 | `429` + `provider_rate_limited` |
| Provedor 401/403 | `502` + `provider_auth_failed` |
| Provedor lento | `504` + `provider_timeout` |
| Exceção inesperada | `500` genérico + `requestId` |

Nunca: stack trace, texto de SQL, caminho de arquivo, valor de variável de ambiente.

Logs registram método, caminho, status e `requestId` — nunca corpos, cookies, tokens ou
chaves.

---

## 9. Ameaças consideradas

| Ameaça | Controle | Residual |
| --- | --- | --- |
| Acesso a dados de outro usuário | posse no serviço **+** RBAC no DO | — |
| JWT forjado | assinatura verificada com chave pública da plataforma | — |
| Sessão local usada em produção | recusada em build e em runtime | — |
| Enumeração de ids | ids aleatórios; `404` uniforme | baixa |
| CSRF | header + origem + `SameSite` | — |
| XSS via conteúdo de fonte | sem `dangerouslySetInnerHTML`; `stripHtml`; React escapa | — |
| Open redirect no login | `next` só aceita caminho relativo same-origin | — |
| Prompt injection via fontes | delimitação + instrução + validação de schema | modelo pode ser influenciado; por isso há validação humana |
| Fabricação de referências | validação contra o conjunto real de ids | — |
| Cobrança não autorizada | interruptores, cotas, sem retry | — |
| Vazamento de segredo no bundle | verificação automatizada do artefato | — |
| Exclusão indevida em massa | `deleteWhere` exige `where` e limita a página; RBAC por linha | — |
| Auditoria reescrita pelo usuário | `activity_logs` append-only para membros | — |

---

## 10. Antes de expor publicamente

1. Registrar o app (`npx deepspace app init`) — decisão permanente de origem do código.
2. Definir `EXA_API_KEY` e `GEMINI_API_KEY` com `npx deepspace secrets set`.
3. Manter `ENABLE_EXTERNAL_APIS=false` até revisar cotas; ligar só então.
4. Manter `ENABLE_PAID_OPERATIONS=false` sem autorização escrita.
5. Revisar `RESEARCH_GLOBAL_DAILY_LIMIT` / `ANALYSIS_GLOBAL_DAILY_LIMIT` para o público
   esperado.
6. Confirmar HTTPS (a plataforma fornece) e que `APP_ORIGIN` reflete o domínio público.
7. Rodar `npm run test:worker` em um ambiente que permita ao workerd iniciar.
