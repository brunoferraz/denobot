import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Lancamento, Saldo } from "./types.ts";
import { serialParaDate } from "./tempo.ts";
import {
  confirmacao,
  erroValor,
  extrairLinha,
  linkWhatsApp,
  MAX_DESCRICAO,
  MAX_ENTRADA_ECO,
  MAX_QUEM,
  PAGINA_EXTRATO,
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
  assertEquals(kb[0][0].callback_data, "d|42|S"); // o tipo viaja no botão
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

Deno.test("confirmacao com descrição já preenchida traz só o botão de compartilhar", () => {
  const m = confirmacao(lanc, 42);
  const kb = (m.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data?: string; url?: string }>>;
  }).inline_keyboard;
  assertEquals(kb.length, 1);
  assertEquals(kb[0].length, 1);
  assertEquals(kb[0][0].callback_data, undefined);
  assert(kb[0][0].url!.startsWith("https://wa.me/?text="));
});

Deno.test("extrairLinha não confunde nome de usuário terminado em '#N' com o marcador", () => {
  // `resumo` termina em "· <quem>" e um nome de usuário no Telegram pode ser
  // qualquer coisa, inclusive "Ana #2" — não pode disparar o mesmo marcador
  // que "Qual foi o gasto? #2".
  assertEquals(extrairLinha("Saída de R$ 10,00 · mercado · 04/09 · Ana #2"), null);
});

const descricaoLonga = "a".repeat(4000);
const descricaoTruncada = descricaoLonga.slice(0, MAX_DESCRICAO) + "…";

Deno.test("descrição muito longa é truncada em confirmacao().text e no link do WhatsApp", () => {
  const l: Lancamento = { ...lanc, descricao: descricaoLonga };

  assertEquals(descricaoTruncada.length, MAX_DESCRICAO + 1);

  const conf = confirmacao(l, 42);
  assertStringIncludes(conf.text, descricaoTruncada);
  assert(!conf.text.includes(descricaoLonga));
  assert(
    conf.text.length < 200,
    `confirmacao().text tem ${conf.text.length} caracteres, esperado bem abaixo de 4096`,
  );

  const url = linkWhatsApp(l);
  assert(
    url.length < 4096,
    `linkWhatsApp produziu URL com ${url.length} caracteres, limite do Telegram é 4096`,
  );
});

Deno.test("truncagem não parte um emoji ao meio (evita URIError em encodeURIComponent)", () => {
  // "x" + 100 emoji de par substituto: uma truncagem ingênua por unidade
  // UTF-16 (slice(0, 80)) cai bem no meio do par na posição 79/80 e deixa um
  // surrogate solto — o que faz encodeURIComponent lançar "URI malformed".
  const l: Lancamento = { ...lanc, descricao: "x" + "😀".repeat(100) };
  const url = linkWhatsApp(l); // não deve lançar
  const texto = decodeURIComponent(url); // não lança se a string estiver bem formada
  assertStringIncludes(texto, "…");
  // A reprodução mais severa do achado 1 foi justamente uma URL de 12100
  // caracteres a partir de 1000 emoji — medir o comprimento aqui (e não só na
  // descrição ASCII de outro teste) torna essa falha diretamente coberta.
  assert(
    url.length < 4096,
    `linkWhatsApp com descrição em emoji produziu URL com ${url.length} caracteres, limite do Telegram é 4096`,
  );
});

Deno.test("textoExtrato com dez linhas de descrição longa fica abaixo do limite de 4096", () => {
  const dez: Lancamento[] = Array.from(
    { length: 10 },
    () => ({ ...lanc, descricao: descricaoLonga }),
  );
  const m = textoExtrato(dez, 0, false);
  assertStringIncludes(m.text, descricaoTruncada);
  assert(
    m.text.length < 4096,
    `textoExtrato com 10 linhas produziu ${m.text.length} caracteres, limite do Telegram é 4096`,
  );
});

Deno.test("textoExtrato com dez linhas de descrição E nome em emoji fica abaixo do limite de 4096", () => {
  // `quem` é nome de exibição do Telegram: entrada do usuário tanto quanto
  // `descricao`, e igualmente capaz de ser emoji astral longo. Sem clampar os
  // dois, a medição do revisor deu 4469 caracteres — acima de 4096 — mesmo
  // com `descricao` já truncada, porque o excesso vinha inteiro de `quem`.
  const descricaoEmEmoji = "😀".repeat(100); // bem acima de MAX_DESCRICAO
  const quemEmEmoji = "🎉".repeat(110); // bem acima de MAX_QUEM; sem o clamp, 10 dessas linhas já passam de 4096
  const dez: Lancamento[] = Array.from(
    { length: 10 },
    () => ({ ...lanc, descricao: descricaoEmEmoji, quem: quemEmEmoji }),
  );
  const m = textoExtrato(dez, 0, false);
  assertStringIncludes(m.text, "😀".repeat(MAX_DESCRICAO) + "…");
  assertStringIncludes(m.text, "🎉".repeat(MAX_QUEM) + "…");
  assert(
    m.text.length < 4096,
    `textoExtrato com 10 linhas (descrição e nome em emoji) produziu ${m.text.length} caracteres, limite do Telegram é 4096`,
  );
});

const entradaLonga = "9".repeat(4096);
const ecoTruncado = entradaLonga.slice(0, MAX_ENTRADA_ECO) + "…";

Deno.test("erroValor trunca o eco de uma entrada muito longa", () => {
  assertEquals(ecoTruncado.length, MAX_ENTRADA_ECO + 1);

  const m = erroValor(entradaLonga, "formato");
  assertStringIncludes(m.text, ecoTruncado);
  assert(!m.text.includes(entradaLonga));
  assert(
    m.text.length < 4096,
    `erroValor com entrada de ${entradaLonga.length} caracteres produziu texto com ${m.text.length} caracteres, limite do Telegram é 4096`,
  );
});

Deno.test("textoExtrato se autolimita a PAGINA_EXTRATO mesmo recebendo mais linhas", () => {
  // Pior caso por linha: descrição e nome no teto (antes do truncamento) em
  // emoji astral, para que o comprimento renderizado seja o maior possível.
  const piorCaso: Lancamento = { ...lanc, descricao: "😀".repeat(100), quem: "🎉".repeat(110) };
  const vinteECinco: Lancamento[] = Array.from({ length: 25 }, () => ({ ...piorCaso }));

  const m = textoExtrato(vinteECinco, 0, false);
  assertEquals(m.text.split("\n").length, PAGINA_EXTRATO);
  assert(
    m.text.length < 4096,
    `textoExtrato com 25 linhas de pior caso produziu ${m.text.length} caracteres, limite do Telegram é 4096`,
  );
});

Deno.test("a pergunta muda conforme o tipo do lançamento", () => {
  const saida = perguntaDescricao(42, "Saída");
  assertStringIncludes(saida.text, "Qual foi o gasto?");
  assertEquals(extrairLinha(saida.text), 42);

  const entrada = perguntaDescricao(42, "Entrada");
  assertStringIncludes(entrada.text, "Qual a fonte do dinheiro?");
  assert(!entrada.text.includes("gasto"), "entrada não deve perguntar por gasto");
  assertEquals(extrairLinha(entrada.text), 42);

  // sem tipo (botão antigo) cai na pergunta original
  assertEquals(extrairLinha(perguntaDescricao(42).text), 42);
});

Deno.test("o botão de descrever carrega o tipo e muda de rótulo", () => {
  const kbSaida = (confirmacao({ ...lanc, descricao: "" }, 42).reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
  }).inline_keyboard;
  assertEquals(kbSaida[0][0].callback_data, "d|42|S");
  assertStringIncludes(kbSaida[0][0].text, "gasto");

  const kbEntrada = (confirmacao({ ...lanc, tipo: "Entrada", descricao: "" }, 42).reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
  }).inline_keyboard;
  assertEquals(kbEntrada[0][0].callback_data, "d|42|E");
  assertStringIncludes(kbEntrada[0][0].text, "fonte");
});

Deno.test("a âncora do marcador continua fechada para as duas perguntas", () => {
  // o nome de exibição é controlado pelo usuário: nenhuma das duas frases pode
  // ser reconhecida quando aparece no fim de um resumo.
  assertEquals(extrairLinha("Entrada de R$ 10,00 · salário · 04/09 · Ana #2"), null);
  assertEquals(extrairLinha("Qual a fonte do dinheiro? #7 · Ana #2"), null);
  assertEquals(extrairLinha("prefixo Qual a fonte do dinheiro? #7"), null);
});
