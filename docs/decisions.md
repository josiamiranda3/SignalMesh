# Decisões técnicas

Registro das decisões que moldaram o projeto, com a alternativa descartada e o motivo.
Decisões não especificadas no briefing foram tomadas por conta própria e estão aqui para
serem contestáveis.

---

## D1. Backend Hono executado em Node, com adaptador para Workers

**Contexto.** O briefing pede Hono + Cloudflare Workers + SDK DeepSpace. O ambiente local
não tem sessão do DeepSpace (nenhum `~/.deepspace/session`) e a política de custo zero
proíbe operações que registrem ou implantem um app na plataforma antes da verificação de
quotas.

**Decisão.** O núcleo é um app Hono puro (`server/app.ts`) que não depende de APIs
exclusivas de Workers. O runtime local usa `@hono/node-server`; o caminho para Workers
está documentado e preparado (`docs/deployment.md`).

**Alternativa descartada.** Scaffold `create-deepspace` desde o início. Descartada porque
o primeiro comando que usa o app (`dev start`, `deploy`, `secrets set`) **registra o app
sob a conta autenticada** e pode definir permanentemente a origem do código. Fazer isso sem
verificar quotas e sem autorização violaria o gate de implantação. Além disso, o
scaffolder falhou neste ambiente por não conseguir executar scripts de pós-instalação.

**Consequência.** Toda a lógica de negócio, validação, autorização e integração é
portável. O que muda ao portar é o bootstrap e o adaptador de autenticação.

---

## D2. SQLite via `node:sqlite` em vez de um ORM

**Contexto.** É preciso persistência real, com transações, índices e chaves estrangeiras,
sem adicionar dependência compilada (o sandbox bloqueia scripts de instalação de binários).

**Decisão.** `node:sqlite` (nativo no Node 22+/24), com esquema declarativo e queries
parametrizadas em `server/repositories/sqlite.ts`.

**Alternativa descartada.**

- **Prisma/Drizzle:** exigem passo de geração/binário; o postinstall é bloqueado.
- **Supabase:** serviço externo; o requisito é local primeiro, e uma segunda infraestrutura
  de banco sem necessidade violaria "não instalar duas infraestruturas".
- **`better-sqlite3`:** módulo nativo compilado, bloqueado pelo ambiente.

**Consequência.** Zero dependência de banco, migração explícita e controle total do SQL. O
custo é escrever o mapeamento linha↔objeto manualmente — isolado em um único arquivo.

---

## D3. Camada de portas de repositório

**Contexto.** O briefing exige não acoplar regra de negócio ao DeepSpace Records.

**Decisão.** `server/repositories/ports.ts` define interfaces; `sqlite.ts` implementa. Os
serviços importam apenas as portas.

**Consequência.** Trocar o banco é escrever um adaptador novo. Nenhum serviço, rota ou
teste de regra de negócio muda. Verificado na prática: os testes de integração constroem o
app com um banco em memória sem tocar nos serviços.

---

## D4. Validação de referências da IA no servidor, não no prompt

**Contexto.** O modelo pode citar uma fonte que não existe. Instruir "não invente" reduz a
probabilidade, não elimina.

**Decisão.** Depois de receber a resposta, o servidor verifica **cada** `evidenceId` contra
o conjunto que foi efetivamente enviado. Violação → análise `failed`, erro `502`.

**Alternativa descartada.** Confiar no `responseSchema`. Ele garante formato, não
veracidade das referências. São riscos diferentes.

**Consequência.** Uma análise que cita fonte inexistente nunca chega ao usuário como
resultado. O teste `rejects an analysis that cites a fabricated evidence id` prova isso, e
verifica também que o registro persistido é `failed` com motivo.

---

## D5. Análises falhas são persistidas

**Contexto.** Se uma análise falha, o usuário pode ver apenas um toast e depois uma tela
vazia.

**Decisão.** Toda tentativa gera uma linha em `analyses` com `status: 'failed'` e
`errorMessage`. A interface mostra a seção "Tentativas não concluídas".

**Consequência.** O usuário entende o que aconteceu, e o operador distingue um problema de
provedor de um bug. Não há como confundir falha com resultado.

---

## D6. Sem retry automático em provedores

**Contexto.** Retry é prática comum contra instabilidade.

**Decisão.** Nenhum cliente repete uma chamada. O usuário repete conscientemente.

**Motivo.** Cada requisição à Exa e ao Gemini pode ser cobrada. Um laço de retry é uma
cobrança que o usuário não autorizou, e é exatamente o que a regra de custo zero proíbe.

**Consequência.** Um 429 ou 500 aparece como erro claro com ação sugerida. Os testes
verificam que apenas **uma** requisição chega ao mock.

---

## D7. Duas barreiras de custo independentes

**Decisão.** `ENABLE_EXTERNAL_APIS` (interruptor geral) e `ENABLE_PAID_OPERATIONS`
(autorização de cobrança) são variáveis separadas, ambas `false` por padrão.

**Motivo.** "Consegui configurar a chave" não é o mesmo que "autorizo gastar". Separar os
dois permite usar o free tier sem habilitar nada cobrável.

**Consequência.** No estado padrão, o produto é totalmente navegável e testável, e nenhuma
requisição sai para a rede.

---

## D8. Adaptador de autenticação local, com DeepSpace Auth como caminho de produção

**Contexto.** DeepSpace Auth é o mecanismo exigido, mas o ambiente local não tem sessão
de plataforma. Sem autenticação real, não é possível testar isolamento entre usuários — um
requisito de aceitação.

**Decisão.** Implementar um adaptador local de sessão (token opaco, hash no banco,
revogação, cookie `HttpOnly`), explicitamente rotulado na interface e **desativado em
produção**. O ponto de troca é `requireUser` + `auth-routes.ts`.

**Alternativa descartada.** Autenticação falsa em memória no cliente. Descartada: não
permitiria testar isolamento, revogação nem autorização no servidor — justamente os
requisitos mais críticos.

**Consequência.** O isolamento entre usuários é real e testado. A troca para DeepSpace Auth
substitui a resolução de identidade, mantendo toda a autorização existente.

---

## D9. `node:test` + Chrome DevTools Protocol em vez de Vitest + Playwright

**Contexto.** O sandbox bloqueia scripts de pós-instalação e processos que capturem stdio
por pipe; Playwright não consegue baixar navegadores.

**Decisão.** `node:test` (roda TypeScript nativamente) e um driver CDP de ~380 linhas
(`tests/e2e/cdp.ts`) controlando o Chrome/Edge já instalado.

**Alternativa descartada.** Vitest e Playwright — ambos falharam por limitação de ambiente,
não por preferência.

**Consequência.** Os testes exercitam o app real, sem bundler e sem mock de framework. O
custo é um driver menor que o do Playwright (sem espera automática sofisticada).

---

## D10. Auditoria de design por medição em vez de inspeção visual

**Contexto.** O agente não tem capacidade de visão neste ambiente; screenshots não podem
ser inspecionados.

**Decisão.** Construir uma auditoria que mede no DOM real: contraste WCAG (com composição
de transparência), overflow, texto cortado, alvos de toque, hierarquia e espaçamento.

**Consequência.** A auditoria encontrou problemas reais que uma revisão visual desatenta
perderia — incluindo contraste de 2.59:1 e botões de 28px. Ela também é uma proteção
contínua: cada alteração de UI é medida automaticamente.

**Limite reconhecido.** Medição não é gosto. Uma interface pode passar em todos os
critérios e ainda ser visualmente sem graça. As decisões estéticas (paleta, tipografia,
composição) foram tomadas deliberadamente e estão documentadas no código de tokens.

---

## D11. Paleta escura com quatro níveis de tinta

**Decisão.** Cinco superfícies (`canvas`, `base`, `surface`, `raised`, `overlay`) e quatro
níveis de tinta, todos acima de 4.5:1.

**Motivo.** A identidade pedida é grafite/azul escuro com profundidade. Quatro níveis
permitem hierarquia sem depender de bordas ou sombras.

**Consequência.** A primeira paleta usou `ink-faint: #4a5368`, que falhou em 2.59:1. Foi
substituída após a medição. O comentário no CSS registra o critério.

---

## D12. Sem gradientes em cards

**Decisão.** O único gradiente proeminente é a marca. O resto do produto usa cor sólida,
bordas hairline e sombras muito sutis.

**Motivo.** A instrução pede "não utilizar gradientes em excesso" e alerta contra interfaces
sobrecarregadas. Em um produto de pesquisa, o destaque deve ir para os dados.

**Consequência.** Profundidade vem de cinco níveis de superfície e de uma aurora fixa
extremamente discreta no fundo, não de efeitos por componente.

---

## D13. Schema de update separado do schema de criação

**Contexto.** `investigationCreateSchema.partial()` parecia a solução natural.

**Problema descoberto por teste.** O zod aplica `.default()` mesmo em chaves ausentes.
Portanto um PATCH com apenas `title` injetava `description: ''`, `keywords: []` e
`status: 'draft'` — apagando silenciosamente campos que o usuário não tocou.

**Decisão.** Definir os campos uma vez **sem** defaults, derivar criação (com defaults) e
atualização (`.partial()` sobre a base sem defaults).

**Consequência.** O bug foi corrigido e há um teste de regressão explícito. Este é o
exemplo mais claro de por que a suíte existe: o bug não produzia erro, apenas perda de
dados.

---

## D14. Limites de cota ajustáveis por preferência, mas subordinados ao servidor

**Decisão.** A tela de configurações permite ajustar preferências de limite; o valor
efetivo continua vindo da configuração do servidor.

**Motivo.** Satisfazer "pesos/limites configuráveis" sem permitir que o cliente aumente a
própria cota e, com isso, a própria cobrança.

**Consequência.** O ajuste é registrado como preferência e nunca ultrapassa o teto do
servidor.

---

## D15. Demo data atrás de flag explícita

**Decisão.** `SEED_DEMO_DATA=false` por padrão. Quando ativado, cria uma investigação com
título prefixado `[DEMONSTRAÇÃO]`, fontes fictícias em `example.org`, `source: 'demo'`,
nota explicativa e metadados marcados.

**Motivo.** O requisito é não apresentar dados fictícios como reais. Uma demo útil para
avaliação não pode se confundir com pesquisa.

**Consequência.** Um avaliador pode ver a interface populada sem risco de interpretar os
números como reais, e o comportamento padrão é honestamente vazio.

---

## D16. Exportação com escopo explícito

**Decisão.** `scope` obrigatório na query (`investigation` | `evidence` | `analyses` |
`validations` | `history`), com padrão `investigation`.

**Motivo.** Permitir extrair apenas o que interessa (por exemplo, planilha de evidências sem
o histórico) e deixar claro o que o arquivo contém.

**Consequência.** CSV e JSON compartilham a mesma noção de escopo, e o `meta` do JSON
registra qual foi usado.

---

## D17. O que **não** foi feito, deliberadamente

| Ausência | Motivo |
| --- | --- |
| Deploy na plataforma | Gate de implantação exige autorização do proprietário |
| `deepspace push` / `deploy` | Pode registrar o app e definir a origem do código permanentemente |
| Chamadas reais a Exa/Gemini | Regra de custo zero; nenhuma autorização financeira fornecida |
| IA gerenciada pela plataforma | Proibida explicitamente pelo briefing |
| Scraping de páginas | A Exa fornece conteúdo; scraping ampliaria risco e superfície |
| Compartilhamento entre usuários | Não especificado; implementá-lo sem modelo de permissão seria risco de privacidade |
| i18n | Interface em pt-BR por escopo |
| Editor rich-text | O produto trata integridade de evidência, não formatação |
