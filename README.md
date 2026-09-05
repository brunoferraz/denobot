# denobot

Bot de Telegram para controle de entradas e saídas numa planilha do Google Sheets. Roda stateless em
Deno: sem banco de dados, sem sessão — o estado de conversa viaja no `callback_data` dos botões e no
`reply_to_message` das respostas.

> **Atenção:** a planilha precisa ser compartilhada com o `client_email` da service account, como
> **Editor**, antes de qualquer coisa funcionar. Sem isso, toda chamada ao Sheets responde `403`.
> Veja o passo 3 de [Configuração](#configuração).

## Como se usa

Mande um valor para o bot:

```
você:  50
bot:   R$ 50,00 — entrada ou saída?
       [ ⬇️ Entrada ]  [ ⬆️ Saída ]
você:  (toca Saída)
bot:   ✅ Saída de R$ 50,00 · 04/09 · Bruno
       [ ✏️ Qual foi o gasto? ]
       [ 📤 Compartilhar ]
```

O botão **Compartilhar** abre o WhatsApp com o texto pronto; você escolhe o grupo e confirma.

Formatos de valor aceitos: `50` · `50,90` · `50.90` · `1.234,56` · `1,234.56` · `R$ 12,30`. Um
separador com três dígitos depois é lido como milhar (`1.234` = mil duzentos e trinta e quatro). O
bot sempre ecoa a interpretação antes de gravar.

Comandos: `/saldo` (mês corrente + acumulado) e `/extrato` (últimos 10).

## Configuração

1. `@BotFather` → criar o bot, guardar o token.
2. Google Cloud → habilitar a **Google Sheets API**, criar uma service account, baixar a chave JSON.
3. Criar a planilha, renomear a aba para `Lançamentos`, e **compartilhá-la com o `client_email` da
   service account como Editor**. Sem isso, tudo responde 403.
4. `cp .env.example .env` e preencher.
5. `deno task bootstrap-sheet` → grava o cabeçalho. Este script não cria a aba `Lançamentos` — ela
   precisa já existir com esse nome exato, ou o comando falha.
6. `deno task dev` + um túnel (`cloudflared tunnel --url http://localhost:8000`).
7. `PUBLIC_URL=<url do túnel> deno task set-webhook`.

## Deploy

Deno Deploy, com as variáveis de ambiente pelo dashboard. Depois do deploy, rode `set-webhook`
apontando para a URL de produção.

Para depurar entrega de update, olhe `last_error_message` em `getWebhookInfo` — o `set-webhook` já
imprime isso.

## Desenvolvimento

```
deno task test    # suíte completa, sem rede
deno task check   # type-check, lint e fmt
```

Documentos: [design](docs/superpowers/specs/2026-09-04-bot-financeiro-telegram-design.md) e
[plano de implementação](docs/superpowers/plans/2026-09-04-bot-financeiro-telegram.md).
