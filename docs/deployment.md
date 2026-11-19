# Gate de implantação

**Estado: NÃO IMPLANTADO.** Nenhum deploy, `push`, `app init`, billing ou contratação de
plano foi executado. Este documento é o relatório exigido antes de qualquer publicação e
**não** constitui autorização.

---

## 1. Plano atual do DeepSpace

| Item | Situação verificada |
| --- | --- |
| SDK/CLI `deepspace` | versão **0.44.2** (consultada no registro npm) |
| Sessão de CLI neste ambiente | **ausente** — `~/.deepspace/session` não existe; `auth whoami` não pôde autenticar |
| Conta autenticada | **desconhecida** (nenhuma sessão) |
| App registrado | **não** — nenhum `wrangler.toml`, nenhum `DEEPSPACE_APP_ID` |
| Origem de código | **não decidida** — e é uma decisão permanente no primeiro uso |
| Estado de cobrança | **desconhecido** — não consultado (exigiria sessão e dashboard) |

A documentação oficial (nov/2026) descreve o plano como hospedagem em Cloudflare Workers
for Platforms com URL `<nome>.app.space` e SSL, além de Auth, Records/DOs, arquivos R2,
secrets, cron e integrações. Os limites numéricos do plano gratuito **não estão publicados
nas páginas consultadas** — ver §3.

> Pendência explícita: qualquer número de quota gratuito precisa ser lido em
> <https://dashboard.deep.space> com a conta do proprietário, autenticado, na seção de
> plano/uso. Não invento esses números.

---

## 2. Quotas gratuitas identificadas

| Recurso | O que a documentação afirma | Status |
| --- | --- | --- |
| Hospedagem `app.space` | incluída; SSL incluído; URL de produção | **documentado** |
| Deploy | CLI + Workers for Platforms | **documentado** |
| Records (DO SQLite) | migrações aditivas automáticas; estado persiste entre deploys | **documentado** |
| Durable Objects | um conjunto de classes por app (6 no scaffold) | **documentado** (existência), limites **não** |
| Secrets | 128 por config, 32 KB por valor, 128 KB por config, 64 configs | **documentado** |
| Armazenamento R2 | bucket compartilhado por app; arquivos **não** são apagados no undeploy | **documentado** (comportamento), limite **não** |
| Integrações (proxy) | **cobradas dos créditos do proprietário** | **documentado** |
| Limite de créditos gratuitos | **não localizado** na documentação pública consultada | **pendente** |
| Necessidade de cartão | **não localizado** | **pendente** |

### Ponto crítico sobre integrações

A documentação de `external-apis` e o artigo sobre busca/geração de imagem descrevem o
**proxy de integração pago**, debitado dos créditos do proprietário. O briefing proíbe
usar esse proxy para Exa e proíbe IA gerenciada pela plataforma.

**Consequência para a arquitetura:** o SignalMesh **não** usa `tools.integration`, nem o
proxy de integrações, nem `deepspace/ai`. Ele chama `api.exa.ai` e
`generativelanguage.googleapis.com` diretamente dos módulos em
`server/integrations/`, com chaves no ambiente. Isso mantém a cobrança fora da plataforma
e sob controle do proprietário das chaves.

---

## 3. Limites que **não** foram verificados

Não afirmo nenhum destes valores. Todos precisam ser lidos no dashboard autenticado:

- [ ] Créditos gratuitos por mês (se houver) e o que consomem.
- [ ] Limite de requisições do worker / invocações por dia.
- [ ] Limite de operações de Durable Object e de tempo de CPU.
- [ ] Limite de armazenamento de Records (MB por app / por conta).
- [ ] Limite de armazenamento R2 e de transferência.
- [ ] Limite de apps por conta.
- [ ] Comportamento ao exceder: bloqueio, cobrança automática ou suspensão.
- [ ] Exigência de cartão de crédito para ativar o app.space.
- [ ] Suspensão por inatividade.
- [ ] Retenção de dados após undeploy (a doc diz que DO data é removido; R2 com arquivos não).

---

## 4. Condições de deploy

### 4.1 Pré-requisitos técnicos

- Node `>=22.15 <23 || >=24 <25 || >=26 <27` — ✅ 24.22.0 neste ambiente.
- `npx deepspace auth login` com GitHub ou Google — ❌ **não executado** (exige ação do
  proprietário em navegador).
- `npx deepspace auth whoami` confirmando a conta correta — ❌ impossível sem sessão.
- Primeiro commit limpo (deploy com source DeepSpace recusa worktree sujo) — ❌ não há
  repositório Git ainda.

### 4.2 Decisão de origem de código (permanente)

A documentação é explícita: **a origem trava no primeiro uso de fonte e não há como
desfazer.**

- Deploy a partir de um checkout com remote GitHub → trava **GitHub** permanentemente.
- `deepspace push`, ou deploy **sem** remote GitHub (incluindo `--no-push`) → trava
  **DeepSpace** permanentemente.

O briefing exige preservar a possibilidade de publicar usando **GitHub como fonte oficial**.
Portanto, na primeira publicação:

1. criar o repositório no GitHub;
2. `git remote add origin git@github.com:<org>/<repo>.git`;
3. `git push -u origin main`;
4. **só então** executar o primeiro deploy.

Se o primeiro deploy acontecer antes do passo 1–3, a origem DeepSpace fica travada e não
há volta. **Não executar `deepspace push` antes disso.**

### 4.3 Portabilidade da aplicação (o que falta para deployar)

O código foi escrito para portar sem reescrita de regra de negócio. O que ainda precisa ser
feito, e é trabalho de engenharia real, não um clique:

| Item | Esforço | Observação |
| --- | --- | --- |
| `wrangler.toml` com `DEEPSPACE_APP_ID`, DO bindings e migrations | baixo | modelo em `docs/database.md` |
| Substituir `@hono/node-server` pelo export `default app` do worker | baixo | `server/app.ts` já é um Hono puro |
| Adaptador de autenticação DeepSpace (JWT verificado) | médio | troca `requireUser`; toda autorização permanece |
| Adaptador de repositório DeepSpace Records | médio-alto | implementa `ports.ts` com `useQuery`/tools |
| Migrar SQLite → collections (dados existentes via export JSON) | médio | o export já existe e preserva relações |
| Rate limiting em store compartilhado | baixo | o atual é em memória |

Nenhum desses itens foi executado porque o gate de implantação exige autorização prévia.

---

## 5. Possíveis cobranças

| Vetor | Risco | Mitigação atual | Mitigação antes do deploy |
| --- | --- | --- | --- |
| Proxy de integrações DeepSpace | **não usado** | arquitetura evita o proxy | manter assim |
| IA gerenciada pela plataforma | **não usada** | chamadas diretas ao Gemini | manter assim |
| Excedente de créditos gratuitos | desconhecido | limites do app (3/dia/usuário) | revisar quotas no dashboard |
| Armazenamento de Records acima do gratuito | desconhecido | dados pequenos (texto) | monitorar uso |
| R2 acima do gratuito | baixo | app não usa upload de arquivos | — |
| Domínio customizado | cobrado | não solicitado | decidir com o proprietário |
| Exa acima do free tier | **real** | propósito: chaves próprias + $10/mês grátis | monitorar créditos na Exa |
| Gemini acima do free tier | **real** | free tier + 3 análises/dia/usuário | monitorar cota no AI Studio |

**Risco mais provável:** ultrapassar o crédito gratuito da **Exa** (US$ 10/mês), não a
plataforma. Com 8 resultados por pesquisa e contents habilitado, cada pesquisa consome
search + páginas. 3 pesquisas/dia/usuário × N usuários é o vetor. A mitigação existente
(`RESEARCH_DAILY_LIMIT`, `RESEARCH_GLOBAL_DAILY_LIMIT`) é suficiente para uma demonstração
com poucos usuários.

---

## 6. Riscos de ultrapassar quotas

| Cenário | Probabilidade | Impacto | Controle |
| --- | --- | --- | --- |
| Estouro de crédito Exa em demonstração pública | média | pesquisa para de funcionar; possível cobrança | limite global baixo (30/dia) + interruptor |
| Estouro de cota Gemini | média | análise para de funcionar | 30/dia global + 429 tratado |
| App suspenso por inatividade | desconhecida | URL sai do ar | verificar política antes de publicar |
| Perda de dados no undeploy | alta se usado | DO data removido | export JSON antes de qualquer undeploy |
| Cobrança por cartão não cadastrado | desconhecida | deploy recusado | verificar no dashboard |

---

## 7. Alternativas avaliadas (se a plataforma não permitir demonstração gratuita)

Avaliadas contra os critérios: gratuito comprovado, sem cartão, compatível com a
arquitetura, sem duplicar infraestrutura.

| Alternativa | Gratuito | Compatível | Veredito |
| --- | --- | --- | --- |
| **Cloudflare Workers + D1** | sim (plano free) | alto — o app já é Hono; D1 é SQLite | **melhor alternativa**: troca `node:sqlite` por D1, sem mudar serviços |
| Supabase Free (Postgres) | sim, com pausa por inatividade | médio — exige novo adaptador de banco | viável, mas adiciona latência e um segundo provedor |
| Fly.io / Render free | variável / já restrito | médio | menos previsível que Workers |
| VPS própria | não é gratuito | alto | descartado pelo requisito de custo zero |
| **Manter local** | sim | total | **estado atual**; demonstração via execução local |

**Recomendação:** se a plataforma exigir cobrança para demonstração pública, a alternativa
tecnicamente mais próxima é **Cloudflare Workers + D1** — mesma linguagem de runtime, mesmo
modelo de banco (SQLite), e o `server/app.ts` já é um Hono puro. A migração consistiria em
um adaptador D1 implementando `ports.ts` e o export do worker, sem tocar em regra de
negócio.

**Não** se deve migrar automaticamente. A plataforma é requisito do exercício; a decisão é
do proprietário.

---

## 8. Checklist do gate

Nenhum item abaixo foi marcado. A publicação só pode ocorrer com todos verdes e
autorização explícita do proprietário.

### Verificações técnicas (executadas)

- [x] Build de produção local funciona
- [x] 134 testes automatizados passam
- [x] 56 verificações E2E passam em navegador real
- [x] Auditoria de design sem problemas (39 páginas)
- [x] Nenhum segredo no repositório
- [x] `.gitignore` cobre `.env`, `.dev.vars`, banco local, chaves
- [x] Interruptores de custo desligados por padrão

### Ações do proprietário (pendentes)

- [ ] Criar/conectar conta DeepSpace e executar `auth login`
- [ ] Confirmar `auth whoami` com a conta correta
- [ ] Ler quotas e condições de cobrança no dashboard
- [ ] Decidir e criar o repositório GitHub **antes** do primeiro deploy
- [ ] Autorizar explicitamente o deploy
- [ ] Autorizar (ou negar) uso de operações cobráveis
- [ ] Definir as chaves `EXA_API_KEY` e `GEMINI_API_KEY` via secrets do backend
- [ ] Revisar limites diários para o público esperado

### Portabilidade (a executar após autorização)

- [ ] `wrangler.toml`
- [ ] Export do worker
- [ ] Adaptador de autenticação
- [ ] Adaptador de repositório
- [ ] Migração dos dados locais via export JSON
- [ ] Reexecutar a suíte contra o ambiente de produção

---

## 9. Estado final

| Afirmação | Verdadeiro? |
| --- | --- |
| O produto funciona localmente, ponta a ponta | **sim**, verificado |
| Está publicado no DeepSpace | **não** |
| Está publicado em qualquer outro lugar | **não** |
| Fez chamadas reais a Exa/Gemini | **não** |
| Gerou qualquer cobrança | **não** |
| Está pronto para deploy após autorização | **sim, com o trabalho de portabilidade de §4.3** |
