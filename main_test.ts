import { assertEquals, assertThrows } from "@std/assert";
import { criarHandler, lerEnv, montarPermitidos } from "./main.ts";

Deno.test("lerEnv falha alto quando a variável não existe", () => {
  assertThrows(() => lerEnv("VARIAVEL_QUE_NAO_EXISTE_12345"), Error, "ausente");
});

Deno.test("montarPermitidos ignora espaços e entradas inválidas", () => {
  assertEquals(montarPermitidos(" 55, 66 ,,abc, 77 "), new Set([55, 66, 77]));
  assertEquals(montarPermitidos(""), new Set());
});

Deno.test("handler ignora tudo que não for POST /webhook", async () => {
  const handler = criarHandler(() => Promise.reject(new Error("não deveria chegar aqui")));
  for (
    const req of [
      new Request("https://x/webhook"),
      new Request("https://x/", { method: "POST" }),
      new Request("https://x/outro", { method: "POST" }),
    ]
  ) {
    assertEquals((await handler(req)).status, 200);
  }
});

Deno.test("exceção no update vira 200, nunca 500", async () => {
  const handler = criarHandler(() => Promise.reject(new Error("boom")));
  const res = await handler(new Request("https://x/webhook", { method: "POST" }));
  assertEquals(res.status, 200);
});

Deno.test("update processado devolve a resposta do grammY", async () => {
  const handler = criarHandler(() => Promise.resolve(new Response("feito", { status: 200 })));
  const res = await handler(new Request("https://x/webhook", { method: "POST" }));
  assertEquals(await res.text(), "feito");
});
