# Auditoria integrada — v0.2.4.3

Auditoria de segurança, compatibilidade DeepSpace e internacionalização.
Nenhuma operação externa, paga, de registro ou de deploy foi executada.

> Este documento cobre o trabalho de auditoria. A entrega funcional da v0.2.4.3
> (proteção financeira) está em
> [changes-v0.2.4.3.md](changes-v0.2.4.3.md), preservado como registro histórico.

---

## 1. Internacionalização (en / pt-BR)

Tradução completa da interface. Inglês é o padrão; português do Brasil é alternativo.

| Item | Detalhe |
| --- | --- |
| Catálogos | `src/i18n/en.json` e `src/i18n/pt-BR.json` — **771 chaves cada**, paridade exata |
| Mecanismos | `I18nProvider`, `t()`, `translate.ts` (fora de React), `locales.ts`, `active.ts` |
| Tipagem | `TranslationKey` derivada de `en.json`; chave inexistente é erro de compilação |
| Persistência | `localStorage` (`signalmess.locale`); `<html lang>` sincronizado |
| Formatação | `Intl` por locale, cacheado; `RelativeTimeFormat` para tempo relativo |
| Gemini | `outputLanguage` no schema, enviado pelo cliente — só afeta o **texto da análise** |

Nenhum dado dinâmico é traduzido: títulos de investigação, evidências, fontes, URLs e
descrições de log permanecem como gravados.

---

## 2. Segurança da superfície de ações

### 2.1 Bearer Token obrigatório

`POST /api/actions/:name` é montada numa instância Hono própria, **antes** de `createApp`,
e portanto nunca passou pelo `csrfGuard`. Aceitar cookie ali permitia CSRF num endpoint
privilegiado.

Correção: `worker.ts` usa `resolveBearerIdentity`, que lê **apenas** `Authorization: Bearer`.
A rota também rejeita 401 antes de qualquer trabalho quando não há header — defesa em
profundidade, para o caso de outro chamador montar a rota.

### 2.2 `deleteWhere` no `ActionToolsPort`

O transporte (`RecordStore`) já tinha `deleteWhere`; a porta não o expunha, então nenhuma
ação alcançava a operação. Adicionado com validação:

- filtro vazio recusado (seria exclusão ilimitada);
- tipo de valor do filtro validado;
- `limit` positivo, com teto de **500**;
- erro marcado como `invalid` antes de tocar o transporte.

### 2.3 Resolução segura de nomes de ação

`actions[name]` percorre a cadeia de protótipos, então `constructor`, `__proto__` e
`toString` resolviam para funções reais. Substituído por `lookupOwn` do próprio SDK
(`deepspace/worker`), seguido da allowlist `ALLOWED_ACTIONS`.

Severidade real: com a allowlist avaliada primeiro, o furo era **latente**, não explorável
— dependia de duas listas permanecerem sincronizadas. A correção remove a dependência.
O SDK descreve o mesmo padrão na migração `2026-11-route-param-lookups`.

---

## 3. DeepSpace

| Item | Estado |
| --- | --- |
| Manifesto de migrações | `deepspace.migrations.json` criado — 6 aplicadas, 6 não aplicáveis |
| App ID no cliente | validado contra `/^app_[0-9A-HJKMNP-TV-Z]{26}$/`; fallback `local-dev` |
| Bundle | `__APP_ID__` ausente do artefato |
| App registrado | **não** — `DEEPSPACE_APP_ID = "__APP_ID__"` |
| Worker em `workerd` | **não executado** — binário não inicia neste ambiente |

As 6 migrações não aplicáveis (`files-session-cookie-reads`, `ai-sdk-7`,
`integrations-sign-in`, `agent-tool-context`, `public-page-seo`, `composio-user-billing`)
descrevem superfícies que o SignalMesh não possui. A ausência é justificada e testada em
`tests/integration/migrations-manifest.test.ts`.

---

## 4. Roteamento do Worker

`assets.not_found_handling = "none"`, `/api/*` e `/ws/*` em `run_worker_first`, SPA
resolvida por `/index.html`, 404 JSON para arquivo ausente. Coberto por
`tests/integration/worker-routing.test.ts` — que executa a regra de fallback contra um
`ASSETS` falso e afirma as decisões no código-fonte, sem alegar execução no `workerd`.

---

## 5. SEO e exposição

Aplicação **privada**. Trilho adotado:

- `public/robots.txt` com `Disallow: /` e as rotas privadas listadas uma a uma;
- `<meta name="robots" content="noindex, nofollow">` no shell (a diretiva exige que a
  página seja rastreável para ser lida);
- `<html lang>` corrigido de `pt-BR` para `en`, o padrão do produto.

Não há `sitemap.xml`: não existem páginas públicas a enumerar. Publicar uma landing
indexável é **decisão de produto pendente**, não um requisito técnico.

---

## 6. Acessibilidade

Todo controle interativo passou a ter alvo mínimo de **44×44** CSS px (WCAG 2.5.8 pede 24,
mas 36–38 px é desconfortável no toque). Alterações:

- escala de `Button` (`sm`/`md`/`lg`/`icon`) com `min-h-11`–`min-h-12`;
- itens de navegação da sidebar;
- botão de abrir/fechar menu, sair e recolher;
- links de breadcrumb, "ver todas", "ver investigação" e o link de retorno.

Verificado em 390, 768 e 1440 px: **zero alvos reais abaixo de 44×44**.

---

## 7. Correções de conteúdo encontradas por testes de E2E

| Item | Antes | Depois |
| --- | --- | --- |
| Título da seção de descobertas | usava a chave de "pontos relevantes" | `findingsTitle` ("Principais descobertas") |
| Botão de exclusão | "Excluir permanentemente" | "Excluir definitivamente" (cópia original) |
| Botão de revisão | "Revisão" (substantivo) | "Revisar" (verbo de ação) |

Os dois suites de E2E foram escritos antes da i18n e afirmam texto em português; passaram a
**fixar o locale** (`localStorage`) no início, preservando cada asserção em vez de reescrevê-las.

---

## 8. Verificação

| Verificação | Resultado |
| --- | --- |
| typecheck (cliente + servidor) | 0 erros |
| lint | 0 erros, 0 avisos |
| check:encoding | 185 arquivos OK |
| check:design (tokens/contraste) | OK |
| build | OK |
| suíte unit + integração + contrato | **739/739** |
| E2E principal | **56/56** |
| Fluxos complementares | **22/22** |
| Worker — empacotamento | **17/17** |
| Worker — execução no `workerd` | **não executado** (limitação do ambiente) |
| Auditoria de design | 22 avisos, todos de alvos em drawer fora da tela |

---

## 9. Desvios encontrados durante a auditoria (não corrigidos)

Dois pontos violam premissas da missão. Ambos são **estado preexistente**, não alteração
desta auditoria — e nenhum foi tocado, porque corrigi-los exigiria mudar configuração que
o proprietário definiu.

### 9.1 `.env` local com os dois interruptores em `true`

`ENABLE_EXTERNAL_APIS=true` e `ENABLE_PAID_OPERATIONS=true` no `.env` local (herdado de uma
etapa anterior, a pedido explícito). Isso contraria a regra 9 da missão.

Escopo real do risco:

| Superfície | Valor | Lido de |
| --- | --- | --- |
| Worker (produção) | `false` / `false` | `wrangler.toml` `[vars]` + secrets da plataforma |
| Node local (dev/testes) | `true` / `true` | `.env` via `server/dev.ts` |

O Worker **não lê `.env`** — verificado: nenhuma referência a dotenv em `wrangler.toml` ou
no caminho de configuração do Worker. Portanto a configuração de produção continua correta
e as duas travas seguem ativas onde importam.

Durante esta auditoria: **0 chamadas a provedor** no ledger (`usage_records` e `analyses`
ambos em 0). Nenhuma chamada paga ocorreu.

Recomendação: voltar ambos para `false` no `.env` antes de qualquer sessão manual de
desenvolvimento. Não foi feito aqui porque alterar `.env` está fora do escopo autorizado.

### 9.2 Remoto GitHub configurado

`origin` aponta para `https://github.com/josiamiranda3/SignalMesh.git`. Isso **resolve** a
pendência de origem de código registrada em `docs/deployment.md` §5.2: o primeiro deploy
agora travaria **GitHub**, que é o requisito do projeto.

Ressalva: o remoto não é acessível a partir deste ambiente (`SEC_E_NO_CREDENTIALS`), então
não foi possível confirmar que ele existe no servidor nem que o push já ocorreu. Nenhuma
operação Git de escrita foi executada.