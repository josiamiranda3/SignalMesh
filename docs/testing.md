# Testes

Estratégia, o que cada suíte garante e os resultados reais obtidos neste ambiente.

---

## 1. Como executar

```bash
npm run typecheck       # tsc cliente + servidor
npm run lint            # eslint (zero avisos)
npm run test            # 134 testes (unit + integração)
npm run test:unit       # 70 testes
npm run test:integration # 64 testes
npm run test:e2e        # 56 verificações do fluxo principal
npm run test:flows      # 22 verificações de fluxos complementares
npm run audit:design    # auditoria de design em 3 viewports
npm run verify          # typecheck + lint + build + test
npm run verify:all      # verify + e2e + audit
```

Os testes de navegador exigem Chrome ou Edge instalado. Defina `CHROME_PATH` se estiver
em um local não padrão.

---

## 2. Por que `node:test` e CDP em vez de Vitest/Playwright

**Contexto do ambiente.** O sandbox de execução bloqueia scripts de pós-instalação e
processos que capturem stdio por pipe. Isso impediu:

- `vitest`, que depende de um binário que requer script de instalação;
- `playwright`, que requer download de navegadores.

**Solução.** `node:test` roda TypeScript nativamente via `--experimental-transform-types`,
sem bundler e sem binário. O navegador é o Chrome/Edge já instalado, controlado por
Chrome DevTools Protocol sobre WebSocket.

**Consequência.** Os testes exercitam o app real (Hono + middleware + serviços + SQLite +
React no navegador), não mocks de framework. É mais próximo de produção do que uma suíte
Playwright equivalente, embora com uma API de driver menor.

---

## 3. Testes unitários — 70

### 3.1 `tests/unit/relevance.test.ts` — 12 testes

Garante as propriedades prometidas do índice de priorização:

- resultado sempre em `[0,1]`;
- cada componente avaliado tem justificativa textual;
- fonte sem data → `recency = null` e aparece em `missing`;
- fonte recente pontua mais que fonte antiga em atualidade;
- data futura não é tratada como "frescor máximo";
- domínio institucional supera plataforma de conteúdo gerado por usuário;
- **marca famosa sem conteúdo e sem data não recebe qualidade alta**;
- pesos customizados são respeitados;
- índice parcial é renormalizado e declara isso;
- determinismo com clock fixo.

### 3.2 `tests/unit/analysis-contract.test.ts` — 12 testes

O contrato que sustenta a promessa central do produto:

- payload válido citando evidências reais é aceito;
- descoberta citando id inexistente é rejeitada;
- contradição citando id inexistente é rejeitada;
- `citedEvidenceIds` com id não enviado é rejeitado;
- descoberta sem nenhuma evidência é rejeitada;
- payload sem resumo executivo é rejeitado;
- confiança fora do enum é rejeitada;
- texto livre do modelo é rejeitado;
- citações são coletadas de descobertas **e** contradições;
- `insufficientEvidence` funciona sem inventar descobertas;
- o schema do Gemini declara os mesmos campos obrigatórios do contrato zod;
- o prompt inclui o objetivo, delimita fontes com `<fonte>`, proíbe inventar ids, proíbe
  escolher arbitrariamente entre contradições e **não contém credenciais**.

### 3.3 `tests/unit/sanitize.test.ts` — 20 testes

- normalização de URL: remove `utm_*`/`gclid`/fragmento/barra final, preserva query
  significativa, distingue `http` de `https` e caminhos diferentes;
- `isSafeHttpUrl` rejeita `javascript:`, `data:`, `file:`, `vbscript:`, `ftp:`;
- `stripHtml` remove `script`/`style` e decodifica entidades;
- extração de domínio, truncamento e janela de meia-noite UTC.

### 3.4 `tests/unit/schemas.test.ts` — 26 testes

- **regressão crítica:** um PATCH parcial não injeta defaults (o bug que apagava campos);
- cada campo pode ser atualizado isoladamente;
- update vazio é rejeitado;
- status inválido é rejeitado;
- trim de whitespace;
- defaults de criação são os documentados;
- mínimo de objetivo e máximo de título;
- evidence rejeita URLs não-http e `publishedAt` sem offset;
- research limita `numResults` a 20;
- validação aceita os quatro status e rejeita desconhecido;
- paginação coage de string e rejeita fora do intervalo;
- analysis rejeita subset com mais de 60 ids;
- export rejeita formato não suportado.

---

## 4. Testes de integração — 64

Sobem a aplicação real com banco em memória e um servidor mock que fala os formatos
documentados da Exa e do Gemini. Exercitam HTTP, cookies, CSRF, middleware e serviços.

### 4.1 `auth-isolation.test.ts` — 19 testes

| Grupo | Casos |
| --- | --- |
| autenticação | 401 em 4 rotas; cookie emitido; e-mail inválido com detalhes; logout revoga; cookie forjado rejeitado |
| CSRF/origem | sem header → 403; origem estranha → 403 |
| isolamento | leitura, update, delete, export, research e listagem entre dois usuários → 404/0; **nenhuma chamada ao provedor** na tentativa alheia; evidência e validação alheias → 404 |
| validação | justificativa obrigatória em rejeição e revisão; aprovação sem justificativa; histórico preserva 3 decisões com `previousStatus`; status repetido rejeitado |

### 4.2 `providers-and-quota.test.ts` — 28 testes

| Grupo | Casos |
| --- | --- |
| Exa | consulta montada do tema/objetivo; proveniência e disponibilidade; resultado vazio honesto; 401, 429, 500, JSON inválido, timeout; registro de falha; guarda de duplicata; repetição explícita |
| evidências | persistência com breakdown; duplicata por URL normalizada; skip em lote com motivo; URL perigosa rejeitada; marcação `alreadyAdded` ao repetir |
| Gemini | análise válida com referências reais; **referência fabricada rejeitada e registrada como failed**; schema inválido; recusa sem evidências; 403/429/503; truncamento rejeitado |
| custo | limite por usuário (research e analysis); snapshot de cota com reset; bloqueio global; chave ausente; registro de bloqueios |

### 4.3 `crud-export.test.ts` — 17 testes

| Grupo | Casos |
| --- | --- |
| CRUD | criar/ler/atualizar/arquivar; criação sem objetivo rejeitada; exclusão em cascata; filtro por status; busca por título; ordenação asc; parâmetro inválido rejeitado |
| dashboard | totais reais; soma por status = total; séries de 30 dias com zeros; tendência de investigações = total |
| histórico | ciclo completo registrado; persistência visível em nova sessão; feed global com total |
| export | JSON com relações íntegras (toda referência existe no pacote); escopo respeitado; CSV parseável com contagem de colunas consistente; nome de arquivo legível; `cache-control: no-store`; **sem credenciais/sessão**; evento registrado |
| settings | estado dos provedores sem expor chaves |

---

## 5. Testes de ponta a ponta — 78 verificações

### 5.1 Fluxo principal (`run-e2e.ts`) — 56 verificações

| Passo | Verificações |
| --- | --- |
| 1. Landing e autenticação | marca, proposta, redirect com `next`, login, nome na interface |
| 2. Estado vazio | empty state elaborado, **nenhum número fictício** |
| 3. Criação | formulário completo, redirecionamento para detalhe |
| 4. Pesquisa | resultados reais, domínio, disponibilidade, aviso de conteúdo parcial |
| 5. Evidências | confirmação, listagem, prioridade, status pendente |
| 6. Duplicação | resultado marcado "já adicionada", contagem não muda |
| 7. Análise | resumo, descobertas, contradições, limitações, lacunas, alinhamento, referências, modelo, **nenhuma referência inventada** |
| 8. Validação | aprovação com feedback; rejeição sem justificativa bloqueada; rejeição com justificativa |
| 9. Histórico | modal mostra status anterior e justificativa; feed global tem research/analysis/validation |
| 10. Exportação | formatos e escopos na interface; JSON 200 com content-type, gerador, investigação e evidências; CSV com linhas |
| 11. Configurações | provedores operacionais, registro de consumo, **nenhuma chave exposta** |
| 12. Isolamento | segundo usuário recebe `404` e lista vazia |
| 13. Logout | redireciona e mantém rota protegida fechada |
| Final | zero erros de runtime, zero erros de console |

### 5.2 Fluxos complementares (`run-flows.ts`) — 22 verificações

Cobre o que o fluxo principal não visita:

| Grupo | Verificações |
| --- | --- |
| A. Demo rotulada | investigação `[DEMONSTRAÇÃO]` marcada no dashboard e na listagem |
| B. Edição e arquivamento | modal edita o título; arquivar reflete; status volta para "em andamento" |
| C. Evidências | três fontes listadas; ausência de data declarada; nota persistida; filtro sem resultado mostra estado vazio; limpar restaura; busca filtra por título |
| D. Fila global | mostra pendentes; lista evidências de qualquer investigação; revisão com justificativa aparece na aba correta |
| E. Busca | investigação inexistente mostra estado próprio; limpar restaura |
| F. Exclusão | modal avisa irreversibilidade e quantifica o que será removido; redireciona |
| G. Erros | id inexistente mostra estado claro; zero erros |

---

## 6. Auditoria de design

`tests/e2e/design-audit.ts` mede no DOM real, em **13 rotas × 3 viewports** (desktop
1440px, tablet 834px, mobile 390px):

- **contraste WCAG AA** de cada nó de texto contra o fundo composto (considerando
  transparências);
- ordem de títulos e distribuição de tamanhos de fonte;
- overflow horizontal (ignorando contêineres com scroll próprio);
- texto cortado sem ellipsis;
- alvos de toque menores que 32px (ignorando links inline em prosa);
- gutters da página e paddings de card.

### Correções que a auditoria provocou

| Problema encontrado | Correção |
| --- | --- |
| `ink-faint` (#4a5368) em 2.59:1 | paleta recalculada: `ink-faint` → #818b9f (4.9:1) |
| `ink-subtle` e `ink-muted` abaixo de AA | elevados para #9aa6bd e #b3bdd1 |
| texto em 10–11px | mínimo elevado para 12px |
| seletores de largura fixa estourando no mobile | largura fluida com `sm:` |
| tabs com overflow no mobile | scroll horizontal contido e padding compensado |
| botões de 28×26px | 36–40px |
| checkboxes nativos de 14px | 18px dentro de label com 36px de altura |
| links inline de 14–18px de altura | `min-h-9` com `inline-flex` |

**Resultado final:** `Nenhum problema de design detectado.`

---

## 7. Resultados reais

Executados neste ambiente (Windows, Node 24.22.0):

```
typecheck (cliente)   ✅ sem erros
typecheck (servidor)  ✅ sem erros
lint                  ✅ 0 erros, 0 avisos
build                 ✅ 1707 módulos, 563 kB (162 kB gzip)
unit + integração     ✅ 134/134
e2e fluxo principal    ✅ 56/56
e2e fluxos             ✅ 22/22
auditoria de design   ✅ 0 problemas em 39 páginas
```

---

## 8. Limites desta suíte

1. **Nenhuma chamada real a provedor.** Por decisão de custo, a integração é exercitada
   contra um mock fiel ao formato documentado. Um teste real controlado exige chaves e
   autorização (ver `docs/api-integrations.md` §3.3).
2. **Rate limiting por minuto não é testado em carga.** A cota diária e o single-flight
   são; o limite de janela por minuto é verificado apenas por leitura de código.
3. **Sem teste de concorrência real** com múltiplos processos — o isolamento é testado com
   duas sessões simultâneas no mesmo processo.
4. **Sem teste de acessibilidade com leitor de tela.** Contraste, alvos, foco, ARIA e ordem
   de títulos são verificados; a experiência real com NVDA/VoiceOver não foi exercitada.
5. **Sem teste visual por diff de pixel.** A auditoria mede propriedades calculadas, não
   pixels; uma mudança puramente estética não quebra a suíte (por design — isso evita
   falsos positivos por antialiasing).
