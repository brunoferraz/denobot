import { LIMITE_CENTAVOS } from "./money.ts";
import type { TipoLancamento } from "./types.ts";

export const LIMITE_CALLBACK_BYTES = 64;

export type Callback =
  | { tipo: "n"; lancamento: TipoLancamento; centavos: number }
  /**
   * `lancamento` é opcional de propósito: botões emitidos antes de a pergunta
   * variar por tipo carregam só a linha (`d|42`), e continuam válidos. Quando
   * presente, decide se a pergunta é "qual foi o gasto" ou "qual a fonte".
   */
  | { tipo: "d"; linha: number; lancamento?: TipoLancamento }
  | { tipo: "m"; mes: string }
  | { tipo: "x"; offset: number };

export function encodeCallback(cb: Callback): string {
  let raw: string;
  switch (cb.tipo) {
    case "n":
      raw = `n|${cb.lancamento === "Entrada" ? "E" : "S"}|${cb.centavos}`;
      break;
    case "d":
      raw = cb.lancamento
        ? `d|${cb.linha}|${cb.lancamento === "Entrada" ? "E" : "S"}`
        : `d|${cb.linha}`;
      break;
    case "m":
      raw = `m|${cb.mes}`;
      break;
    case "x":
      raw = `x|${cb.offset}`;
      break;
  }
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > LIMITE_CALLBACK_BYTES) {
    throw new Error(`callback_data com ${bytes} bytes excede o limite de ${LIMITE_CALLBACK_BYTES}`);
  }
  return raw;
}

const INTEIRO_POSITIVO = /^\d+$/;
const INTEIRO_SEM_ZERO_A_ESQUERDA = /^[1-9]\d*$/;
const MES_VALIDO = /^\d{4}-(0[1-9]|1[0-2])$/;

export function decodeCallback(raw: string): Callback | null {
  const partes = raw.split("|");
  switch (partes[0]) {
    case "n": {
      const [, letra, centavosRaw] = partes;
      if (partes.length !== 3) return null;
      if (letra !== "E" && letra !== "S") return null;
      if (!INTEIRO_SEM_ZERO_A_ESQUERDA.test(centavosRaw)) return null;
      const centavos = Number(centavosRaw);
      if (!Number.isSafeInteger(centavos)) return null;
      if (centavos > LIMITE_CENTAVOS) return null;
      return {
        tipo: "n",
        lancamento: letra === "E" ? "Entrada" : "Saída",
        centavos,
      };
    }
    case "d": {
      if (partes.length !== 2 && partes.length !== 3) return null;
      if (!INTEIRO_SEM_ZERO_A_ESQUERDA.test(partes[1])) return null;
      const linha = Number(partes[1]);
      if (!Number.isSafeInteger(linha)) return null;
      if (partes.length === 2) return { tipo: "d", linha };
      const letra = partes[2];
      if (letra !== "E" && letra !== "S") return null;
      return { tipo: "d", linha, lancamento: letra === "E" ? "Entrada" : "Saída" };
    }
    case "m": {
      if (partes.length !== 2 || !MES_VALIDO.test(partes[1])) return null;
      return { tipo: "m", mes: partes[1] };
    }
    case "x": {
      if (partes.length !== 2 || !INTEIRO_POSITIVO.test(partes[1])) return null;
      const offset = Number(partes[1]);
      if (!Number.isSafeInteger(offset)) return null;
      return { tipo: "x", offset };
    }
    default:
      return null;
  }
}
