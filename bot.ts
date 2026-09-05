import { Bot, type Context } from "grammy";
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

const AVISO_FALHA_GENERICO =
  "⚠️ não consegui falar com a planilha agora. Tenta de novo em instantes.";
const AVISO_SHEETS_403 =
  "⚠️ não consegui gravar: a planilha precisa estar compartilhada com o e-mail da service account, como Editor.";

export interface DepsBot {
  token: string;
  permitidos: Set<number>;
  ledger: Ledger;
  agora?: () => Date;
  botInfo?: unknown;
  /**
   * Opcional. Chamado quando um update vem de quem NÃO está na allowlist.
   * Sem ele o comportamento é o silêncio total do spec §9 — é o padrão.
   * Hoje é usado pelo aviso de cadastro (lib/onboarding.ts), que é
   * temporário; esta costura existe para que removê-lo seja apagar uma
   * linha em main.ts, sem tocar em lógica aqui.
   */
  aoNegar?: (ctx: Context) => Promise<void>;
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
  { token, permitidos, ledger, agora = () => new Date(), botInfo, aoNegar }: DepsBot,
): Bot {
  const bot = new Bot(token, botInfo ? { botInfo: botInfo as UserFromGetMe } : undefined);

  // Quem não está na allowlist não alcança handler nenhum. Por padrão não
  // recebe resposta alguma — nem um erro: silêncio evita confirmar que o bot
  // existe para quem descobriu o @ (spec §9). O `aoNegar` opcional é a única
  // exceção, hoje usada pelo aviso de cadastro temporário (lib/onboarding.ts).
  bot.use(async (ctx, next) => {
    if (ctx.from && permitidos.has(ctx.from.id)) return await next();
    await aoNegar?.(ctx);
  });

  // `bot.handleUpdate` — chamado tanto pelo `webhookCallback` de produção
  // (ver main.ts) quanto pelos testes — apenas relança o erro de um handler
  // como uma Promise rejeitada; não existe laço interno de tratamento como o
  // de `bot.start()` (long polling). Sem este `bot.use`, uma falha do Sheets
  // nunca chegaria a avisar o usuário, e ele acharia que o lançamento foi
  // gravado quando na verdade a exceção estourou sem resposta. Fica DEPOIS
  // do gate de allowlist para que quem não está autorizado nunca dispare
  // sequer este try/catch — "silêncio total" (spec §9) continua sendo uma
  // propriedade estrutural da ordem de registro, não um acidente de quem foi
  // registrado primeiro.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error("erro no handler:", err);
      // bot.ts não importa ErroSheets (spec §3: bot.ts não sabe o que é o
      // Google Sheets) — por isso o 403 é reconhecido por `name`/`status`
      // duck-typed, sem importar a classe de lib/sheets.ts. É o único caso
      // em que a mensagem genérica não basta: spec §8 exige nomear a causa
      // quase certa (planilha não compartilhada com a service account).
      const e = err as { name?: string; status?: number };
      const aviso = e?.name === "ErroSheets" && e.status === 403
        ? AVISO_SHEETS_403
        : AVISO_FALHA_GENERICO;
      try {
        await ctx.reply(aviso);
      } catch (e2) {
        console.error("falhei até para avisar o usuário:", e2);
      }
    }
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
      // §6.2: depois de descrever, a confirmação final precisa reaparecer
      // com a descrição embutida e o botão de compartilhar — senão o botão
      // da confirmação original (a que já existe na conversa) continua
      // codificando o texto SEM descrição, e compartilhar o lançamento
      // junto com a descrição fica inalcançável. bot.ts não guardou o
      // lançamento entre as duas mensagens (é stateless), então relê a
      // linha já gravada — a planilha é a única fonte de verdade (D5) — em
      // vez de tentar carregar o valor/tipo/quem por algum outro canal.
      const l = await ledger.obterLancamento(linha);
      if (l) {
        const msg = confirmacao(l, linha);
        await ctx.reply(msg.text, { reply_markup: msg.reply_markup as never });
      } else {
        // Linha sumiu ou foi corrompida entre o descrever e esta releitura
        // (edição manual concorrente, por exemplo): ainda confirma que a
        // descrição foi salva, só sem poder reconstruir o resumo completo.
        await ctx.reply(`✏️ Descrição salva: ${descricao}`);
      }
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

  return bot;
}

// deno-lint-ignore no-explicit-any
function responder(ctx: any, m: Mensagem) {
  return ctx.reply(m.text, m.reply_markup ? { reply_markup: m.reply_markup } : {});
}
