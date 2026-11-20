# Gate de implantação

**Estado: NÃO IMPLANTADO.** A auditoria de segurança da v0.2.1 corrigiu quatro defeitos reais (ver [audit-v0.2.1.md](audit-v0.2.1.md)); o app continua **não registrado** e a integração **não validada** em ambiente real. Nenhum `deepspace deploy`, `push`, `app init`, billing ou
contratação foi executado. O app **não está registrado** na plataforma: `wrangler.toml` ainda
carrega o placeholder `__APP_ID__`. Este documento é o relatório exigido antes de qualquer
publicação e **não** constitui autorização.

---

## 1. O que mudou na fase 2

| Item | Fase 1 | Fase 2 |
| --- | --- | --- |
| Runtime de produção | Hono em Node | **Cloudflare Worker** (`worker.ts`) |
| Persistência de produção | não definida | **DeepSpace Records** (Durable Object) |
| Autenticação de produção | não definida | **DeepSpace Auth** (JWT verificado) |
| `@hono/node-server` | único runtime | **ausente do bundle do Worker** |
| Runtime local | único | mantido para desenvolvimento e testes |
| Empacotamento do Worker | não testado | **verificado com wrangler** (17 checagens) |
| Execução em workerd | não testada | **SKIPPED neste ambiente** (ver §7) |
| App registrado | não | **não** |
| Origem do código | não decidida | **não decidida** |

A compatibilidade técnica mudou de "planejada" para "implementada e empacotável". O que
continua pendente é a parte que exige autorização, não engenharia.

---

## 2. Sessão e conta

| Item | Situação verificada |
| --- | --- |
| SDK/CLI `deepspace` | **0.44.2** instalado no projeto |
| Sessão de CLI | **ausente** — `~/.deepspace/session` não existe |
| Conta autenticada | **desconhecida** |
| `npx deepspace auth whoami` | não executado com sucesso (sem sessão) |
| App registrado | **não** — `DEEPSPACE_APP_ID = "__APP_ID__"` |
| Estado de cobrança | **desconhecido** — exigiria sessão e dashboard |

---

## 3. Quotas gratuitas identificadas

| Recurso | O que a documentação afirma | Status |
| --- | --- | --- |
| Hospedagem `app.space` | incluída; SSL incluído | **documentado** |
| Durable Objects | um conjunto de classes por app | **documentado** (existência); limites **não** |
| Records (DO SQLite) | migrações aditivas automáticas; estado persiste entre deploys | **documentado** |
| Secrets | 128 por config, 32 KB por valor, 128 KB por config, 64 configs | **documentado** |
| Assets estáticos | servidos pelo binding `ASSETS` | **documentado** (existência); limite **não** |
| Integrações (proxy) | **cobradas dos créditos do proprietário** | **documentado** |
| Créditos gratuitos | **não localizado** na documentação pública consultada | **pendente** |
| Necessidade de cartão | **não localizado** | **pendente** |

### Ponto crítico: nenhuma integração paga é usada

A plataforma oferece um proxy de integrações cobrado dos créditos do proprietário. O
SignalMesh **não o usa**: `tools.integration`, `deepspace/ai` e o endpoint
`/api/integrations` estão ausentes do código de negócio. Exa e Gemini são chamados
diretamente dos módulos em `server/integrations/`, com chaves próprias no ambiente.

Verificação: o bundle do Worker contém `api.exa.ai` e
`generativelanguage.googleapis.com` como URLs de fetch, e não contém chamadas ao proxy de
integrações.

---

## 4. Limites que **não** foram verificados

Não afirmo nenhum destes valores:

- [ ] Créditos gratuitos por mês e o que consomem.
- [ ] Invocações de Worker por dia.
- [ ] Operações de Durable Object e tempo de CPU.
- [ ] Requisições por segundo ao RecordRoom.
- [ ] Armazenamento de Records (MB por app / por conta).
- [ ] Tamanho máximo do bundle do Worker.
- [ ] Limite de apps por conta.
- [ ] Comportamento ao exceder: bloqueio, cobrança automática ou suspensão.
- [ ] Exigência de cartão para ativar o `app.space`.
- [ ] Suspensão por inatividade.
- [ ] Retenção de dados após undeploy.

**Risco específico desta arquitetura:** cada operação de dados é um subrequest ao Durable
Object. O código pagina agressivamente (200 linhas por chamada) para reduzir a contagem, mas
uma listagem de coleção grande gasta vários subrequests. Se a plataforma limitar subrequests
por requisição, o ponto de atenção é o dashboard (agrega várias coleções). Isso precisa ser
medido no ambiente real antes de definir os limites diários para um público maior.

---

## 5. Condições de deploy

### 5.1 Pré-requisitos técnicos

- [x] Node `>=22.15 <23 || >=24 <25 || >=26 <27` — 24.22.0 neste ambiente.
- [x] `deepspace@0.44.2` instalado.
- [x] `wrangler@4.79.0` instalado.
- [x] `worker.ts` empacota com `wrangler deploy --dry-run` (17 checagens passam).
- [x] `@hono/node-server` e o adaptador SQLite ausentes do bundle.
- [x] Nenhum segredo embutido no bundle.
- [x] 224 testes automatizados passam.
- [x] Build da SPA funciona.
- [ ] App registrado (`app init`) — **requer autorização**.
- [ ] Sessão de CLI válida — **requer ação do proprietário**.
- [ ] Execução ao vivo em workerd — **não possível neste ambiente** (ver §7).

### 5.2 Decisão de origem de código (permanente)

A documentação é explícita: **a origem trava no primeiro uso de fonte e não há como
desfazer.** Não existe setter, unclaim ou transferência.

- Deploy com remote GitHub → trava **GitHub** permanentemente.
- `deepspace push`, ou deploy **sem** remote GitHub (incluindo `--no-push`) → trava
  **DeepSpace** permanentemente.

O requisito do projeto é preservar a possibilidade de usar **GitHub como fonte oficial**.
Portanto, na primeira publicação:

1. criar o repositório no GitHub;
2. `git remote add origin git@github.com:<org>/<repo>.git`;
3. `git push -u origin main`;
4. **só então** `npx deepspace app init` e o primeiro deploy.

**Não execute `app init` nem `deploy` antes dos passos 1–3.** Este é o ponto de não retorno.

### 5.3 Comandos que serão executados (e o que cada um faz)

Nenhum destes foi executado. Cada um precisa de autorização explícita.

| Comando | Efeito | Reversível |
| --- | --- | --- |
| `npx deepspace auth login` | abre o navegador; cria `~/.deepspace/session` | sim (logout) |
| `npx deepspace app init` | **registra o app e minta o `DEEPSPACE_APP_ID`**; grava em `wrangler.toml` | **não** (id é permanente) |
| `npx deepspace secrets set EXA_API_KEY=…` | grava segredo no store; primeira escrita também **registra o app** | sim (delete) |
| `npx deepspace deploy` | **trava a origem do código**; publica em `<nome>.app.space` | parcial (undeploy tira do ar; origem permanece) |
| `npm run migrate:records` | copia dados locais para o app implantado | sim (não apaga origem) |

### 5.4 Trabalho técnico restante após autorização

| Item | Esforço | Observação |
| --- | --- | --- |
| Registrar o app | baixo | decisão permanente de origem |
| Definir secrets | baixo | `secrets set`, depois deploy |
| Verificar em workerd | baixo | `npm run test:worker` em ambiente que permita o runtime |
| Verificar o RecordRoom real | médio | o fake não é o binário do SDK; validar RBAC e `uniqueOn` reais |
| Executar a migração de dados | baixo | `migrate:records --dry-run` primeiro |
| Ajustar limites diários ao público | baixo | `wrangler.toml` |

Nenhum desses itens é uma reescrita: a arquitetura já está no formato da plataforma.

---

## 6. Possíveis cobranças

| Vetor | Risco | Mitigação atual |
| --- | --- | --- |
| Proxy de integrações | **não usado** | arquitetura evita o proxy |
| IA gerenciada pela plataforma | **não usada** | chamadas diretas ao Gemini |
| Excedente de créditos | desconhecido | `RESEARCH_GLOBAL_DAILY_LIMIT=30`, `ANALYSIS_GLOBAL_DAILY_LIMIT=30` |
| Subrequests ao RecordRoom | desconhecido | paginação de 200 linhas por chamada |
| Armazenamento de Records | desconhecido | dados são texto; sem upload de arquivos |
| R2 | baixo | o app não usa upload |
| Domínio customizado | cobrado | não solicitado |
| Exa acima do free tier | **real** | chaves próprias + US$ 10/mês grátis + limites |
| Gemini acima do free tier | **real** | free tier + 3 análises/dia/usuário |

**Risco mais provável:** ultrapassar o crédito gratuito da **Exa**, não a plataforma. Com 8
resultados por pesquisa e contents habilitado, cada pesquisa consome search + páginas. Os
limites existentes são suficientes para uma demonstração; para uso aberto é preciso revisar.

---

## 7. Execução em workerd: por que não foi verificada

`npm run test:worker` verifica o **empacotamento** (17 checagens, todas passam) e tenta a
**execução ao vivo**. A execução ao vivo reporta `SKIPPED` neste ambiente.

**Evidência de que é limitação de ambiente, não do código:**

1. Um Worker **mínimo de controle** — `export default { async fetch() { return new
   Response('ok') } }`, sem dependências, sem Durable Object — falha com a mesma mensagem:
   `*** std::terminate() called with no exception` / "The Workers runtime failed to start".
2. Um caminho de falha independente foi reproduzido: o wrangler não consegue escrever em
   `.wrangler/tmp` fora do workspace ("Acesso negado").

**Consequência para o gate:** antes de publicar, `npm run test:worker` deve ser executado em
um ambiente que permita ao workerd criar subprocessos e escrever seus bundles temporários.
Até lá, o status honesto é: **empacotamento verificado, execução em runtime de produção não
verificada**.

---

## 8. Alternativas avaliadas

Se a plataforma não permitir demonstração gratuita:

| Alternativa | Gratuito | Compatível | Veredito |
| --- | --- | --- | --- |
| **Cloudflare Workers + D1** | sim (plano free) | **alto** — o Worker já é Hono; D1 é SQLite | **melhor alternativa**: um adaptador D1 sobre `ports.ts`, sem tocar em serviço |
| Supabase Free | sim, com pausa por inatividade | médio — novo adaptador, segundo provedor | viável |
| Manter local | sim | total | estado atual; demonstração por execução local |

A migração para D1 seria menor do que foi a migração para Records: o esquema SQL já existe
em `server/db.ts`, e o adaptador só precisaria de um cliente D1.

**Não migrar automaticamente.** A plataforma é requisito do exercício; a decisão é do
proprietário.

---

## 9. Checklist do gate

### Verificado (executado)

- [x] Worker empacota com `wrangler deploy --dry-run`
- [x] Durable Object e manifesto presentes no bundle
- [x] `verifyJwt` presente; nenhuma emissão de JWT
- [x] `@hono/node-server` ausente do bundle
- [x] Adaptador SQLite tree-shaken do bundle
- [x] Nenhum segredo embutido no bundle
- [x] Interruptores de custo lidos em runtime, default `false`
- [x] 224 testes automatizados passam
- [x] 56 + 22 verificações em navegador real passam
- [x] Auditoria de design sem problemas
- [x] Migração de dados idempotente e testada
- [x] `.gitignore` cobre `.env`, `.dev.vars`, `.wrangler*`, banco local

### Pendente de ação do proprietário

- [ ] Criar/conectar conta DeepSpace e executar `auth login`
- [ ] Confirmar `auth whoami`
- [ ] Ler quotas e condições de cobrança no dashboard
- [ ] Decidir e criar o repositório GitHub **antes** do primeiro `app init`
- [ ] Autorizar o registro do app (permanente)
- [ ] Autorizar (ou negar) `ENABLE_EXTERNAL_APIS=true`
- [ ] Definir `EXA_API_KEY` e `GEMINI_API_KEY` via `secrets set`
- [ ] Revisar limites diários para o público esperado
- [ ] Autorizar o deploy

### Pendente de execução

- [ ] `npm run test:worker` em ambiente que permita workerd
- [ ] Validar o RecordRoom real (RBAC, `uniqueOn`, paginação)
- [ ] Medir subrequests por requisição no app implantado
- [ ] `migrate:records --dry-run` e depois a migração real

---

## 10. Estado final

| Afirmação | Verdadeiro? |
| --- | --- |
| A aplicação funciona localmente, ponta a ponta | **sim**, verificado |
| O runtime de produção é um Cloudflare Worker | **sim**, empacotado e verificado |
| O Worker executa em workerd | **não verificado neste ambiente** |
| O Worker usa DeepSpace Auth | **sim**, implementado e testado unitariamente |
| Os dados usam DeepSpace Records | **sim**, implementado e testado por paridade |
| O RecordRoom real foi exercitado | **não** — só o fake fiel ao contrato |
| Está publicado no DeepSpace | **não** |
| Fez chamadas reais a Exa/Gemini | **não** |
| Gerou qualquer cobrança | **não** |
| App registrado na plataforma | **não** |
| Pronto para deploy após autorização | **sim**, com as verificações de §9 |
