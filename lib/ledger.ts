import type { SheetsClient } from "./sheets.ts";
import { LIMITE_CENTAVOS } from "./money.ts";
import type { Lancamento, Saldo, TipoLancamento } from "./types.ts";
import { dataParaISO, mesDe, serialParaDate } from "./tempo.ts";

export const ABA = "Lançamentos";
export const CABECALHO = ["Data", "Tipo", "Valor", "Descrição", "Quem", "update_id"];

/** Quantos update_id recentes olhar ao procurar reentrega do Telegram. */
const JANELA_DEDUPE = 20;

export interface Ledger {
  registrar(l: Lancamento, updateId: number): Promise<{ linha: number; duplicado: boolean }>;
  descrever(linha: number, descricao: string): Promise<void>;
  saldo(mes: string): Promise<Saldo>;
  extrato(offset: number, limite: number): Promise<{ itens: Lancamento[]; temMais: boolean }>;
  /**
   * Relê uma única linha já gravada. Existe para o fluxo de §6.2: depois de
   * `descrever`, o bot precisa reconstruir a confirmação completa (valor,
   * tipo, quem) para reexibi-la com a descrição e o botão de compartilhar —
   * e a planilha é a única fonte dessas informações, já que bot.ts não guarda
   * estado entre as duas mensagens. Devolve null se a linha estiver
   * corrompida, pelo mesmo critério de paraLancamento.
   */
  obterLancamento(linha: number): Promise<Lancamento | null>;
}

function ehTipo(v: unknown): v is TipoLancamento {
  return v === "Entrada" || v === "Saída";
}

/**
 * Converte uma linha da planilha em Lancamento, ou null se ela não for válida.
 * A planilha é editável à mão: uma linha estragada não pode derrubar o bot.
 *
 * Este é o único funil pelo qual dados da planilha entram no domínio, então é
 * aqui que se barra tudo que quebraria a camada de apresentação: centavos sem
 * limite superior estouram o /extrato (4096 chars do Telegram); quem/descrição
 * ausentes (células finais que a API do Sheets omite numa linha curta) viram
 * "" em vez de undefined, porque render.ts faz Array.from(l.quem); e tipo fora
 * da união vira o literal "undefined" se deixado passar.
 */
function paraLancamento(linha: unknown[]): Lancamento | null {
  const [data, tipo, valor, descricao, quem] = linha;
  if (typeof data !== "number" || !Number.isFinite(data)) return null;
  if (!ehTipo(tipo)) return null;
  if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
  const centavos = Math.round(valor * 100);
  if (centavos < 0 || centavos > LIMITE_CENTAVOS) return null;
  return {
    data: serialParaDate(data),
    tipo,
    centavos,
    descricao: descricao == null ? "" : String(descricao),
    quem: quem == null ? "" : String(quem),
  };
}

export function criarLedger(sheets: SheetsClient): Ledger {
  async function todos(): Promise<Lancamento[]> {
    const linhas = await sheets.get(`${ABA}!A2:E`);
    return linhas.map(paraLancamento).filter((l): l is Lancamento => l !== null);
  }

  return {
    async registrar(l, updateId) {
      const ids = (await sheets.get(`${ABA}!F2:F`)).map((r) => r[0]);
      const inicio = Math.max(0, ids.length - JANELA_DEDUPE);
      const jaVisto = ids.indexOf(updateId, inicio);
      if (jaVisto >= 0) return { linha: jaVisto + 2, duplicado: true };

      const { linha } = await sheets.append(`${ABA}!A:F`, [[
        dataParaISO(l.data),
        l.tipo,
        l.centavos / 100,
        l.descricao,
        l.quem,
        updateId,
      ]]);
      return { linha, duplicado: false };
    },

    async descrever(linha, descricao) {
      await sheets.update(`${ABA}!D${linha}`, [[descricao]]);
    },

    async obterLancamento(linha) {
      const linhas = await sheets.get(`${ABA}!A${linha}:E${linha}`);
      return linhas[0] ? paraLancamento(linhas[0]) : null;
    },

    async saldo(mes) {
      const linhas = await sheets.get(`${ABA}!A2:C`);
      let entradasCentavos = 0;
      let saidasCentavos = 0;
      let acumuladoCentavos = 0;

      for (const bruta of linhas) {
        const l = paraLancamento(bruta);
        if (!l) continue;
        const sinal = l.tipo === "Entrada" ? 1 : -1;
        acumuladoCentavos += sinal * l.centavos;
        if (mesDe(l.data) !== mes) continue;
        if (l.tipo === "Entrada") entradasCentavos += l.centavos;
        else saidasCentavos += l.centavos;
      }

      return {
        mes,
        entradasCentavos,
        saidasCentavos,
        resultadoCentavos: entradasCentavos - saidasCentavos,
        acumuladoCentavos,
      };
    },

    async extrato(offset, limite) {
      const itens = (await todos()).reverse();
      return {
        itens: itens.slice(offset, offset + limite),
        temMais: itens.length > offset + limite,
      };
    },
  };
}
