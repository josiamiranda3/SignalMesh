# Segurança

Modelo de ameaças e os controles implementados, com o teste que prova cada um.

---

## 1. Fronteiras de confiança

| Fronteira | Confiança | Controle |
| --- | --- | --- |
| Navegador → servidor | **não confiável** | sessão verificada, CSRF, validação zod |
| Servidor → provedores | confiável na saída, **não na entrada** | timeout, mapeamento de erro, validação de resposta |
| Conteúdo de fontes | **não confiável** | delimitado no prompt, nunca interpretado como instrução |
| Servidor → banco | confiável | queries parametrizadas |

O princípio que rege tudo: **o servidor é a única autoridade**. O cliente pode pedir; ele
não decide.

---

## 2. Autenticação

### 2.1 Sessão

- Token de 256 bits (`crypto.randomBytes(32).toString('base64url')`).
- Apenas o **hash SHA-256** é persistido; o token existe só no cookie.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` quando a origem é HTTPS.
- `Max-Age` configurável (`SESSION_TTL_SECONDS`, padrão 14 dias).
- Logout apaga a linha da sessão — revogação imediata, não expiração preguiçosa.
- Sessões expiradas são removidas na emissão de uma nova.

### 2.2 Verificação por requisição

`requireUser` resolve o cookie em uma linha de `users` **a cada requisição**. Não há
claims assinados a validar; não há janela em que uma sessão revogada continue válida.

### 2.3 Adaptador local

O adaptador aceita o e-mail informado sem senha. Isso é aceitável **apenas** em um
ambiente controlado pelo operador, e está:

- documentado na interface ("Autenticação deste ambiente");
- desativado em `NODE_ENV=production` (responde `403` explicando que é preciso configurar
  o DeepSpace Auth);
- coberto por teste.

---

## 3. Autorização

### 3.1 Posse

Toda operação sobre recurso existente passa por `requireOwned`, que compara
`ownerId` com o usuário da sessão. Recursos de outro usuário respondem **`404`**, não
`403` — a diferença importa: `403` confirmaria a existência do registro.

### 3.2 Nenhum caminho alternativo

- O cliente nunca envia `ownerId`; o servidor ignora se enviar.
- A consulta à Exa e a chamada ao Gemini só acontecem **depois** do `requireOwned`.
- Exportação lê apenas a investigação do chamador.
- Um teste verifica que uma tentativa de pesquisa em investigação alheia produz `404` **e
  zero chamadas ao provedor** — a ordem importa.

### 3.3 Testes

`tests/integration/auth-isolation.test.ts` — 8 casos cobrindo leitura, escrita, exclusão,
exportação, listagem, evidência e validação entre dois usuários.

---

## 4. CSRF e origem

Métodos mutantes exigem:

1. header `x-signalmess-request: 1`;
2. `Origin` igual a `APP_ORIGIN` (quando o header está presente).

O cookie `SameSite=Lax` já bloqueia a maioria dos POSTs cross-site; o header é a segunda
camada, porque `Lax` não cobre todos os navegadores e fluxos. Sem o header → `403`.

Testado em `tests/integration/auth-isolation.test.ts` (`CSRF and origin protection`).

---

## 5. Entrada

### 5.1 Validação

Todo corpo e toda query string passam por um schema zod antes do serviço. Não existe
handler que leia `c.req.json()` e use o valor diretamente.

Testes de schema: `tests/unit/schemas.test.ts` (30 casos).

### 5.2 SQL

Todas as queries usam parâmetros posicionais:

```ts
run(db, 'UPDATE investigations SET title = ? WHERE id = ?', [title, id])
```

Nenhuma concatenação de string com valor de usuário. O único SQL montado
dinamicamente são cláusulas `WHERE` a partir de uma **lista fixa** de colunas.

### 5.3 URLs

`isSafeHttpUrl` só aceita `http:` e `https:`. Isso bloqueia:

- `javascript:` (execução de script no contexto da página);
- `data:` (phishing embutido);
- `file:` (leitura local em alguns contextos).

Aplicado em dois pontos: validação de entrada de evidência e antes de renderizar qualquer
`<a href>` vindo de dados de provedor.

### 5.4 Conteúdo de fontes

A resposta da Exa pode conter HTML e instruções dirigidas a modelos ("ignore as regras
anteriores"). Tratamento:

1. `stripHtml` remove `script`, `style` e tags antes de exibir/armazenar;
2. no prompt, cada fonte vai dentro de `<fonte id="...">…</fonte>`;
3. a instrução de sistema diz explicitamente que o conteúdo é dado, não comando;
4. a saída do modelo é validada por schema — um desvio de instrução não vira estrutura
   aceita.

---

## 6. Segredos

| Segredo | Onde vive | Onde **não** vive |
| --- | --- | --- |
| `EXA_API_KEY` | ambiente do servidor | cliente, banco, export, logs |
| `GEMINI_API_KEY` | ambiente do servidor | cliente, banco, export, logs |
| `SESSION_SECRET` | ambiente do servidor | cliente |
| Token de sessão | cookie `HttpOnly` | `localStorage`, URL, resposta JSON |

Verificações automatizadas:

- `tests/integration/crud-export.test.ts` confirma que export JSON/CSV não contêm chaves
  nem `signalmess_session`;
- o teste de settings confirma que a resposta da API não inclui os valores das chaves;
- o teste E2E confirma que a interface não exibe nenhuma chave.

`.gitignore` cobre `.env`, `.env.*`, `.dev.vars*`, `*.pem`, `*.key`, `.data/` e `*.sqlite`.

---

## 7. Proteção de custo como controle de segurança

Uma cobrança não autorizada é um incidente tanto quanto um vazamento. Controles:

| Controle | Implementação | Teste |
| --- | --- | --- |
| Interruptor global | `ENABLE_EXTERNAL_APIS=false` por padrão; `assertUsable` em cada cliente | `blocks every provider call when external APIs are disabled` |
| Chave ausente | erro explícito citando a variável | `blocks the provider when the API key is missing` |
| Cota por usuário/dia | `usage.reserve` no backend | `enforces the per-user daily research limit` |
| Cota global/dia | idem | idem |
| Uma operação simultânea | single-flight por `userId:operation` | — (protegido no mesmo caminho) |
| Consulta duplicada | hash + janela configurável | `blocks an identical research query inside the duplicate guard window` |
| Sem retry automático | nenhum laço de tentativa nos clientes | testes de 401/429/500 verificam 1 requisição |
| Registro de bloqueios | `usage_records.status = 'blocked'` | `records blocked attempts so the operator can audit refusals` |

A cota é verificada **antes** da chamada e registrada **depois** — o registro acontece nos
dois desfechos, para que uma falha do provedor não consuma silenciosamente a cota sem
deixar rastro.

---

## 8. Erros e logs

### 8.1 Respostas

| Situação | Cliente recebe |
| --- | --- |
| Erro de validação | `400` + detalhes por campo |
| Sem sessão | `401` + mensagem de ação |
| Recurso de outro usuário | `404` |
| CSRF ausente | `403` |
| Cota esgotada | `429` + código `quota_exceeded` |
| Provedor 429 | `429` + código `provider_rate_limited` |
| Provedor 401/403 | `502` + código `provider_auth_failed` |
| Provedor lento | `504` + código `provider_timeout` |
| Exceção inesperada | `500` + mensagem genérica + `requestId` |

Nunca: stack trace, texto de SQL, caminho de arquivo, nome de variável de ambiente com
valor.

### 8.2 Logs

O que é registrado:
- método, caminho, status, `requestId`;
- mensagem de erro tipada.

O que **não** é registrado:
- corpos de requisição ou resposta;
- cookies, tokens, `Authorization`;
- chaves de API;
- e-mail ou conteúdo de evidência.

---

## 9. Ameaças consideradas

| Ameaça | Controle | Residual |
| --- | --- | --- |
| Acesso a dados de outro usuário | posse verificada no serviço; `404` | — |
| Enumeração de ids | ids com timestamp + 32 bits aleatórios; `404` uniforme | baixa |
| CSRF | header + origem + `SameSite` | — |
| XSS via conteúdo de fonte | sem `dangerouslySetInnerHTML`; `stripHtml`; React escapa por padrão | — |
| Open redirect no login | `next` só aceita caminho relativo same-origin | — |
| Força bruta no login | rate limit por sessão/rota | parcial (sem conta, sem bloqueio por IP) |
| Sequestro de sessão | cookie `HttpOnly` + `Secure`; token opaco; revogável | depende de HTTPS em produção |
| Prompt injection via fontes | delimitação + instrução de sistema + validação de schema | o modelo pode ainda ser influenciado; por isso a análise exige validação humana |
| Fabricação de referências | validação contra o conjunto real de ids | — |
| Cobrança não autorizada | interruptores, cotas, sem retry | — |
| Vazamento de segredo em export | export monta objeto com campos explícitos | — |
| Negação de serviço por operação longa | timeouts em todos os clientes | parcial |

---

## 10. O que fazer antes de expor publicamente

1. `NODE_ENV=production` com `SESSION_SECRET` de 32+ caracteres aleatórios (o app recusa
   subir sem isso).
2. HTTPS obrigatório (o cookie passa a `Secure` automaticamente).
3. Substituir o adaptador local pelo DeepSpace Auth.
4. Mover o rate limiting para um store compartilhado se houver mais de uma instância.
5. Definir `ENABLE_EXTERNAL_APIS=true` **somente** com chaves próprias e cotas revisadas.
6. Manter `ENABLE_PAID_OPERATIONS=false` a menos que o proprietário autorize por escrito.
