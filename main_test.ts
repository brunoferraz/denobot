import { assertEquals, assertThrows } from "@std/assert";
import { criarHandler, exigirPermitidos, lerEnv, montarPermitidos } from "./main.ts";

Deno.test("lerEnv falha alto quando a variável não existe", () => {
  assertThrows(() => lerEnv("VARIAVEL_QUE_NAO_EXISTE_12345"), Error, "ausente");
});

Deno.test("montarPermitidos ignora espaços e entradas inválidas", () => {
  assertEquals(montarPermitidos(" 55, 66 ,,abc, 77 "), new Set([55, 66, 77]));
  assertEquals(montarPermitidos(""), new Set());
});

Deno.test("exigirPermitidos falha alto quando não sobra nenhum ID válido", () => {
  // "55 66" (espaço, não vírgula) é um typo plausível: montarPermitidos não
  // acha nenhum número válido nesse formato e devolve um Set vazio, que sem
  // esta guarda deixaria o bot subir e ignorar todo mundo em silêncio.
  assertThrows(() => exigirPermitidos("55 66"), Error, "ALLOWED_USER_IDS");
  assertThrows(() => exigirPermitidos(""), Error, "ALLOWED_USER_IDS");
});

Deno.test("exigirPermitidos aceita a allowlist quando ao menos um ID é válido", () => {
  assertEquals(exigirPermitidos(" 55, 66 ,,abc, 77 "), new Set([55, 66, 77]));
});

Deno.test("handler ignora tudo que não for POST /webhook, sem sequer chamar handleUpdate", async () => {
  let chamado = false;
  const handler = criarHandler(() => {
    chamado = true;
    return Promise.reject(new Error("não deveria chegar aqui"));
  });
  for (
    const req of [
      new Request("https://x/webhook"),
      new Request("https://x/", { method: "POST" }),
      new Request("https://x/outro", { method: "POST" }),
    ]
  ) {
    assertEquals((await handler(req)).status, 200);
  }
  assertEquals(chamado, false);
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

Deno.test("status não-200 resolvido normalmente passa direto, não vira 200", async () => {
  // O grammY devolve 401 quando o secret_token do pedido não bate com
  // WEBHOOK_SECRET. Isso precisa aparecer em getWebhookInfo, não ser
  // disfarçado de sucesso.
  const handler = criarHandler(() =>
    Promise.resolve(new Response("unauthorized", { status: 401 }))
  );
  const res = await handler(new Request("https://x/webhook", { method: "POST" }));
  assertEquals(res.status, 401);
});
