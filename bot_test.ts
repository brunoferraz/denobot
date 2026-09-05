import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Update } from "grammy/types";
import type { Ledger } from "./lib/ledger.ts";
import type { Lancamento, Saldo } from "./lib/types.ts";
import { MAX_DESCRICAO } from "./lib/render.ts";
import { ErroSheets } from "./lib/sheets.ts";
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
    // deno-lint-ignore require-await
    async obterLancamento(linha) {
      const ultima = [...descricoes].reverse().find((d) => d.linha === linha);
      return {
        data: new Date("2026-09-04T00:00:00Z"),
        tipo: "Saída",
        centavos: 5000,
        descricao: ultima?.descricao ?? "",
        quem: "Bruno",
      };
    },
    ...over,
  };
  return { ledger, registros, descricoes };
}

export function montar(ledger: Ledger, agora: () => Date = () => new Date("2026-09-04T17:32:00Z")) {
  const chamadas: Chamada[] = [];
  const bot = criarBot({
    token: "12345:fake",
    permitidos: new Set([EU]),
    ledger,
    agora,
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
  // 2026-09-04T17:32:00Z cai no mesmo dia em UTC e em São Paulo (17:32 -> 14:32,
  // UTC-3) — então isto só prova que agoraLocal normaliza a hora, não que ela
  // evita a virada de dia. O teste de madrugada logo abaixo cobre esse caso.
  assertEquals(registros[0].l.data.toISOString(), "2026-09-04T14:32:00.000Z");

  const editar = chamadas.find((c) => c.method === "editMessageText");
  assert(editar, "deveria editar a mensagem original");
  assertStringIncludes(String(editar.payload.text), "R$ 50,00");
  assert(chamadas.some((c) => c.method === "answerCallbackQuery"));
});

Deno.test("lançamento feito de madrugada em UTC é gravado no dia anterior (wall-clock de SP)", async () => {
  const { ledger, registros } = ledgerFalso();
  // 2026-09-05T02:00:00Z = 2026-09-04T23:00:00 em São Paulo (UTC-3): o dia
  // muda em UTC antes de mudar em SP. Sem agoraLocal, a linha 79-80 comentada
  // em bot.ts registraria isso como 05/09, um dia adiantado.
  const { bot, chamadas } = montar(ledger, () => new Date("2026-09-05T02:00:00Z"));
  await bot.handleUpdate(updCallback("n|S|5000", 777));

  assertEquals(registros.length, 1);
  assertEquals(registros[0].l.data.toISOString(), "2026-09-04T23:00:00.000Z");
  assert(chamadas.some((c) => c.method === "editMessageText"));
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

  // Sequência exata: só o answerCallbackQuery. Se o guard `if (duplicado)
  // return;` fosse removido, um editMessageText extra apareceria aqui — as
  // duas asserções antigas (alguma answerCallbackQuery, nenhuma sendMessage)
  // não rejeitariam isso, porque editMessageText não é sendMessage.
  assertEquals(chamadas.map((c) => c.method), ["answerCallbackQuery"]);
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
  assertStringIncludes(String(chamadas[0].payload.text), "50 pães");
});

Deno.test("§6.2: depois de descrever, reaparece a confirmação com a descrição e só o botão de compartilhar", async () => {
  const { ledger } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(
    updTexto("mercado", { reply_to_message: { text: "Qual foi o gasto? #42" } }),
  );

  const envio = chamadas.find((c) => c.method === "sendMessage")!;
  assertStringIncludes(String(envio.payload.text), "mercado");
  assertStringIncludes(String(envio.payload.text), "✅");

  const kb = (envio.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data?: string; url?: string }>>;
  }).inline_keyboard;
  // Sem o botão ✏️ (a descrição já foi preenchida) e com o botão de URL do
  // WhatsApp — sem isso, o botão de compartilhar da confirmação ORIGINAL
  // continuaria carregando o texto sem descrição, e não haveria como
  // compartilhar o lançamento junto com ela.
  assertEquals(kb.length, 1);
  assertEquals(kb[0].length, 1);
  assertEquals(kb[0][0].callback_data, undefined);
  assert(kb[0][0].url?.startsWith("https://wa.me/?text="));
});

Deno.test(
  "se a linha some entre descrever e a releitura, ainda confirma a descrição salva sem quebrar",
  async () => {
    const { ledger } = ledgerFalso({
      // deno-lint-ignore require-await
      async obterLancamento() {
        return null;
      },
    });
    const { bot, chamadas } = montar(ledger);
    await bot.handleUpdate(
      updTexto("mercado", { reply_to_message: { text: "Qual foi o gasto? #42" } }),
    );

    assertStringIncludes(String(chamadas[0].payload.text), "Descrição salva: mercado");
  },
);

Deno.test("descrição longa é truncada em MAX_DESCRICAO antes de gravar, e o eco também vem clampado", async () => {
  const { ledger, descricoes } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  const textoLongo = "a".repeat(200);
  await bot.handleUpdate(
    updTexto(textoLongo, { reply_to_message: { text: "Qual foi o gasto? #42" } }),
  );

  assertEquals(descricoes.length, 1);
  assertEquals(descricoes[0].linha, 42);
  assertEquals(descricoes[0].descricao.length, MAX_DESCRICAO);
  assertEquals(descricoes[0].descricao, "a".repeat(MAX_DESCRICAO));

  // Se o eco levasse o texto bruto (200 chars), uma descrição perto do limite
  // de 4096 do sendMessage estouraria depois que a linha já foi gravada — sem
  // isso, o usuário fica sem confirmação de uma gravação que deu certo.
  const texto = String(chamadas[0].payload.text);
  assertStringIncludes(texto, "a".repeat(MAX_DESCRICAO));
  assert(!texto.includes(textoLongo), "eco não deveria conter o texto bruto sem clamp");
});

Deno.test("botão de descrever manda a pergunta com force_reply e a linha embutida", async () => {
  const { ledger } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("d|42"));

  const envio = chamadas.find((c) => c.method === "sendMessage")!;
  assertStringIncludes(String(envio.payload.text), "#42");
  assertEquals((envio.payload.reply_markup as { force_reply: boolean }).force_reply, true);
});

Deno.test("resposta à pergunta grava a descrição na linha certa", async () => {
  const { ledger, descricoes } = ledgerFalso();
  const { bot } = montar(ledger);
  await bot.handleUpdate(updTexto("mercado", {
    reply_to_message: {
      message_id: 9,
      date: 0,
      chat: { id: 55, type: "private" },
      text: "Qual foi o gasto? #42",
    },
  }));

  assertEquals(descricoes, [{ linha: 42, descricao: "mercado" }]);
});

Deno.test("uma resposta com número não é confundida com novo lançamento", async () => {
  const { ledger, descricoes } = ledgerFalso();
  const { bot } = montar(ledger);
  await bot.handleUpdate(updTexto("uber 2 corridas", {
    reply_to_message: {
      message_id: 9,
      date: 0,
      chat: { id: 55, type: "private" },
      text: "Qual foi o gasto? #42",
    },
  }));

  assertEquals(descricoes, [{ linha: 42, descricao: "uber 2 corridas" }]);
});

Deno.test("/saldo consulta o mês corrente segundo o relógio injetado", async () => {
  const mesesPedidos: string[] = [];
  const { ledger } = ledgerFalso({
    // deno-lint-ignore require-await
    async saldo(mes) {
      mesesPedidos.push(mes);
      return {
        mes,
        entradasCentavos: 200000,
        saidasCentavos: 35000,
        resultadoCentavos: 165000,
        acumuladoCentavos: 482000,
      };
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(
    updTexto("/saldo", { entities: [{ type: "bot_command", offset: 0, length: 6 }] }),
  );

  assertEquals(mesesPedidos, ["2026-09"]);
  assertStringIncludes(String(chamadas[0].payload.text), "Setembro/2026");
  assertStringIncludes(String(chamadas[0].payload.text), "1.650,00");
});

Deno.test("/saldo usa o mês do wall-clock de SP, não o mês em UTC", async () => {
  // 2026-09-01T02:00:00Z = 2026-08-31T23:00:00 em São Paulo (UTC-3): o mês já
  // virou em UTC mas ainda não em SP. Sem normalizar com agoraLocal, /saldo
  // consultaria "2026-09" um mês adiantado — o mesmo defeito de fuso horário
  // já corrigido para o registro de lançamentos (agoraLocal em bot.ts).
  const mesesPedidos: string[] = [];
  const { ledger } = ledgerFalso({
    // deno-lint-ignore require-await
    async saldo(mes) {
      mesesPedidos.push(mes);
      return {
        mes,
        entradasCentavos: 0,
        saidasCentavos: 0,
        resultadoCentavos: 0,
        acumuladoCentavos: 0,
      };
    },
  });
  const { bot } = montar(ledger, () => new Date("2026-09-01T02:00:00Z"));
  await bot.handleUpdate(
    updTexto("/saldo", { entities: [{ type: "bot_command", offset: 0, length: 6 }] }),
  );

  assertEquals(mesesPedidos, ["2026-08"]);
});

Deno.test("botão de mês reconsulta e edita a mesma mensagem", async () => {
  const mesesPedidos: string[] = [];
  const { ledger } = ledgerFalso({
    // deno-lint-ignore require-await
    async saldo(mes) {
      mesesPedidos.push(mes);
      return {
        mes,
        entradasCentavos: 0,
        saidasCentavos: 0,
        resultadoCentavos: 0,
        acumuladoCentavos: 0,
      };
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("m|2026-08"));

  assertEquals(mesesPedidos, ["2026-08"]);
  assert(chamadas.some((c) => c.method === "editMessageText"));
});

Deno.test("/extrato pede a primeira página", async () => {
  const pedidos: Array<[number, number]> = [];
  const { ledger } = ledgerFalso({
    // deno-lint-ignore require-await
    async extrato(offset, limite) {
      pedidos.push([offset, limite]);
      return { itens: [], temMais: false };
    },
  });
  const { bot } = montar(ledger);
  await bot.handleUpdate(
    updTexto("/extrato", { entities: [{ type: "bot_command", offset: 0, length: 8 }] }),
  );

  assertEquals(pedidos, [[0, 10]]);
});

Deno.test("botão Ver mais avança o offset e edita a mensagem", async () => {
  const pedidos: Array<[number, number]> = [];
  const { ledger } = ledgerFalso({
    // deno-lint-ignore require-await
    async extrato(offset, limite) {
      pedidos.push([offset, limite]);
      return { itens: [], temMais: false };
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("x|10"));

  assertEquals(pedidos, [[10, 10]]);
  assert(chamadas.some((c) => c.method === "editMessageText"));
});

Deno.test("falha do ledger vira aviso ao usuário, não exceção não tratada", async () => {
  const { ledger } = ledgerFalso({
    registrar() {
      return Promise.reject(new Error("Sheets 403: sem permissão"));
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("n|S|5000"));

  assert(
    chamadas.some((c) => String(c.payload.text ?? "").includes("não consegui")),
    "usuário precisa ser avisado da falha",
  );
});

Deno.test("ErroSheets 403 avisa explicitamente que a planilha precisa ser compartilhada com a service account", async () => {
  const { ledger } = ledgerFalso({
    registrar() {
      return Promise.reject(new ErroSheets(403, "Sheets 403: The caller does not have permission"));
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("n|S|5000"));

  assert(
    chamadas.some((c) => String(c.payload.text ?? "").includes("compartilhada")),
    "spec §8: o 403 precisa nomear a causa quase certa (planilha não compartilhada)",
  );
});

Deno.test("falha genérica (não-403) continua com a mensagem curta, sem o texto do 403", async () => {
  const { ledger } = ledgerFalso({
    registrar() {
      return Promise.reject(new ErroSheets(500, "Sheets 500: internal error"));
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("n|S|5000"));

  const aviso = String(chamadas.find((c) => c.method === "sendMessage")?.payload.text ?? "");
  assertStringIncludes(aviso, "não consegui falar com a planilha");
  assert(!aviso.includes("compartilhada"), "só o 403 deveria citar a causa da service account");
});
