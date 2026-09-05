import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Lancamento, Saldo } from "./types.ts";
import { serialParaDate } from "./tempo.ts";
import {
  confirmacao,
  erroValor,
  extrairLinha,
  linkWhatsApp,
  perguntaDescricao,
  perguntaTipo,
  textoExtrato,
  textoSaldo,
} from "./render.ts";

const lanc: Lancamento = {
  data: serialParaDate(46269.5),
  tipo: "Saída",
  centavos: 5000,
  descricao: "pão & café",
  quem: "Bruno",
};

Deno.test("perguntaTipo ecoa o valor interpretado e oferece os dois botões", () => {
  const m = perguntaTipo(123456);
  assertStringIncludes(m.text, "R$ 1.234,56");
  const kb = (m.reply_markup as { inline_keyboard: { callback_data: string }[][] })
    .inline_keyboard;
  assertEquals(kb[0].map((b) => b.callback_data), ["n|E|123456", "n|S|123456"]);
});

Deno.test("linkWhatsApp codifica acento, & e quebra de linha", () => {
  const url = linkWhatsApp(lanc);
  assert(url.startsWith("https://wa.me/?text="));
  const texto = decodeURIComponent(url.slice("https://wa.me/?text=".length));
  assertStringIncludes(texto, "pão & café");
  assertStringIncludes(texto, "R$ 50,00");
  assertStringIncludes(texto, "Saída");
  // nada de caractere cru que quebre a query string
  assert(!url.includes(" "));
  assert(!url.includes("\n"));
  assert(!url.includes("&text"));
});

Deno.test("confirmacao traz o botão de descrever e o de compartilhar", () => {
  // Sem descrição ainda: o botão "Qual foi o gasto?" só faz sentido nesse caso
  // — reusar `lanc` (que já tem descrição) esconderia esse botão por design.
  const semDescricao: Lancamento = { ...lanc, descricao: "" };
  const m = confirmacao(semDescricao, 42);
  const kb = (m.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data?: string; url?: string }>>;
  }).inline_keyboard;
  assertEquals(kb[0][0].callback_data, "d|42");
  assert(kb[1][0].url!.startsWith("https://wa.me/?text="));
});

Deno.test("perguntaDescricao usa force_reply e carrega a linha no texto", () => {
  const m = perguntaDescricao(42);
  assertEquals(extrairLinha(m.text), 42);
  assertEquals((m.reply_markup as { force_reply: boolean }).force_reply, true);
});

Deno.test("extrairLinha ignora texto sem marcador", () => {
  assertEquals(extrairLinha("qualquer coisa"), null);
  assertEquals(extrairLinha("Qual foi o gasto? #7"), 7);
});

Deno.test("erroValor pede nova digitação com force_reply", () => {
  const m = erroValor("50,5555", "formato");
  assertStringIncludes(m.text, "50,5555");
  assertStringIncludes(m.text, "1.234,56");
  assertEquals((m.reply_markup as { force_reply: boolean }).force_reply, true);
});

Deno.test("erroValor explica cada motivo de recusa", () => {
  assertStringIncludes(erroValor("0", "zero").text, "maior que zero");
  assertStringIncludes(erroValor("-5", "negativo").text, "sem sinal");
  assertStringIncludes(erroValor("9999999", "muito-alto").text, "1.000.000");
});

Deno.test("textoSaldo mostra mês e acumulado", () => {
  const s: Saldo = {
    mes: "2026-09",
    entradasCentavos: 200000,
    saidasCentavos: 35000,
    resultadoCentavos: 165000,
    acumuladoCentavos: 482000,
  };
  const m = textoSaldo(s);
  assertStringIncludes(m.text, "Setembro/2026");
  assertStringIncludes(m.text, "2.000,00");
  assertStringIncludes(m.text, "1.650,00");
  assertStringIncludes(m.text, "4.820,00");
  const kb = (m.reply_markup as { inline_keyboard: { callback_data: string }[][] })
    .inline_keyboard;
  assertEquals(kb[0][0].callback_data, "m|2026-08");
});

Deno.test("textoExtrato lista lançamentos e pagina só quando há mais", () => {
  const m = textoExtrato([lanc], 0, true);
  assertStringIncludes(m.text, "04/09");
  assertStringIncludes(m.text, "50,00");
  assertStringIncludes(m.text, "pão & café");
  const kb = (m.reply_markup as { inline_keyboard: { callback_data: string }[][] })
    .inline_keyboard;
  assertEquals(kb[0][0].callback_data, "x|10");

  const fim = textoExtrato([lanc], 10, false);
  assertEquals(fim.reply_markup, undefined);
});

Deno.test("textoExtrato lida com planilha vazia", () => {
  assertStringIncludes(textoExtrato([], 0, false).text, "nenhum lançamento");
});
