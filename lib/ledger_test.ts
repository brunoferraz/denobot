import { assertEquals } from "@std/assert";
import type { SheetsClient } from "./sheets.ts";
import type { Lancamento } from "./types.ts";
import { serialParaDate } from "./tempo.ts";
import { criarLedger } from "./ledger.ts";

/** Planilha falsa em memória: cada item é uma linha A..F. */
function sheetsFalso(linhas: unknown[][] = []) {
  const dados = linhas.map((l) => [...l]);
  const client: SheetsClient = {
    // deno-lint-ignore require-await
    async append(_range, novas) {
      dados.push(...novas.map((l) => [...l]));
      return { linha: dados.length + 1 }; // +1 por causa do cabeçalho
    },
    // deno-lint-ignore require-await
    async get(range) {
      const colunas = range.includes("!F")
        ? [5]
        : range.includes("A2:C")
        ? [0, 1, 2]
        : [0, 1, 2, 3, 4];
      return dados.map((l) => colunas.map((i) => l[i]));
    },
    // deno-lint-ignore require-await
    async update(range, valores) {
      const linha = Number(range.match(/(\d+)$/)![1]);
      dados[linha - 2][3] = valores[0][0];
    },
  };
  return { client, dados };
}

const SERIAL_04_09 = 46269; // 2026-09-04
const SERIAL_28_08 = 46262; // 2026-08-28

const novo = (over: Partial<Lancamento> = {}): Lancamento => ({
  data: serialParaDate(SERIAL_04_09),
  tipo: "Saída",
  centavos: 5000,
  descricao: "",
  quem: "Bruno",
  ...over,
});

Deno.test("registrar grava valor como número e devolve a linha", async () => {
  const { client, dados } = sheetsFalso();
  const ledger = criarLedger(client);

  const r = await ledger.registrar(novo({ centavos: 5055 }), 7);

  assertEquals(r, { linha: 2, duplicado: false });
  assertEquals(dados[0][1], "Saída");
  assertEquals(dados[0][2], 50.55);
  assertEquals(typeof dados[0][2], "number");
  assertEquals(dados[0][5], 7);
});

Deno.test("registrar ignora update_id já visto", async () => {
  const { client, dados } = sheetsFalso([
    [SERIAL_04_09, "Saída", 50, "", "Bruno", 7],
  ]);
  const ledger = criarLedger(client);

  const r = await ledger.registrar(novo(), 7);

  assertEquals(r, { linha: 2, duplicado: true });
  assertEquals(dados.length, 1, "não deveria ter gravado de novo");
});

Deno.test("descrever escreve na coluna D da linha certa", async () => {
  const { client, dados } = sheetsFalso([
    [SERIAL_04_09, "Saída", 50, "", "Bruno", 7],
    [SERIAL_04_09, "Saída", 30, "", "Ana", 8],
  ]);
  const ledger = criarLedger(client);

  await ledger.descrever(3, "farmácia");

  assertEquals(dados[1][3], "farmácia");
  assertEquals(dados[0][3], "");
});

Deno.test("saldo separa o mês pedido do acumulado geral", async () => {
  const { client } = sheetsFalso([
    [SERIAL_28_08, "Entrada", 100, "", "Bruno", 1],
    [SERIAL_04_09, "Entrada", 2000, "salário", "Bruno", 2],
    [SERIAL_04_09, "Saída", 350, "mercado", "Ana", 3],
  ]);
  const ledger = criarLedger(client);

  assertEquals(await ledger.saldo("2026-09"), {
    mes: "2026-09",
    entradasCentavos: 200000,
    saidasCentavos: 35000,
    resultadoCentavos: 165000,
    acumuladoCentavos: 175000,
  });
});

Deno.test("saldo de mês sem lançamentos devolve zeros mas mantém o acumulado", async () => {
  const { client } = sheetsFalso([[SERIAL_04_09, "Entrada", 100, "", "Bruno", 1]]);
  const ledger = criarLedger(client);

  assertEquals(await ledger.saldo("2026-07"), {
    mes: "2026-07",
    entradasCentavos: 0,
    saidasCentavos: 0,
    resultadoCentavos: 0,
    acumuladoCentavos: 10000,
  });
});

Deno.test("saldo de planilha vazia devolve tudo zerado", async () => {
  const { client } = sheetsFalso();
  const ledger = criarLedger(client);
  const s = await ledger.saldo("2026-09");
  assertEquals(s.acumuladoCentavos, 0);
  assertEquals(s.resultadoCentavos, 0);
});

Deno.test("extrato devolve do mais recente para o mais antigo, paginado", async () => {
  const linhas = Array.from({ length: 12 }, (_, i) => [
    SERIAL_04_09,
    "Saída",
    i + 1,
    `item ${i + 1}`,
    "Bruno",
    i,
  ]);
  const { client } = sheetsFalso(linhas);
  const ledger = criarLedger(client);

  const p1 = await ledger.extrato(0, 10);
  assertEquals(p1.itens.length, 10);
  assertEquals(p1.itens[0].descricao, "item 12");
  assertEquals(p1.temMais, true);

  const p2 = await ledger.extrato(10, 10);
  assertEquals(p2.itens.map((i) => i.descricao), ["item 2", "item 1"]);
  assertEquals(p2.temMais, false);
});

Deno.test("linhas corrompidas por edição manual são ignoradas, não derrubam o bot", async () => {
  const { client } = sheetsFalso([
    [SERIAL_04_09, "Entrada", 100, "", "Bruno", 1],
    ["texto solto", "Entrada", "não é número", "", "", 2],
    [SERIAL_04_09, "Tipo Errado", 50, "", "", 3],
    [],
  ]);
  const ledger = criarLedger(client);

  const s = await ledger.saldo("2026-09");
  assertEquals(s.acumuladoCentavos, 10000);
  assertEquals((await ledger.extrato(0, 10)).itens.length, 1);
});

// --- Achados carregados da revisão da Task 3: paraLancamento é o funil de
// ingestão da planilha, então é onde esses três casos precisam ser barrados
// (ou normalizados) para não vazar para render.ts. ---

Deno.test("linha com valor absurdo (acima do limite) é rejeitada como corrompida", async () => {
  const { client } = sheetsFalso([
    [SERIAL_04_09, "Entrada", 100, "", "Bruno", 1],
    // 1e12 reais * 100 = 1e14 centavos, muito acima de LIMITE_CENTAVOS.
    [SERIAL_04_09, "Entrada", 1e12, "", "Bruno", 2],
  ]);
  const ledger = criarLedger(client);

  const extrato = await ledger.extrato(0, 10);
  assertEquals(extrato.itens.length, 1);

  const s = await ledger.saldo("2026-09");
  assertEquals(s.acumuladoCentavos, 10000);
});

Deno.test("linha curta (células finais omitidas pela API do Sheets) vira quem = string vazia, nunca undefined", async () => {
  const { client } = sheetsFalso([
    // Só A, B, C: D (descrição) e E (quem) vêm ausentes do array, não "".
    [SERIAL_04_09, "Entrada", 100],
  ]);
  const ledger = criarLedger(client);

  const extrato = await ledger.extrato(0, 10);
  assertEquals(extrato.itens.length, 1);
  assertEquals(extrato.itens[0].quem, "");
  assertEquals(typeof extrato.itens[0].quem, "string");
  assertEquals(extrato.itens[0].descricao, "");
});

Deno.test("linha com tipo fora da união (número ou ausente) é rejeitada", async () => {
  const { client } = sheetsFalso([
    [SERIAL_04_09, "Entrada", 100, "", "Bruno", 1],
    [SERIAL_04_09, 123, 50, "", "Ana", 2], // tipo é número
    [SERIAL_04_09, undefined, 50, "", "Ana", 3], // tipo ausente
  ]);
  const ledger = criarLedger(client);

  const extrato = await ledger.extrato(0, 10);
  assertEquals(extrato.itens.length, 1);
});

Deno.test("linha com valor negativo (edição manual) é rejeitada, não vira ganho ilusório no saldo", async () => {
  const { client } = sheetsFalso([
    [SERIAL_04_09, "Entrada", 200, "", "Bruno", 1],
    // -50 digitado à mão numa linha de Saída: sem o guard, o sinal negativo
    // do valor se soma ao sinal (-1) do tipo "Saída" e vira +50 no acumulado
    // — uma saída passaria a ENGORDAR o saldo em vez de reduzi-lo.
    [SERIAL_04_09, "Saída", -50, "", "Bruno", 2],
  ]);
  const ledger = criarLedger(client);

  const s = await ledger.saldo("2026-09");
  assertEquals(s.saidasCentavos, 0, "a saída negativa não deveria contar no mês");
  assertEquals(s.acumuladoCentavos, 20000, "a saída negativa não deveria contar no acumulado");

  const extrato = await ledger.extrato(0, 10);
  assertEquals(extrato.itens.length, 1, "a linha negativa deveria ser excluída do extrato também");
});
