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
  // conta linhas de LANÇAMENTO (as que têm bolinha), não linhas do texto — o
  // rodapé de totais também ocupa linhas e não deve entrar nesta contagem.
  assertEquals(
    m.text.split("\n").filter((l) => l.includes("🟢") || l.includes("🔴")).length,
    PAGINA_EXTRATO,
  );
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

Deno.test("ícones: setas indicam a natureza do lançamento", () => {
  const kb = (perguntaTipo(5000).reply_markup as {
    inline_keyboard: Array<Array<{ text: string }>>;
  }).inline_keyboard[0];
  assertStringIncludes(kb[0].text, "\u2197\uFE0F"); // ArrowUpRight = entrada
  assertStringIncludes(kb[1].text, "\u2198\uFE0F"); // ArrowDownRight = saída

  // No extrato a pergunta é "isso me fez bem ou mal?" — cor responde mais rápido
  // que direção numa lista que se lê batendo o olho.
  assertStringIncludes(textoExtrato([{ ...lanc, tipo: "Saída" }], 0, false).text, "\u{1F534}");
  assertStringIncludes(textoExtrato([{ ...lanc, tipo: "Entrada" }], 0, false).text, "\u{1F7E2}");
  // e as setas não sobram por lá
  assert(!textoExtrato([{ ...lanc, tipo: "Saída" }], 0, false).text.includes("\u2198\uFE0F"));
});

Deno.test("ícones: sinal do saldo usa mais/menos, não seta", () => {
  const base = { mes: "2026-09", entradasCentavos: 200000, saidasCentavos: 35000 };

  // O sinal fica no FIM da linha: como prefixo, o emoji é mais largo que os
  // espaços das outras linhas e desalinharia a coluna do rótulo.
  const linhaCom = (t: string, rotulo: string) => t.split("\n").find((l) => l.includes(rotulo))!;

  const positivo = textoSaldo({ ...base, resultadoCentavos: 165000, acumuladoCentavos: 482000 });
  assert(linhaCom(positivo.text, "Resultado").endsWith("\u2795"));
  assert(linhaCom(positivo.text, "Acumulado").endsWith("\u2795"));
  assert(!positivo.text.includes("\u2796"), "resultado positivo não deve trazer menos");

  const negativo = textoSaldo({ ...base, resultadoCentavos: -165000, acumuladoCentavos: -482000 });
  assert(linhaCom(negativo.text, "Resultado").endsWith("\u2796"));
  assert(linhaCom(negativo.text, "Acumulado").endsWith("\u2796"));
  // o número mantém o sinal: o ícone reforça, não substitui
  assertStringIncludes(negativo.text, "-1.650,00");
});

Deno.test("ícones: o 'Ver mais' continua sendo seta para baixo", () => {
  // Aqui a seta significa "há mais abaixo", não "entrada" — trocá-la por ↙️
  // seria um busca-e-substitui cego.
  const kb = (textoExtrato([lanc], 0, true).reply_markup as {
    inline_keyboard: Array<Array<{ text: string }>>;
  }).inline_keyboard;
  assertStringIncludes(kb[0][0].text, "\u2B07\uFE0F");
});

Deno.test("extrato traz rodapé com entradas, saídas e líquido dos exibidos", () => {
  const d = lanc.data;
  const m = textoExtrato(
    [
      { data: d, tipo: "Saída", centavos: 20000, descricao: "mercado", quem: "Bruno" },
      { data: d, tipo: "Entrada", centavos: 15000, descricao: "salário", quem: "Bruno" },
      { data: d, tipo: "Entrada", centavos: 123456, descricao: "salário", quem: "Bruno" },
    ],
    0,
    false,
  );

  assertStringIncludes(m.text, "Entradas");
  assertStringIncludes(m.text, "1.384,56");
  assertStringIncludes(m.text, "Saídas");
  assertStringIncludes(m.text, "200,00");
  const liq = m.text.split("\n").find((l) => l.includes("Líquido"))!;
  assert(liq.endsWith("\u2795"), "líquido positivo termina com mais");
  assertStringIncludes(liq, "1.184,56");
});

Deno.test("o rodapé conta só as linhas exibidas, não as recebidas", () => {
  // textoExtrato corta em PAGINA_EXTRATO; somar antes do corte faria o rodapé
  // falar de 25 lançamentos enquanto a lista mostra 10.
  const d = lanc.data;
  const vinteCinco = Array.from({ length: 25 }, () => ({
    data: d,
    tipo: "Entrada" as const,
    centavos: 10000,
    descricao: "x",
    quem: "b",
  }));
  const m = textoExtrato(vinteCinco, 0, true);
  assertEquals(m.text.split("\n").filter((l) => l.includes("🟢")).length, PAGINA_EXTRATO);
  assertStringIncludes(m.text, "1.000,00"); // 10 x R$ 100,00, não 25
  assert(!m.text.includes("2.500,00"));
});

Deno.test("líquido negativo no extrato usa o sinal de menos", () => {
  const d = lanc.data;
  const m = textoExtrato(
    [
      { data: d, tipo: "Saída", centavos: 50000, descricao: "aluguel", quem: "b" },
      { data: d, tipo: "Entrada", centavos: 10000, descricao: "troco", quem: "b" },
    ],
    0,
    false,
  );
  const liq = m.text.split("\n").find((l) => l.includes("Líquido"))!;
  assert(liq.endsWith("\u2796"), "líquido negativo termina com menos");
  assertStringIncludes(liq, "-400,00");
});

Deno.test("extrato vazio não ganha rodapé", () => {
  const m = textoExtrato([], 0, false);
  assert(!m.text.includes("Líquido"));
});

Deno.test("as colunas de total ficam alinhadas em saldo e extrato", () => {
  // O alinhamento é um requisito de leitura, não estética: sem um teste, um
  // prefixo novo (um emoji, um rótulo mais longo) desloca a coluna em silêncio.
  const colunas = (texto: string) =>
    texto.split("\n").filter((l) => l.includes("R$")).map((l) => ({
      linha: l,
      rs: l.indexOf("R$"),
      fim: l.indexOf("R$") + l.slice(l.indexOf("R$")).search(/\d[.,\d]*(?=\D*$)/),
    }));

  const s = colunas(
    textoSaldo({
      mes: "2026-09",
      entradasCentavos: 138456,
      saidasCentavos: 20000,
      resultadoCentavos: 118456,
      acumuladoCentavos: 118456,
    }).text,
  );
  assertEquals(s.length, 4, "saldo tem quatro linhas de valor");
  for (const c of s) {
    assertEquals(c.rs, s[0].rs, `"R$" fora de coluna em: ${JSON.stringify(c.linha)}`);
  }

  const d = lanc.data;
  const e = colunas(
    textoExtrato(
      [
        { data: d, tipo: "Saída", centavos: 20000, descricao: "mercado", quem: "Bruno" },
        { data: d, tipo: "Entrada", centavos: 123456, descricao: "salário", quem: "Bruno" },
      ],
      0,
      false,
    ).text,
  );
  assertEquals(e.length, 3, "extrato tem três linhas de total");
  for (const c of e) {
    assertEquals(c.rs, e[0].rs, `"R$" fora de coluna em: ${JSON.stringify(c.linha)}`);
  }

  // e os valores terminam todos na mesma coluna (padStart faz o trabalho)
  const fimSaldo = s.map((c) => c.linha.replace(/ ?[➕➖]$/, "").length);
  assertEquals(new Set(fimSaldo).size, 1, "valores do saldo não terminam na mesma coluna");
});
