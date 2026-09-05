import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Update } from "grammy/types";
import type { Ledger } from "./ledger.ts";
import { criarBot } from "../bot.ts";
import { criarAvisoDeCadastro } from "./onboarding.ts";

const ADMIN = 55;
const ESTRANHO = 99;

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Bot",
  username: "bot_teste",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as unknown as Record<string, unknown>;

const ledgerInerte = {} as Ledger; // nenhum handler deve ser alcançado

function montar(falharPara?: number) {
  const chamadas: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const bot = criarBot({
    token: "12345:fake",
    permitidos: new Set([ADMIN]),
    ledger: ledgerInerte,
    botInfo: BOT_INFO,
    aoNegar: criarAvisoDeCadastro(ADMIN),
  });
  bot.api.config.use((_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    if (falharPara !== undefined && p.chat_id === falharPara) {
      return Promise.reject(new Error("bloqueado pelo usuário"));
    }
    chamadas.push({ method, payload: p });
    // deno-lint-ignore no-explicit-any
    return Promise.resolve({ ok: true, result: { message_id: 1 } } as any);
  });
  return { bot, chamadas };
}

/** Cala o console.error nos testes que exercitam o caminho de falha. */
function silenciarErro() {
  const original = console.error;
  console.error = () => {};
  return { [Symbol.dispose]: () => void (console.error = original) };
}

const texto = (t: string, from: number, nome = "José", username?: string): Update =>
  ({
    update_id: 500,
    message: {
      message_id: 9,
      date: 0,
      chat: { id: from, type: "private", first_name: nome },
      from: { id: from, is_bot: false, first_name: nome, username },
      text: t,
    },
  }) as unknown as Update;

const botao = (from: number): Update =>
  ({
    update_id: 501,
    callback_query: {
      id: "cb1",
      chat_instance: "ci",
      from: { id: from, is_bot: false, first_name: "José" },
      data: "n|S|5000",
      message: { message_id: 9, date: 0, chat: { id: from, type: "private" }, text: "x" },
    },
  }) as unknown as Update;

Deno.test("estranho recebe o próprio ID e o admin é avisado", async () => {
  const { bot, chamadas } = montar();
  await bot.handleUpdate(texto("oi", ESTRANHO, "José", "zeca"));

  assertEquals(chamadas.length, 2, "um envio para o estranho, um para o admin");

  const paraEstranho = chamadas.find((c) => c.payload.chat_id === ESTRANHO)!;
  assertStringIncludes(String(paraEstranho.payload.text), String(ESTRANHO));
  assertStringIncludes(String(paraEstranho.payload.text), "não tem acesso");

  const paraAdmin = chamadas.find((c) => c.payload.chat_id === ADMIN)!;
  assertStringIncludes(String(paraAdmin.payload.text), String(ESTRANHO));
  assertStringIncludes(String(paraAdmin.payload.text), "José");
  assertStringIncludes(String(paraAdmin.payload.text), "zeca");
});

Deno.test("a resposta ao estranho não revela o que o bot faz", async () => {
  const { bot, chamadas } = montar();
  await bot.handleUpdate(texto("oi", ESTRANHO));
  const t = String(chamadas.find((c) => c.payload.chat_id === ESTRANHO)!.payload.text);
  for (const vazamento of ["/saldo", "/extrato", "planilha", "lançamento", "R$"]) {
    assert(!t.includes(vazamento), `resposta vazou "${vazamento}"`);
  }
});

Deno.test("sem username, o aviso ao admin não quebra", async () => {
  const { bot, chamadas } = montar();
  await bot.handleUpdate(texto("oi", ESTRANHO, "José"));
  const paraAdmin = String(chamadas.find((c) => c.payload.chat_id === ADMIN)!.payload.text);
  assertStringIncludes(paraAdmin, "José");
  assert(!paraAdmin.includes("@undefined"), "username ausente virou @undefined");
});

Deno.test("se o aviso ao admin falhar, o estranho ainda recebe o ID", async () => {
  const { bot, chamadas } = montar(ADMIN); // envio ao admin rejeita
  using _ = silenciarErro(); // a falha é logada de propósito; não polui o output
  await bot.handleUpdate(texto("oi", ESTRANHO));
  assertEquals(chamadas.length, 1);
  assertStringIncludes(String(chamadas[0].payload.text), String(ESTRANHO));
});

Deno.test("se o envio ao estranho falhar, nada escapa como exceção", async () => {
  const { bot } = montar(ESTRANHO);
  using _ = silenciarErro();
  await bot.handleUpdate(texto("oi", ESTRANHO)); // não deve rejeitar
});

Deno.test("estranho tocando botão continua em silêncio total", async () => {
  const { bot, chamadas } = montar();
  await bot.handleUpdate(botao(ESTRANHO));
  assertEquals(chamadas, []);
});

Deno.test("usuário autorizado nunca passa pelo aviso de cadastro", async () => {
  const { bot, chamadas } = montar();
  await bot.handleUpdate(texto("bom dia", ADMIN, "Bruno"));
  assert(
    !chamadas.some((c) => String(c.payload.text).includes("não tem acesso")),
    "autorizado recebeu resposta de cadastro",
  );
});
