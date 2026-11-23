# Implantação e operação em produção

**Estado atual: publicado e acessível.**

- Aplicação: https://signalmess.app.space
- Plataforma: DeepSpace sobre Cloudflare Workers
- Identificador da aplicação: `app_01M81TNJ1N7E1R12364FQK4WCK`
- Entry point do Worker: `worker.ts`
- Persistência de produção: DeepSpace Records / Durable Object `AppRecordRoom`
- Autenticação de produção: DeepSpace Auth
- Comando de implantação definido no projeto: `npm run deploy`

Este documento descreve o estado operacional conhecido. Ele não substitui o painel da plataforma
para verificar a configuração atual de secrets, permissões, cobrança ou histórico de deploy.

---

## 1. Estado validado

O proprietário informou e executou validações diretamente na aplicação publicada:

| Verificação | Resultado relatado |
|---|---|
| Aplicação abre no endereço de produção | OK |
| Dashboard carrega sem atualização manual | OK |
| Logout | OK |
| Login novamente | OK |
| Pesquisa real via Exa | OK |
| Seleção e inclusão de resultados como evidências | OK |
| Análise real via Gemini | OK |
| Persistência dos registros | OK |
| Atualizações em tempo real | OK |

Os detalhes e números observados estão registrados em
[production-validation.md](production-validation.md).

**Limite da afirmação:** os testes acima comprovam os fluxos efetivamente exercitados. Eles não
devem ser interpretados como prova de carga, disponibilidade contínua, recuperação de desastre,
ou exclusividade sob concorrência no Durable Object.

## 2. Configuração da aplicação

As configurações não secretas conhecidas do projeto são:

| Variável | Valor esperado/conhecido |
|---|---|
| `DEEPSPACE_APP_ID` | `app_01M81TNJ1N7E1R12364FQK4WCK` |
| `APP_NAME` | `signalmess` |
| `APP_ORIGIN` | `https://signalmess.app.space` |
| `EXA_SEARCH_TYPE` | `auto` |
| `GEMINI_MODEL` | `gemini-2.5-flash` |
| `RESEARCH_DAILY_LIMIT` | `3` |
| `ANALYSIS_DAILY_LIMIT` | `3` |
| `RESEARCH_GLOBAL_DAILY_LIMIT` | `30` |
| `ANALYSIS_GLOBAL_DAILY_LIMIT` | `30` |
| `DUPLICATE_GUARD_SECONDS` | `90` |

Os interruptores de integração e operação paga são:

- `ENABLE_EXTERNAL_APIS`
- `ENABLE_PAID_OPERATIONS`

O proprietário relatou que ambos estão habilitados na configuração de produção durante a
validação das integrações. O arquivo `wrangler.toml` recebido no pacote de código contém
`false` para ambos. Portanto, existe uma divergência entre o arquivo versionado e a configuração
de produção relatada. **Confirme os valores no painel DeepSpace antes de qualquer novo deploy.**
Não faça deploy apenas para tentar sincronizar esses valores: habilitar operações pagas pode
gerar custos.

## 3. Secrets

Nomes de secrets utilizados pelo backend:

- `EXA_API_KEY`
- `GEMINI_API_KEY`

Os valores devem existir exclusivamente no armazenamento seguro de secrets da plataforma.
Nunca devem ser incluídos em `wrangler.toml`, `.env` versionado, README, logs, commits,
capturas de tela ou mensagens.

O ZIP do repositório não permite verificar se os valores estão atualmente cadastrados na
plataforma. A validação de chamadas reais demonstra que as integrações funcionaram no momento
do teste, mas não substitui uma conferência atual do painel de secrets.

## 4. Persistência e Durable Object

O Worker utiliza o binding `RECORD_ROOMS`, associado à classe `AppRecordRoom`.
A configuração declarada no projeto inclui a migração `v1` da classe SQLite do Durable Object.

A aplicação publicada foi exercitada com gravação e leitura dos dados e com atualizações em
tempo real. Isso confirma o funcionamento dos fluxos usados durante a validação manual.

A garantia de exclusividade da reserva de cotas sob duas requisições simultâneas no Durable
Object real é uma questão separada. O relatório de fechamento documenta o desenho com índice
único e a limitação histórica de validação em runtime. Não anuncie essa garantia como testada
em produção sem um teste concorrente reproduzível e registrado.

## 5. Procedimento de deploy

O script oficial do projeto é:

```bash
npm run deploy
```

Ele executa `deepspace deploy`. Não substitua esse procedimento por comandos diretos do Wrangler
sem uma decisão técnica explícita.

Antes de executar:

1. Confirme que está no repositório correto e na branch esperada.
2. Confira `git status` e revise todas as alterações não commitadas.
3. Confirme o destino e a origem do código no painel/CLI DeepSpace.
4. Confirme o estado dos secrets no painel, sem imprimir seus valores.
5. Confirme `ENABLE_EXTERNAL_APIS` e `ENABLE_PAID_OPERATIONS`.
6. Avalie se o deploy pode alterar configuração de produção ou gerar custos.
7. Só então execute `npm run deploy`.

Após o deploy, abra a aplicação publicada e repita os fluxos críticos: autenticação, dashboard,
pesquisa, inclusão de evidências, análise, histórico e persistência.

## 6. Cuidados operacionais

- Não execute `npm run deploy` apenas para publicar alterações de documentação.
- Um deploy de configuração pode alterar o comportamento das integrações e dos controles de
  custo.
- Não coloque chaves de API em comandos que possam ficar registrados no histórico do terminal.
- Não compartilhe tokens, cookies, JWTs ou valores de secrets.
- Não trate um build local como validação de produção.
- Não trate uma validação manual de poucos fluxos como teste de carga ou SLA.
- Registre data, ambiente, operação, resultado e evidência de cada validação.

## 7. Referências

- [README](../README.md)
- [Integrações externas](api-integrations.md)
- [Validação de produção](production-validation.md)
- [Fechamento de concorrência de cotas](changes-fechamento.md)
- [Auditoria integrada v0.2.4.3 — registro histórico](audit-integrada-v0.2.4.3.md)
