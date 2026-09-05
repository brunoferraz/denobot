export const LIMITE_CENTAVOS = 100_000_000; // R$ 1.000.000,00

export type ErroValor = "formato" | "zero" | "negativo" | "muito-alto";

export type ParseResult =
  | { ok: true; centavos: number }
  | { ok: false; erro: ErroValor };

/** Uma mensagem com ao menos um dígito é tratada como tentativa de informar um valor. */
export function pareceValor(texto: string): boolean {
  return /\d/.test(texto);
}

/** Grupos separados por milhar: o primeiro tem 1–3 dígitos, os demais exatamente 3. */
function milharValido(partes: string[]): boolean {
  if (partes.length < 2) return false;
  if (!/^\d{1,3}$/.test(partes[0])) return false;
  return partes.slice(1).every((p) => /^\d{3}$/.test(p));
}

export function parseValor(entrada: string): ParseResult {
  let s = entrada.trim().toLowerCase().replace(/r\$/g, "").replace(/\s/g, "");

  let negativo = false;
  if (s.startsWith("-")) {
    negativo = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return { ok: false, erro: "formato" };

  const pontos = (s.match(/\./g) ?? []).length;
  const virgulas = (s.match(/,/g) ?? []).length;
  let normalizado: string;

  if (pontos > 0 && virgulas > 0) {
    // Os dois separadores presentes: o ÚLTIMO é o decimal, o outro é milhar.
    const decimal = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const milhar = decimal === "." ? "," : ".";
    if ((decimal === "." ? pontos : virgulas) !== 1) return { ok: false, erro: "formato" };
    const [inteiro, frac] = s.split(decimal);
    if (!milharValido(inteiro.split(milhar))) return { ok: false, erro: "formato" };
    if (!/^\d{1,2}$/.test(frac)) return { ok: false, erro: "formato" };
    normalizado = inteiro.split(milhar).join("") + "." + frac;
  } else if (pontos + virgulas === 0) {
    normalizado = s;
  } else {
    const sep = pontos > 0 ? "." : ",";
    const partes = s.split(sep);
    const depois = partes[partes.length - 1].length;

    if (partes.length > 2) {
      // Separador repetido: só pode ser milhar.
      if (!milharValido(partes)) return { ok: false, erro: "formato" };
      normalizado = partes.join("");
    } else if (depois === 1 || depois === 2) {
      normalizado = partes.join(".");
    } else if (depois === 3) {
      // Ambíguo entre decimal e milhar; no contexto pt-BR, milhar.
      if (!milharValido(partes)) return { ok: false, erro: "formato" };
      normalizado = partes.join("");
    } else {
      return { ok: false, erro: "formato" };
    }
  }

  if (!/^\d+(\.\d{1,2})?$/.test(normalizado)) return { ok: false, erro: "formato" };

  const centavos = Math.round(Number(normalizado) * 100);
  if (!Number.isFinite(centavos)) return { ok: false, erro: "formato" };
  if (centavos === 0) return { ok: false, erro: "zero" };
  if (negativo) return { ok: false, erro: "negativo" };
  if (centavos > LIMITE_CENTAVOS) return { ok: false, erro: "muito-alto" };
  return { ok: true, centavos };
}

/** Formata centavos como "1.234,56" — sem o prefixo "R$". */
export function formatarBRL(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
