# Bot financeiro no Telegram — design

- **Data:** 2026-09-04
- **Status:** aprovado, pronto para o plano de implementação
- **Projeto:** `denobot`

## 1. Objetivo

Um bot de Telegram que registra entradas e saídas de dinheiro numa planilha do Google Sheets, roda como servidor **stateless** em Deno, e permite consultar saldo e últimos lançamentos.

### No escopo

- Registrar um lançamento a partir de um valor digitado, classificado como entrada ou saída.
- Descrição opcional do lançamento ("qual foi o gasto?").
- Interpretar valores em formatos mistos de vírgula e ponto, e recusar com clareza o que não entender.
- Consultar saldo do mês corrente e acumulado geral.
- Listar os últimos lançamentos, com paginação.
- Oferecer um botão que abre o WhatsApp com o lançamento pronto para ser compartilhado num grupo.
- Restringir o uso a uma lista de IDs autorizados do Telegram.

### Fora do escopo

- OCR de notas fiscais e upload de arquivos (existe no bot Python anterior; foi cortado deliberadamente).
- Envio automático para o WhatsApp — ver a decisão D4.
- Edição ou exclusão de lançamentos já gravados.
- Categorias fixas: a descrição é texto livre.
- Múltiplas contas ou moedas.

## 2. Decisões de arquitetura

### D1 — Webhook, não long polling

Long polling exige um processo vivo permanentemente, incompatível com serverless. O bot recebe updates por webhook HTTPS.

**Consequências que o design precisa absorver:**

- O Telegram serializa updates por chat: só entrega o próximo depois que respondermos. Isso evita corridas, mas impõe pressa.
- Se não respondermos, o Telegram **reentrega** o mesmo update — daí a idempotência da seção 4.
- `webhookCallback` do grammY aplica timeout de 10s. Nenhuma operação longa pode viver no caminho da requisição.
- Free tier do Deno Deploy dá 50ms de CPU por request. Chamadas ao Sheets são I/O e não contam; a assinatura RSA conta, e por isso o access token é cacheado.

### D2 — grammY como framework

`npm:grammy` roda sem modificação no Deno e tem adapter para `Deno.serve` (`webhookCallback(bot, "std/http")`). A alternativa (parsear `Update` na mão) custaria reescrever roteamento, tipos e teclados sem ganho proporcional.

### D3 — Google Sheets via Service Account (JWT bearer, RFC 7523)

Num servidor stateless não há onde persistir com segurança o refresh token de um OAuth de usuário, nem quem faça o consentimento. Usamos service account:

1. Service account criada no GCP, com a chave JSON (`client_email` + `private_key` PKCS#8) em variável de ambiente.
2. **A planilha é compartilhada com o `client_email` como Editor.** Sem esse passo, toda chamada retorna 403.
3. A cada cold start monta-se um JWT RS256 (Web Crypto, sem dependências) trocado por um `access_token` de 3600s em `https://oauth2.googleapis.com/token`.

Escopo: `https://www.googleapis.com/auth/spreadsheets`.

### D4 — WhatsApp por link de compartilhamento, não por API

Investigado e descartado o envio automático:

- **API oficial (Meta Cloud API — Groups API):** exige Official Business Account, limita o grupo a **8 participantes**, e os grupos precisam ser **criados pela própria API** — não existe endpoint para adicionar participante. Não há como postar num grupo de WhatsApp que já existe.
- **Bibliotecas não-oficiais (Baileys, whatsapp-web.js):** conseguem postar em grupos existentes, mas mantêm uma sessão WebSocket persistente pareada a um número. Isso exige um processo 24/7 com estado em disco — incompatível com o stateless — e carrega risco de banimento do número por violação dos ToS.

**Solução adotada:** o bot inclui um botão de URL apontando para `https://wa.me/?text=<mensagem urlencoded>`. Tocar o botão abre o WhatsApp com o texto pronto e a lista de conversas para escolher; o usuário toca no grupo e confirma. É o gesto de compartilhar entre apps.

**Limitação conhecida e aceita:** não é possível pré-selecionar um grupo específico. Grupos não têm número (o formato `wa.me/<número>` só endereça pessoas) e o link de convite `chat.whatsapp.com/...` não aceita texto pré-preenchido. Na prática o grupo aparece no topo da lista por ser recente.

Em troca: custo zero, risco zero, nenhum serviço extra, e o bot continua stateless.

### D5 — A planilha é a única fonte de verdade

Não há banco de dados. O estado de conversa viaja no `callback_data` dos botões e no `reply_to_message` das respostas. `/saldo` lê as colunas `A:C` e soma em TypeScript.

Para um controle familiar (ordem de milhares de linhas ao longo de anos) isso é I/O de ~100 KB de JSON, bem longe do limite de CPU.

**Caminho de evolução, se necessário:** Deno KV para deduplicar `update_id`, cachear o access token entre isolates e memorizar o saldo. É aditivo — pluga trocando a implementação de uma função, sem reescrever o resto.

## 3. Módulos

```
main.ts                    Deno.serve + webhookCallback + validação do secret token
bot.ts                     grammY: middlewares (allowlist) e handlers
lib/money.ts               parse e formatação de valores          <- puro, sem rede
lib/render.ts              textos, teclados, link wa.me            <- puro, sem rede
lib/google_auth.ts         JWT RS256 -> access_token, com cache
lib/sheets.ts              cliente REST do Sheets (append/get/update)
lib/ledger.ts              domínio: registrar, saldo, extrato
scripts/set_webhook.ts     registro do webhook (roda uma vez)
scripts/bootstrap_sheet.ts cria a aba e o cabeçalho
```

**Fronteiras:**

- `money.ts` e `render.ts` não tocam rede. É onde mora a lógica que mais erra e a que mais compensa testar.
- `ledger.ts` conhece apenas `sheets.ts`; expõe `registrar()`, `descrever()`, `saldo(mes)`, `extrato(offset, limite)`.
- `bot.ts` não sabe o que é HTTP nem o que é Google Sheets.
- `google_auth.ts` é a única peça que lida com criptografia.

## 4. Modelo de dados

Aba **`Lançamentos`**, com cabeçalho na linha 1:

| Coluna | Campo | Tipo enviado | Observação |
|--------|-------|--------------|------------|
| A | Data | string ISO `2026-09-04 14:32:00` | reconhecida em qualquer locale |
| B | Tipo | `Entrada` \| `Saída` | o sinal vive aqui, não no valor |
| C | Valor | **número JSON** (`50.5`) | sempre positivo |
| D | Descrição | string | pode ficar vazia |
| E | Quem | string | `first_name` de quem lançou |
| F | update_id | número | controle de idempotência |

### Duas decisões que evitam bugs de locale

- **Valor vai como número JSON, não string.** Um número nativo no corpo JSON não passa pelo parser de texto do Sheets, ficando imune ao locale da planilha. Enviar `"50,00"` ou `"50.00"` como string seria interpretado de formas diferentes conforme o idioma da planilha.
- **Data vai como string ISO** com `valueInputOption=USER_ENTERED`. O Sheets reconhece ISO 8601 independentemente do locale; a formatação de exibição fica a cargo da planilha.

### Idempotência

Antes de gravar, o bot lê os últimos 20 valores da coluna F. Se o `update_id` corrente já estiver lá, é reentrega do Telegram e a gravação é ignorada (o bot ainda responde normalmente ao usuário). Custa um GET por lançamento e elimina a linha duplicada.

### Endpoints usados

- Gravar: `POST /v4/spreadsheets/{id}/values/Lançamentos!A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
- Ler: `GET /v4/spreadsheets/{id}/values/{range}`
- Atualizar descrição: `PUT /v4/spreadsheets/{id}/values/Lançamentos!D{linha}?valueInputOption=USER_ENTERED`

O `append` responde com `updates.updatedRange` (ex.: `Lançamentos!A42:F42`), de onde sai o número da linha — usado para a descrição posterior.

## 5. Parsing de valores

Aplicado depois de remover `R$`, espaços e capturar um sinal opcional.

| Situação | Regra | Exemplos |
|----------|-------|----------|
| Contém `.` **e** `,` | o **último** separador é o decimal, o outro é milhar | `1.234,56` -> 1234.56 · `1,234.56` -> 1234.56 |
| Um só tipo de separador, repetido | milhar | `1.234.567` -> 1234567 |
| Um só separador, 1 ou 2 dígitos depois | decimal | `50,5` -> 50.5 · `50.55` -> 50.55 |
| Um só separador, exatamente 3 dígitos depois | milhar | `1.234` -> 1234 · `1,234` -> 1234 |
| Qualquer outro caso | erro | `50,5555` · `12..3` · `1.23.4` |

**Rejeições adicionais:** zero, valor negativo, e valores acima de R$ 1.000.000 (proteção contra dedo gordo).

**Ambiguidade assumida:** `1.234` é genuinamente ambíguo entre mil duzentos e trinta e quatro (pt-BR) e um vírgula duzentos e trinta e quatro (en-US). Resolvemos pelo contexto pt-BR: milhar.

**Rede de segurança:** o bot sempre ecoa a interpretação antes de gravar qualquer coisa (`R$ 1.234,00 — entrada ou saída?`). Nenhuma linha é escrita sem que o usuário veja o valor interpretado e confirme com um toque.

### Classificação de mensagens de texto

Uma mensagem de texto que chega ao bot é classificada em três casos mutuamente exclusivos, nesta ordem:

1. **É resposta a um `Qual foi o gasto? #42`** (tem `reply_to_message` com o marcador) -> é descrição. Nunca passa pelo parser de valores.
2. **Contém ao menos um dígito** -> é tentativa de valor. Se parseia, segue o fluxo de registro; se não, o bot pede para digitar de novo (seção 6.5).
3. **Não contém dígito algum** (`oi`, `bom dia`) -> não era um valor. O bot responde só uma dica curta de uso, sem `force_reply`.

Sem essa separação, toda saudação no chat viraria uma cobrança de valor.

## 6. Fluxos de interação

### 6.1 Registrar um lançamento

```
você:  50
bot:   R$ 50,00 — entrada ou saída?
       [ ⬇️ Entrada ]  [ ⬆️ Saída ]
você:  (toca Saída)
bot:   ✅ Saída de R$ 50,00 · 04/09
       [ ✏️ Qual foi o gasto? ]
       [ 📤 Compartilhar ]
```

A linha é gravada **no toque do botão**, não no fim do fluxo. Nada se perde se o usuário abandonar a conversa.

### 6.2 Descrição opcional

A pergunta acompanha o tipo do lançamento: uma **saída** teve um gasto, uma
**entrada** teve uma fonte. O botão muda de rótulo junto (`✏️ Qual foi o gasto?`
/ `✏️ Qual a fonte?`), e o tipo viaja no `callback_data` (`d|42|S`, `d|42|E`) —
o botão precisa saber disso sozinho, porque o toque chega como um update
separado. O tipo é opcional na decodificação, então botões emitidos antes desta
mudança seguem válidos.

```
você:  (toca ✏️)
bot:   Qual foi o gasto? #42          (saída)
bot:   Qual a fonte do dinheiro? #42  (entrada)
       (campo de resposta abre sozinho)
você:  mercado
bot:   ✅ Saída R$ 50,00 · mercado
       [ 📤 Compartilhar ]
```

O botão ✏️ dispara uma **nova** mensagem com `force_reply` — `force_reply` e teclado inline não coexistem na mesma mensagem. O número da linha viaja no texto (`#42`) e volta pelo `reply_to_message.text`, sem nenhum byte de sessão armazenado.

### 6.3 Saldo

```
/saldo

📅 Setembro/2026
  Entradas   R$ 2.000,00
  Saídas     R$   350,00
  Resultado  R$ 1.650,00

Σ Acumulado geral  R$ 4.820,00

[ ◀️ Agosto ]  [ 📄 Extrato ]
```

Mês corrente em destaque, acumulado geral abaixo. O botão de mês anterior navega para trás; ao sair do mês corrente aparece também o botão de avançar.

### 6.4 Extrato

```
/extrato

04/09  ⬆️    50,00  mercado    Bruno
03/09  ⬇️  2.000,00  salário    Bruno
02/09  ⬆️    32,90  farmácia   Ana
... (10 mais recentes)

[ ⬇️ Ver mais 10 ]
```

### 6.5 Valor não reconhecido

```
você:  50,5555
bot:   ❌ Não entendi "50,5555" como valor.

       Manda de novo — aceito assim:
          50        50,90       1.234,56
          R$ 12,30  1234.56
       (campo de resposta abre sozinho)
```

O bot responde com `force_reply` e `input_field_placeholder: "valor, ex.: 50,90"`, reabrindo o teclado. A nova tentativa é apenas outra mensagem de texto: cai no fluxo normal e é parseada de novo. Se falhar outra vez, repete.

**Sem contador de tentativas** — não há onde guardar, e o loop é inofensivo porque só dispara quando o usuário escreve algo.

## 7. Estado no `callback_data`

O Telegram limita `callback_data` a 64 bytes. Todo o estado de conversa cabe aí:

| Botão | `callback_data` | Notas |
|-------|-----------------|-------|
| Entrada / Saída | `n\|E\|5000` / `n\|S\|5000` | valor em **centavos**, inteiro: curto e sem float |
| ✏️ Qual foi o gasto? | `d\|42` | linha devolvida pelo `append` |
| ◀️ mês anterior | `m\|2026-08` | |
| ⬇️ Ver mais | `x\|20` | offset |
| 📤 Compartilhar | — | botão `url`, não callback: `https://wa.me/?text=...` |

Valores em centavos como inteiro evitam qualquer questão de ponto flutuante na serialização e mantêm o payload curto.

## 8. Tratamento de erros

| Situação | Comportamento |
|----------|---------------|
| Valor ilegível | mensagem com formatos aceitos + `force_reply` (seção 6.5) |
| Sheets 403 | "não consegui gravar" + a mensagem cita explicitamente que a planilha precisa estar compartilhada com a service account — é a causa quase certa |
| Sheets 429 / 5xx | "não consegui gravar, tenta de novo"; corpo do erro vai para o log |
| Token expirado | renovação transparente dentro de `getAccessToken()` |
| Usuário fora da allowlist | **silêncio total**, sem resposta, para não confirmar a existência do bot |
| Exceção não tratada | log + resposta **HTTP 200** ao Telegram |

**O 200 é deliberado.** Devolver 500 faz o Telegram reentregar o update indefinidamente, transformando um erro pontual num loop.

## 9. Segurança

O webhook é uma URL pública. Três camadas:

1. **`secret_token` no `setWebhook`** — o Telegram passa a enviar o header `X-Telegram-Bot-Api-Secret-Token` em toda requisição; o handler rejeita quem não o apresenta. O grammY faz essa verificação via a opção `secretToken` do `webhookCallback`.
2. **Path não-óbvio** — servir em `/webhook` ou um caminho aleatório, nunca na raiz.
3. **Allowlist de `from.id`** — apenas IDs autorizados operam o bot; os demais recebem silêncio.

**Exceção temporária ao silêncio (cadastro).** Enquanto a família não estiver
toda cadastrada, uma mensagem de texto de quem não está na allowlist recebe de
volta o próprio ID do Telegram, e o admin — o primeiro ID de
`ALLOWED_USER_IDS` — recebe um aviso. Sem isso, descobrir o ID de alguém exige
um bot de terceiros e um copia-e-cola. O custo é que um estranho que ache o bot
descobre que ele existe, e pode gerar aviso repetido para o admin (o bot é
stateless e não lembra quem já pediu). Toque em botão e demais updates seguem em
silêncio. Vive isolado em `lib/onboarding.ts`, ligado por uma costura opcional
(`DepsBot.aoNegar`) cujo padrão é o silêncio original; o arquivo documenta como
removê-lo.

Segredos vivem exclusivamente em variáveis de ambiente. A chave da service account nunca entra no repositório.

### Marcação nas mensagens (revisão de 05/09/2026)

Por padrão **nenhuma mensagem usa `parse_mode`**: descrição e nome de exibição
são texto livre do usuário, e sem marcação não há o que escapar.

**Exceção, para as duas tabelas.** `/saldo` e `/extrato` vão dentro de `<pre>`
com `parse_mode: "HTML"`. A fonte padrão do Telegram é proporcional, então
`padEnd`/`padStart` não alinham coluna alguma — o alinhamento existia no código
e não na tela, verificado em captura real. Para uma tabela de valores, alinhar é
requisito de leitura.

Mitigação do custo: `escaparHTML` converte `&`, `<` e `>` — os três caracteres
que o modo HTML do Telegram trata — e **toda** interpolação de texto do usuário
nessas duas mensagens passa por ele. A ordem importa: trunca primeiro e escapa
depois (o inverso partiria uma entidade ao meio), e o `&` é substituído antes
dos outros dois. Um teste tenta injetar `<b>` e `</pre>` pela descrição e pelo
nome; outro exige `parse_mode` no envio, porque o defeito de não propagá-lo mora
em `bot.ts` e nenhuma asserção de `render.ts` o alcançaria.

As colunas do extrato têm largura própria (`COL_DESCRICAO`, `COL_QUEM`), menor
que os limites gerais de exibição: coluna fixa é o que torna a tabela legível, e
o escape pode quintuplicar um texto, o que estouraria o teto de 4096 caracteres
numa página cheia.


## 10. Configuração

| Variável | Conteúdo |
|----------|----------|
| `BOT_TOKEN` | token do @BotFather |
| `WEBHOOK_SECRET` | string aleatória, `A-Za-z0-9_-`, até 256 chars |
| `PUBLIC_URL` | `https://<app>.deno.dev` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | conteúdo do JSON da service account, em uma linha |
| `SPREADSHEET_ID` | o ID que aparece na URL da planilha |
| `ALLOWED_USER_IDS` | IDs do Telegram separados por vírgula |

## 11. Testes

`deno test`, sem acesso à rede por padrão.

- **`money.ts`** — tabela exaustiva cobrindo cada linha da seção 5, os malformados, e a classificação de mensagens da seção 5 (tentativa de valor vs. não-valor). É o teste mais importante do projeto.
- **`render.ts`** — formatação em pt-BR (separador de milhar, duas casas) e *encoding* do link `wa.me`: acentos e quebras de linha na descrição são o ponto de falha.
- **`ledger.ts`** — contra um fake de `sheets.ts`: saldo do mês vs. acumulado, virada de mês, mês sem lançamentos, planilha vazia, extrato ordenado e paginado.
- **`google_auth.ts`** — monta o JWT e verifica header, claims e assinatura com `crypto.subtle.verify`.
- **Integração** — um teste contra uma planilha de sandbox real, marcado com `ignore: true` por padrão, rodado manualmente.

## 12. Deploy

1. `@BotFather` -> criar o bot, obter o token.
2. GCP -> habilitar a Google Sheets API, criar a service account, baixar a chave JSON.
3. Criar a planilha e **compartilhá-la com o `client_email` como Editor**.
4. `deno task bootstrap-sheet` -> cria a aba `Lançamentos` e o cabeçalho.
5. `deno task dev` + túnel (`cloudflared` / `ngrok`) para testar o webhook localmente.
6. Deploy no Deno Deploy; variáveis de ambiente pelo dashboard.
7. `deno task set-webhook` apontando para a URL de produção.
8. Verificar com `getWebhookInfo` — o campo `last_error_message` é o melhor lugar para depurar.

**Nota de plataforma:** o Deno Deploy Classic será desligado em 20/07/2026. O projeto nasce direto na plataforma nova.

## 13. Riscos conhecidos

| Risco | Mitigação |
|-------|-----------|
| `1.234` interpretado como milhar quando o usuário queria decimal | eco de confirmação antes de gravar |
| Reentrega de update pelo Telegram duplicando linha | dedupe por `update_id` na coluna F |
| Planilha não compartilhada com a service account (403) | mensagem de erro que nomeia essa causa |
| Grupo do WhatsApp não pré-selecionado | aceito; grupo recente aparece no topo da lista |
| Crescimento da planilha degradando `/saldo` | só a partir de dezenas de milhares de linhas; caminho de evolução é o Deno KV (D5) |
