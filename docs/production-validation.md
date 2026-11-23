# Validação manual em produção

**Aplicação:** https://signalmess.app.space  
**Projeto:** SignalMesh  
**Versão do repositório:** 0.2.4.3  
**Tipo de registro:** validação manual relatada pelo proprietário da aplicação.

Este documento registra os fluxos que foram exercitados na aplicação publicada. Os resultados
abaixo refletem as observações fornecidas pelo responsável pelo teste; não representam uma
auditoria independente nem um teste de carga.

---

## 1. Acesso e autenticação

| Fluxo | Resultado observado |
|---|---|
| Abrir a aplicação publicada | Sucesso |
| Carregar o dashboard sem refresh manual | Sucesso |
| Encerrar sessão (logout) | Sucesso |
| Entrar novamente (login) | Sucesso |

## 2. Pesquisa real com Exa

Consulta utilizada:

```text
autenticação multifator bancos digitais Brasil
```

Resultado relatado:

| Métrica | Resultado |
|---|---:|
| Resultados retornados | 5 |
| Fontes selecionadas | 2 |
| Custo informado pela interface/provedor | US$ 0.0120 |

As 2 fontes selecionadas foram adicionadas à investigação como evidências.

## 3. Análise real com Google Gemini

| Métrica | Resultado |
|---|---:|
| Modelo | `gemini-2.5-flash` |
| Tokens informados | 5,017 |
| Uso exibido | `1 de 3` |

A análise foi concluída na aplicação publicada após a pesquisa e a inclusão das evidências.

## 4. Persistência e atualização em tempo real

O responsável pelo teste confirmou que os dados permaneceram disponíveis após as operações
e que as atualizações em tempo real funcionaram no fluxo exercitado.

Isso sustenta a afirmação de que os fluxos testados de gravação, leitura e atualização foram
funcionais no ambiente de produção naquele momento.

## 5. O que esta validação demonstra

Com base nos fluxos descritos, há evidência manual de que:

- a aplicação publicada estava acessível;
- os fluxos básicos de autenticação funcionaram;
- uma pesquisa real foi executada via Exa;
- resultados puderam ser selecionados e registrados como evidências;
- uma análise real foi executada via Gemini;
- persistência e atualizações em tempo real funcionaram no cenário exercitado.

## 6. O que esta validação não demonstra

Este registro não comprova:

- disponibilidade contínua ou SLA;
- comportamento sob carga ou alto volume;
- recuperação de falhas ou disaster recovery;
- isolamento testado entre múltiplos usuários;
- exclusividade de reservas de cotas sob requisições simultâneas no Durable Object real;
- precisão factual das conclusões produzidas pelo modelo;
- ausência absoluta de vulnerabilidades.

A validação de concorrência precisa de um teste simultâneo reproduzível no ambiente de produção,
com registro dos pedidos concorrentes e dos resultados. Não inferir essa garantia apenas a partir
da persistência e das atualizações em tempo real.

## 7. Relação com os relatórios históricos

O relatório [audit-integrada-v0.2.4.3.md](audit-integrada-v0.2.4.3.md) documenta uma etapa
anterior de auditoria e deve permanecer preservado como registro histórico. Ele não deve ser
reescrito para parecer que os testes de produção atuais ocorreram naquela etapa.

O documento [changes-fechamento.md](changes-fechamento.md) descreve a implementação de reserva
de cotas e a limitação de validação do adaptador Records em runtime. Esta validação manual
posterior confirma persistência e fluxo de aplicação, mas não substitui um teste concorrente
específico.
