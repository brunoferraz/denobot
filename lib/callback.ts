import type { TipoLancamento } from "./types.ts";

export const LIMITE_CALLBACK_BYTES = 64;

export type Callback =
  | { tipo: "n"; lancamento: TipoLancamento; centavos: number }
  | { tipo: "d"; linha: number }
  | { tipo: "m"; mes: string }
  | { tipo: "x"; offset: number };

export function encodeCallback(cb: Callback): string {
  let raw: string;
  switch (cb.tipo) {
    case "n":
      raw = `n|${cb.lancamento === "Entrada" ? "E" : "S"}|${cb.centavos}`;
      break;
    case "d":
      raw = `d|${cb.linha}`;
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
      return {
        tipo: "n",
        lancamento: letra === "E" ? "Entrada" : "Saída",
        centavos,
      };
    }
    case "d": {
      if (partes.length !== 2 || !INTEIRO_SEM_ZERO_A_ESQUERDA.test(partes[1])) return null;
      const linha = Number(partes[1]);
      if (!Number.isSafeInteger(linha)) return null;
      return { tipo: "d", linha };
    }
    case "m": {
      if (partes.length !== 2 || !MES_VALIDO.test(partes[1])) return null;
      return { tipo: "m", mes: partes[1] };
    }
    case "x": {
      if (partes.length !== 2 || !INTEIRO_POSITIVO.test(partes[1])) return null;
      return { tipo: "x", offset: Number(partes[1]) };
    }
    default:
      return null;
  }
}
