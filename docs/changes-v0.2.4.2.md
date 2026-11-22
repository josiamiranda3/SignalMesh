# Alterações — v0.2.4.2

Melhoria funcional pontual sobre a v0.2.4.1: cadastro manual de evidências na interface e
correção da procedência gravada nas exportações.

Nenhuma integração externa foi acionada. Nenhuma dependência foi adicionada ou atualizada.
Autenticação, autorização, isolamento multiusuário, DeepSpace Auth, Records e Worker não
foram tocados.

---

## 1. O problema

Duas falhas distintas, ambas confirmadas na inspeção da v0.2.4.1:

**Não havia como cadastrar evidência sem provedor.** O endpoint
`POST /api/investigations/:id/evidence` existia, autenticado e testado, mas nenhuma tela o
chamava. O único caminho de criação era *Pesquisar → Adicionar como evidência*, que depende da
Exa. Com `ENABLE_EXTERNAL_APIS=false`, a pesquisa recusa com 503 — logo, **nenhuma evidência
podia ser criada pela interface**.

**Toda evidência era rotulada como `exa`.** `server/services/evidence.ts:57` gravava
`source: 'exa'` como constante em `buildEvidence`, que serve os dois caminhos. Uma fonte
digitada à mão saía nas exportações JSON e CSV indistinguível de um resultado de pesquisa.

---

## 2. Procedência: o que foi decidido e por quê

**Inspeção prévia.** O tipo é `Evidence.source: string` (livre), a coluna no RecordRoom é
`text` sem restrição e o SQLite guarda `TEXT`. Não havia enum a respeitar — a liberdade do
campo permitiu corrigir sem migração de schema.

**A origem passa a ser decidida pelo caminho de chamada**, não por uma constante:

| Caminho | Quem chama | `source` |
| --- | --- | --- |
| `addMany` (bulk) | somente a tela de pesquisa, com dados da resposta da Exa | `'exa'` |
| `addOne` | entrada manual | `'manual'` |

`buildEvidence` recebeu um parâmetro `origin: EvidenceOrigin` (`'exa' | 'manual'`), e
`sourceMetadata` ganhou a chave `origin` como registro redundante e explícito. A coluna
`source` continua sendo o rótulo grosso que a exportação e a UI leem.

**Compatibilidade com registros existentes.** Nenhuma linha histórica foi reescrita. As três
evidências já presentes em `.data/signalmess.sqlite` continuam legíveis, com `source` válido e
`sourseMetadata` sem a chave `origin` — o código novo não exige a chave. Reescrever o passado
falsificaria a trilha de auditoria, e `'exa'` continua sendo um valor válido para aquelas
linhas, criadas quando o rótulo era esse.

Uma consequência honesta: a evidência manual que criei durante a inspeção da v0.2.4.1
permanece rotulada `exa`. Não é um bug remanescente — é a política de não reescrever história.

---

## 3. Interface

Na página `/investigations/:id/evidence`:

- Botão **"Adicionar evidência manual"** no cabeçalho, ao lado de *Pesquisar mais*.
- O mesmo botão no estado vazio, agora com duas opções (manual ou pesquisa) em vez de só
  pesquisa.
- Modal com os cinco campos pedidos: título (obrigatório), URL (obrigatória), trecho/descrição,
  autor e data de publicação (opcionais).

**Validação sem duplicar regras.** O formulário usa `evidenceCreateSchema` de
`shared/schemas.ts` — o mesmo objeto que o servidor aplica. As mensagens de erro chegam ao
campo correspondente (`source.title` → `title`). Não há uma segunda cópia das regras para
divergir da primeira.

**Detalhes de implementação que valem registro:**

- `<input type="date">` devolve `YYYY-MM-DD`; o contrato exige ISO com offset, então a data é
  ancorada em `T00:00:00.000Z` em vez de enviada crua.
- Duplicata não é erro: o servidor responde 200 com `duplicate: true` e a UI informa que a
  fonte já existia, em vez de fingir que criou.
- Após salvar, a lista atualiza por `reload()` do `useAsync` — o padrão que a página já usava
  para nota e exclusão. Sem recarga manual.
- Erro de servidor aparece no toast **e** no diálogo, para não se perder num aviso transitório.
- Componentes, classes e o `Modal` existentes foram reutilizados; nenhum estilo novo.

---

## 4. Arquivos modificados

| Arquivo | Mudança |
| --- | --- |
| `server/services/evidence.ts` | `buildEvidence` recebe `origin`; `addOne` grava `manual`, `addMany` grava `exa`; `sourceMetadata.origin`; descrições de atividade distinguem a origem |
| `src/pages/EvidencePage.tsx` | botão no cabeçalho e no estado vazio; `ManualEvidenceModal`; `addManualEvidence`; estado `manualOpen`/`manualErrors` |
| `package.json`, `package-lock.json`, `server/app.ts` | versão `0.2.4.2` |
| `tests/integration/evidence-manual.test.ts` | novo, 23 testes |
| `README.md`, `docs/testing.md` | contagem e descrição da suíte |

Nada mais foi tocado. `worker.ts`, `auth-resolver.ts`, `csrf-policy.ts`, `action-routes.ts`,
`schemas.ts` e o `Modal` compartilhado permanecem byte a byte iguais à baseline.

---

## 5. Testes executados

### Suíte automatizada completa

```
typecheck (cliente)      ✅ 0 erros
typecheck (servidor)     ✅ 0 erros
lint                     ✅ 0 erros, 0 avisos
unit + integração + contrato ✅ 463/463   (baseline: 440)
```

**463 = 440 + 23 novos.** Nenhum teste existente foi alterado ou removido.

### `tests/integration/evidence-manual.test.ts` — 23 casos

Contra HTTP real e SQLite real (o mesmo assembly que o navegador usa):

| Grupo | Casos | Cobre |
| --- | --- | --- |
| Entrada válida | 3 | criação, campos opcionais, domínio derivado da URL |
| Campos obrigatórios | 4 | título ausente, título vazio, URL ausente, título longo |
| URL inválida | 3 | `javascript:`, `data:`, relativa/malformada/`ftp:` |
| Procedência | 4 | manual ≠ exa; `sourceMetadata.origin`; **exa preservado no bulk**; ambas no mesmo registro |
| Persistência | 2 | releitura pelo banco; contadores do dashboard |
| Isolamento | 3 | B não escreve em A; B não lê A; anônimo recebe 401 |
| Duplicatas | 2 | retorna existente; detecta variação com `utm_*` |
| Exportação | 2 | `source: "manual"` no JSON; `manual` na linha do CSV |

### Verificação no navegador (manual, não automatizada)

Executada com o servidor em `127.0.0.1:8787` e o driver CDP:

| Verificação | Resultado |
| --- | --- |
| Botão presente no estado vazio | ✅ |
| Modal abre com os 5 campos | ✅ |
| URL `javascript:` recusada inline | ✅ |
| Salvamento com URL válida | ✅ linha aparece na lista, diálogo fecha, toast "Evidência adicionada" |
| Erros de página / console | ✅ 0 / 0 |
| Modal em 390×844 | ✅ aberto, submetido, linha visível, sem overflow horizontal |

As capturas estão em `tests/e2e/artifacts/inspect-1[5-8]-*.png`.

### O que **não** foi testado

- **Sem teste automatizado de UI.** O diálogo foi verificado manualmente pelo driver CDP; a
  suíte `run-e2e.ts` não ganhou um caso novo. Um teste de regressão de interface exigiria
  alterar `run-e2e.ts`, o que preferi não fazer sem necessidade declarada.
- **Workerd e DeepSpace real:** não executados, como nas versões anteriores.
- **Navegador e empacotamento do Worker** exigem execução fora do confinamento do sandbox
  (`docs/validation-v0.2.4.1.md`).

---

## 6. Achado não corrigido

Durante a verificação em viewport móvel, `smallTargets()` acusou **um** alvo de 28×28: o botão
"Fechar" do `Modal` compartilhado (`src/components/ui/Modal.tsx:118`, `size-7`).

Não foi introduzido aqui — o modal de observação, o de exclusão e o de confirmação usam o
mesmo componente desde antes desta versão. A correção (elevar para 44×44 ou ampliar a área de
toque) altera um componente compartilhado e afeta todas as telas, o que excede o escopo desta
melhoria. **Documentado, não corrigido.**

---

## 7. Confirmação de ausência de integração externa

- `ENABLE_EXTERNAL_APIS` e `ENABLE_PAID_OPERATIONS` permanecem `false`.
- Nenhuma chamada a `api.exa.ai` ou `generativelanguage.googleapis.com`.
- `addOne` não toca em `ExaClient` nem em `GeminiClient` — só valida, pontua relevância
  localmente e grava.
- Nenhum secret lido, escrito ou configurado.
- Nenhum `app init`, `deploy`, `push`, registro ou migração.
- O servidor local rodou apenas em `127.0.0.1`.
