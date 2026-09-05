import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Ledger } from "./lib/ledger.ts";
import type { Lancamento } from "./lib/types.ts";
import { pareceValor, parseValor } from "./lib/money.ts";
import { decodeCallback } from "./lib/callback.ts";
import { agoraLocal, mesDe } from "./lib/tempo.ts";
import {
  confirmacao,
  dicaUso,
  erroValor,
  extrairLinha,
  MAX_DESCRICAO,
  type Mensagem,
  PAGINA_EXTRATO,
  perguntaDescricao,
  perguntaTipo,
  textoExtrato,
  textoSaldo,
} from "./lib/render.ts";

export interface DepsBot {
  token: string;
  permitidos: Set<number>;
  ledger: Ledger;
  agora?: () => Date;
  botInfo?: unknown;
}

/**
 * Trunca a descrição já na gravação. `render.ts` trunca só para exibição
 * (MAX_DESCRICAO repara linhas já gravadas), mas sem clamp aqui a planilha
 * guardaria o texto monstro inteiro.
 */
function clampDescricao(texto: string): string {
  const pontos = Array.from(texto);
  return pontos.length > MAX_DESCRICAO ? pontos.slice(0, MAX_DESCRICAO).join("") : texto;
}

export function criarBot(
  { token, permitidos, ledger, agora = () => new Date(), botInfo }: DepsBot,
): Bot {
  const bot = new Bot(token, botInfo ? { botInfo: botInfo as UserFromGetMe } : undefined);

  // `bot.catch` (registrado abaixo) só é chamado pelo laço interno de
  // `handleUpdates` (usado por `bot.start()`, i.e. long polling). Tanto o
  // `webhookCallback` do grammY (nosso modo de produção, ver scripts/
  // set_webhook.ts) quanto os testes chamam `bot.handleUpdate` diretamente,
  // que apenas relança o erro como uma Promise rejeitada — sem isso, uma
  // falha do Sheets nunca chegaria a avisar o usuário, e ele acharia que o
  // lançamento foi gravado quando na verdade a exceção estourou sem resposta.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error("erro no handler:", err);
      try {
        await ctx.reply("⚠️ não consegui falar com a planilha agora. Tenta de novo em instantes.");
      } catch (e) {
        console.error("falhei até para avisar o usuário:", e);
      }
    }
  });

  // Quem não está na allowlist não recebe resposta alguma — nem um erro.
  // Silêncio evita confirmar que o bot existe para quem descobriu o @.
  bot.use(async (ctx, next) => {
    if (ctx.from && permitidos.has(ctx.from.id)) await next();
  });

  // Novos bot.command(...) (ex.: /saldo, /extrato da Task 8) entram aqui, antes
  // de "message:text" — senão o grammY encaminharia o comando para o parser de
  // valor primeiro, e ele nunca chegaria ao handler do comando.
  bot.command(["start", "ajuda", "help"], (ctx) => responder(ctx, dicaUso()));

  bot.command("saldo", async (ctx) => {
    // agoraLocal normaliza para wall-clock de SP antes de extrair o mês —
    // sem isso, /saldo chamado de madrugada em UTC (mas ainda no dia/mês
    // anterior em SP) consultaria o mês seguinte, adiantado.
    const s = await ledger.saldo(mesDe(agoraLocal(agora())));
    await responder(ctx, textoSaldo(s));
  });

  bot.command("extrato", async (ctx) => {
    const { itens, temMais } = await ledger.extrato(0, PAGINA_EXTRATO);
    await responder(ctx, textoExtrato(itens, 0, temMais));
  });

  bot.on("message:text", async (ctx) => {
    const texto = ctx.message.text;

    // 1. Resposta a "Qual foi o gasto? #42" -> é descrição, não passa pelo parser.
    const linha = extrairLinha(ctx.message.reply_to_message?.text ?? "");
    // A linha 1 é o cabeçalho; extrairLinha não tem teto de dígitos, então um
    // marcador forjado/corrompido poderia produzir um número absurdo — o
    // caminho de callback já é protegido por decodeCallback, este não.
    if (linha !== null && Number.isSafeInteger(linha) && linha >= 2) {
      const descricao = clampDescricao(texto.trim());
      await ledger.descrever(linha, descricao);
      // Ecoa o valor JÁ clampado: se o eco levasse o texto bruto, uma
      // descrição gigante estouraria o limite de 4096 chars do sendMessage
      // depois que a linha já foi gravada — o usuário ficaria sem confirmação
      // nenhuma de uma gravação que, na verdade, deu certo.
      await ctx.reply(`✏️ Descrição salva: ${descricao}`);
      return;
    }

    // 2. Tem dígito -> tentativa de valor.
    if (pareceValor(texto)) {
      const r = parseValor(texto);
      await responder(ctx, r.ok ? perguntaTipo(r.centavos) : erroValor(texto.trim(), r.erro));
      return;
    }

    // 3. Nem uma coisa nem outra -> só a dica.
    await responder(ctx, dicaUso());
  });

  bot.callbackQuery(/^n\|/, async (ctx) => {
    const cb = decodeCallback(ctx.callbackQuery.data);
    if (cb?.tipo !== "n") return await ctx.answerCallbackQuery();

    const lancamento: Lancamento = {
      // agoraLocal normaliza para wall-clock de SP; sem isso, um lançamento
      // feito depois das 21h seria gravado com a data do dia seguinte.
      data: agoraLocal(agora()),
      tipo: cb.lancamento,
      centavos: cb.centavos,
      descricao: "",
      quem: ctx.from.first_name,
    };

    const { linha, duplicado } = await ledger.registrar(lancamento, ctx.update.update_id);
    await ctx.answerCallbackQuery();
    if (duplicado) return;

    const msg = confirmacao(lancamento, linha);
    await ctx.editMessageText(msg.text, { reply_markup: msg.reply_markup as never });
  });

  bot.callbackQuery(/^d\|/, async (ctx) => {
    const cb = decodeCallback(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery();
    if (cb?.tipo !== "d") return;
    const m = perguntaDescricao(cb.linha);
    await ctx.reply(m.text, { reply_markup: m.reply_markup as never });
  });

  bot.callbackQuery(/^m\|/, async (ctx) => {
    const cb = decodeCallback(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery();
    if (cb?.tipo !== "m") return;
    const m = textoSaldo(await ledger.saldo(cb.mes));
    await ctx.editMessageText(m.text, { reply_markup: m.reply_markup as never });
  });

  bot.callbackQuery(/^x\|/, async (ctx) => {
    const cb = decodeCallback(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery();
    if (cb?.tipo !== "x") return;
    const { itens, temMais } = await ledger.extrato(cb.offset, PAGINA_EXTRATO);
    const m = textoExtrato(itens, cb.offset, temMais);
    await ctx.editMessageText(m.text, {
      reply_markup: (m.reply_markup ?? { inline_keyboard: [] }) as never,
    });
  });

  // Qualquer callback que não bata com os prefixos conhecidos: só apaga o spinner.
  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery());

  // Só é exercido quando o bot roda via `bot.start()` (long polling); no modo
  // de produção (webhookCallback) e nos testes, quem trata o erro é o
  // `bot.use` acima. Mantido como rede de segurança adicional.
  bot.catch(async (err) => {
    console.error("erro no handler:", err.error);
    // O usuário precisa saber que a ação não teve efeito; sem isso ele
    // acha que gravou e não gravou.
    try {
      await err.ctx.reply(
        "⚠️ não consegui falar com a planilha agora. Tenta de novo em instantes.",
      );
    } catch (e) {
      console.error("falhei até para avisar o usuário:", e);
    }
  });

  return bot;
}

// deno-lint-ignore no-explicit-any
function responder(ctx: any, m: Mensagem) {
  return ctx.reply(m.text, m.reply_markup ? { reply_markup: m.reply_markup } : {});
}
