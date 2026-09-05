import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Update } from "grammy/types";
import type { Ledger } from "./lib/ledger.ts";
import type { Lancamento, Saldo } from "./lib/types.ts";
import { MAX_DESCRICAO } from "./lib/render.ts";
import { criarBot } from "./bot.ts";

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Bot",
  username: "bot_teste",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as unknown as Record<string, unknown>;

const EU = 55;
const ESTRANHO = 99;

export interface Chamada {
  method: string;
  payload: Record<string, unknown>;
}

/** Ledger falso que registra o que foi pedido e devolve respostas fixas. */
function ledgerFalso(over: Partial<Ledger> = {}) {
  const registros: Array<{ l: Lancamento; updateId: number }> = [];
  const descricoes: Array<{ linha: number; descricao: string }> = [];
  const ledger: Ledger = {
    // deno-lint-ignore require-await
    async registrar(l, updateId) {
      registros.push({ l, updateId });
      return { linha: 42, duplicado: false };
    },
    // deno-lint-ignore require-await
    async descrever(linha, descricao) {
      descricoes.push({ linha, descricao });
    },
    // deno-lint-ignore require-await
    async saldo(mes): Promise<Saldo> {
      return {
        mes,
        entradasCentavos: 0,
        saidasCentavos: 0,
        resultadoCentavos: 0,
        acumuladoCentavos: 0,
      };
    },
    // deno-lint-ignore require-await
    async extrato() {
      return { itens: [], temMais: false };
    },
    ...over,
  };
  return { ledger, registros, descricoes };
}

export function montar(ledger: Ledger) {
  const chamadas: Chamada[] = [];
  const bot = criarBot({
    token: "12345:fake",
    permitidos: new Set([EU]),
    ledger,
    agora: () => new Date("2026-09-04T17:32:00Z"),
    botInfo: BOT_INFO,
  });
  bot.api.config.use((_prev, method, payload) => {
    chamadas.push({ method, payload: payload as Record<string, unknown> });
    return Promise.resolve({
      ok: true,
      result: { message_id: 1, date: 0, chat: { id: EU, type: "private" } },
      // deno-lint-ignore no-explicit-any
    } as any);
  });
  return { bot, chamadas };
}

export function updTexto(
  text: string,
  extra: Record<string, unknown> = {},
  from = EU,
  update_id = 100,
): Update {
  return {
    update_id,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: from, type: "private", first_name: "Bruno" },
      from: { id: from, is_bot: false, first_name: from === EU ? "Bruno" : "Estranho" },
      text,
      ...extra,
    },
  } as unknown as Update;
}

export function updCallback(data: string, update_id = 200, from = EU): Update {
  return {
    update_id,
    callback_query: {
      id: "cb1",
      chat_instance: "ci",
      from: { id: from, is_bot: false, first_name: "Bruno" },
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: from, type: "private" },
        text: "R$ 50,00 — entrada ou saída?",
      },
    },
  } as unknown as Update;
}

Deno.test("ignora em silêncio quem não está na allowlist", async () => {
  const { ledger } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updTexto("50", {}, ESTRANHO));
  assertEquals(chamadas, []);
});

Deno.test("valor válido ecoa a interpretação e oferece os botões", async () => {
  const { ledger } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updTexto("1.234,56"));

  assertEquals(chamadas.length, 1);
  assertEquals(chamadas[0].method, "sendMessage");
  assertStringIncludes(String(chamadas[0].payload.text), "R$ 1.234,56");
});

Deno.test("valor ilegível pede nova digitação com force_reply", async () => {
  const { ledger } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updTexto("50,5555"));

  assertEquals(chamadas[0].method, "sendMessage");
  assertStringIncludes(String(chamadas[0].payload.text), "50,5555");
  assertEquals(
    (chamadas[0].payload.reply_markup as { force_reply: boolean }).force_reply,
    true,
  );
});

Deno.test("mensagem sem dígito nenhum recebe só a dica de uso", async () => {
  const { ledger } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updTexto("bom dia"));

  assertStringIncludes(String(chamadas[0].payload.text), "/saldo");
  assertEquals(chamadas[0].payload.reply_markup, undefined);
});

Deno.test("botão Saída grava o lançamento e edita a mensagem", async () => {
  const { ledger, registros } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("n|S|5000", 777));

  assertEquals(registros.length, 1);
  assertEquals(registros[0].l.tipo, "Saída");
  assertEquals(registros[0].l.centavos, 5000);
  assertEquals(registros[0].l.quem, "Bruno");
  assertEquals(registros[0].updateId, 777);

  const editar = chamadas.find((c) => c.method === "editMessageText");
  assert(editar, "deveria editar a mensagem original");
  assertStringIncludes(String(editar.payload.text), "R$ 50,00");
  assert(chamadas.some((c) => c.method === "answerCallbackQuery"));
});

Deno.test("reentrega do Telegram não gera segunda linha", async () => {
  const { ledger } = ledgerFalso({
    // deno-lint-ignore require-await
    async registrar() {
      return { linha: 42, duplicado: true };
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("n|S|5000", 777));

  assert(chamadas.some((c) => c.method === "answerCallbackQuery"));
  assert(!chamadas.some((c) => c.method === "sendMessage"));
});

Deno.test("callback_data corrompido não derruba o handler", async () => {
  const { ledger, registros } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("lixo"));

  assertEquals(registros.length, 0);
  assert(chamadas.some((c) => c.method === "answerCallbackQuery"));
});

Deno.test("marcador com número de linha absurdo não chama descrever", async () => {
  const { ledger, descricoes } = ledgerFalso();
  const { bot } = montar(ledger);
  const marcador = `Qual foi o gasto? #${"9".repeat(30)}`;
  await bot.handleUpdate(
    updTexto("mercado", { reply_to_message: { text: marcador } }),
  );

  assertEquals(descricoes.length, 0);
});

Deno.test("marcador apontando para o cabeçalho (linha 1) não chama descrever", async () => {
  const { ledger, descricoes } = ledgerFalso();
  const { bot } = montar(ledger);
  await bot.handleUpdate(
    updTexto("aluguel", { reply_to_message: { text: "Qual foi o gasto? #1" } }),
  );

  assertEquals(descricoes.length, 0);
});

Deno.test("resposta ao marcador de descrição nunca é tratada como valor, mesmo com dígitos", async () => {
  const { ledger, descricoes } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(
    updTexto("50 pães", { reply_to_message: { text: "Qual foi o gasto? #42" } }),
  );

  assertEquals(descricoes.length, 1);
  assertEquals(descricoes[0], { linha: 42, descricao: "50 pães" });
  assertEquals(chamadas.length, 1);
  assertEquals(chamadas[0].method, "sendMessage");
  assertStringIncludes(String(chamadas[0].payload.text), "Descrição salva");
});

Deno.test("descrição longa é truncada em MAX_DESCRICAO antes de gravar", async () => {
  const { ledger, descricoes } = ledgerFalso();
  const { bot } = montar(ledger);
  const textoLongo = "a".repeat(200);
  await bot.handleUpdate(
    updTexto(textoLongo, { reply_to_message: { text: "Qual foi o gasto? #42" } }),
  );

  assertEquals(descricoes.length, 1);
  assertEquals(descricoes[0].linha, 42);
  assertEquals(descricoes[0].descricao.length, MAX_DESCRICAO);
  assertEquals(descricoes[0].descricao, "a".repeat(MAX_DESCRICAO));
});
