import { assertEquals, assertThrows } from "@std/assert";
import { type Callback, decodeCallback, encodeCallback } from "./callback.ts";

const casos: Array<[Callback, string]> = [
  [{ tipo: "n", lancamento: "Entrada", centavos: 5000 }, "n|E|5000"],
  [{ tipo: "n", lancamento: "Saída", centavos: 5000 }, "n|S|5000"],
  [{ tipo: "d", linha: 42 }, "d|42"],
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
    ]
  ) {
    assertEquals(decodeCallback(raw), null, raw);
  }
});

Deno.test("encodeCallback recusa payload acima de 64 bytes", () => {
  assertThrows(() => encodeCallback({ tipo: "m", mes: "x".repeat(70) }));
});
