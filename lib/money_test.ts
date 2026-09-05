import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { type ErroValor, formatarBRL, pareceValor, parseValor } from "./money.ts";

const validos: Array<[string, number]> = [
  ["50", 5000],
  ["0,50", 50],
  ["50,5", 5050],
  ["50,55", 5055],
  ["50.5", 5050],
  ["50.55", 5055],
  ["1.234", 123400],
  ["1,234", 123400],
  ["1.000.000", 100000000],
  ["1.234,56", 123456],
  ["1,234.56", 123456],
  ["R$ 12,30", 1230],
  ["r$12,30", 1230],
  [" 42 ", 4200],
  ["+50", 5000],
  ["1000000", 100000000],
];

Deno.test("parseValor aceita os formatos previstos", () => {
  for (const [entrada, esperado] of validos) {
    assertEquals(parseValor(entrada), { ok: true, centavos: esperado }, entrada);
  }
});

const invalidos: Array<[string, ErroValor]> = [
  ["50,5555", "formato"],
  ["12..3", "formato"],
  ["1.23.4", "formato"],
  ["1.234.56", "formato"],
  ["1234.567", "formato"],
  ["50.", "formato"],
  ["abc", "formato"],
  ["R$ abc4", "formato"],
  ["", "formato"],
  ["-50", "negativo"],
  ["0", "zero"],
  ["0,00", "zero"],
  ["1000000,01", "muito-alto"],
];

Deno.test("parseValor recusa o que não bate com nenhuma regra", () => {
  for (const [entrada, erro] of invalidos) {
    assertEquals(parseValor(entrada), { ok: false, erro }, entrada);
  }
});

Deno.test("pareceValor separa tentativa de valor de conversa solta", () => {
  for (const t of ["50", "50,5555", "12..3", "R$ abc4", "quero 30"]) {
    assertEquals(pareceValor(t), true, t);
  }
  for (const t of ["oi", "bom dia", "obrigado", ""]) {
    assertEquals(pareceValor(t), false, t);
  }
});

Deno.test("formatarBRL usa separadores pt-BR e duas casas", () => {
  assertEquals(formatarBRL(5000), "50,00");
  assertEquals(formatarBRL(123456), "1.234,56");
  assertEquals(formatarBRL(7), "0,07");
  assertEquals(formatarBRL(100000000), "1.000.000,00");
});
