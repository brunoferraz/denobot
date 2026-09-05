import { assertEquals, assertThrows } from "@std/assert";
import { type Callback, decodeCallback, encodeCallback } from "./callback.ts";

const casos: Array<[Callback, string]> = [
  [{ tipo: "n", lancamento: "Entrada", centavos: 5000 }, "n|E|5000"],
  [{ tipo: "n", lancamento: "Saída", centavos: 5000 }, "n|S|5000"],
  [{ tipo: "n", lancamento: "Entrada", centavos: 100_000_000 }, "n|E|100000000"],
  [{ tipo: "d", linha: 42 }, "d|42"],
  [{ tipo: "d", linha: 42, lancamento: "Entrada" }, "d|42|E"],
  [{ tipo: "d", linha: 7, lancamento: "Saída" }, "d|7|S"],
  [{ tipo: "m", mes: "2026-08" }, "m|2026-08"],
  [{ tipo: "x", offset: 20 }, "x|20"],
];

Deno.test("encodeCallback produz o formato compacto esperado", () => {
  for (const [cb, esperado] of casos) assertEquals(encodeCallback(cb), esperado);
});

Deno.test("decodeCallback é o inverso de encodeCallback", () => {
  for (const [cb, raw] of casos) assertEquals(decodeCallback(raw), cb);
});

Deno.test("decodeCallback devolve null para entrada inválida", () => {
  for (const raw of ["", "z|1", "n|X|5000", "n|E|abc", "d|", "d|x", "m|agosto", "x|-1"]) {
    assertEquals(decodeCallback(raw), null, raw);
  }
});

Deno.test("decodeCallback rejeita valores fora do domínio válido", () => {
  for (
    const raw of [
      "d|0",
      "d|007",
      "d|99999999999999999999",
      "m|2026-13",
      "m|0000-00",
      "n|E|0",
      "n|E|007",
      "n|E|99999999999999999999",
      "n|E|900000000000000",
      "x|99999999999999999999",
    ]
  ) {
    assertEquals(decodeCallback(raw), null, raw);
  }
});

Deno.test("encodeCallback recusa payload acima de 64 bytes", () => {
  assertThrows(() => encodeCallback({ tipo: "m", mes: "x".repeat(70) }));
});

Deno.test("o tipo no callback de descrição é opcional e validado", () => {
  // sem tipo continua válido: botões já enviados antes desta mudança seguem vivos
  assertEquals(decodeCallback("d|42"), { tipo: "d", linha: 42 });
  // com tipo, reconstrói o lançamento
  assertEquals(decodeCallback("d|42|E"), { tipo: "d", linha: 42, lancamento: "Entrada" });
  assertEquals(decodeCallback("d|42|S"), { tipo: "d", linha: 42, lancamento: "Saída" });
  // letra fora do domínio é recusada, como no ramo `n`
  for (const raw of ["d|42|X", "d|42|e", "d|42|", "d|42|E|S", "d|0|E", "d|007|E"]) {
    assertEquals(decodeCallback(raw), null, raw);
  }
});
