import { assert, assertEquals, assertRejects } from "@std/assert";
import { criarSheets, ErroSheets } from "./sheets.ts";

function fetchFalso(respostas: Response[]) {
  const chamadas: Array<{ url: string; method: string; auth: string; body: unknown }> = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    chamadas.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.get("authorization") ?? "",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Promise.resolve(respostas.shift() ?? new Response("sem resposta", { status: 500 }));
  };
  return { impl: impl as unknown as typeof fetch, chamadas };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const token = () => Promise.resolve("ya29.token");

Deno.test("append usa USER_ENTERED + INSERT_ROWS e devolve a linha gravada", async () => {
  const { impl, chamadas } = fetchFalso([
    json({ updates: { updatedRange: "Lançamentos!A42:F42" } }),
  ]);
  const sheets = criarSheets("PLANILHA", token, impl);

  const { linha } = await sheets.append("Lançamentos!A:F", [[
    "2026-09-04 14:32:00",
    "Saída",
    50.5,
    "",
    "Bruno",
    7,
  ]]);

  assertEquals(linha, 42);
  assertEquals(chamadas[0].method, "POST");
  assertEquals(chamadas[0].auth, "Bearer ya29.token");
  assert(chamadas[0].url.includes("/v4/spreadsheets/PLANILHA/values/"));
  assert(chamadas[0].url.includes(":append"));
  assert(chamadas[0].url.includes("valueInputOption=USER_ENTERED"));
  assert(chamadas[0].url.includes("insertDataOption=INSERT_ROWS"));
  assertEquals(chamadas[0].body, {
    values: [["2026-09-04 14:32:00", "Saída", 50.5, "", "Bruno", 7]],
  });
});

Deno.test("get pede UNFORMATTED_VALUE e devolve [] quando a faixa está vazia", async () => {
  const { impl, chamadas } = fetchFalso([json({}), json({ values: [["a", 1]] })]);
  const sheets = criarSheets("PLANILHA", token, impl);

  assertEquals(await sheets.get("Lançamentos!A2:C"), []);
  assert(chamadas[0].url.includes("valueRenderOption=UNFORMATTED_VALUE"));
  assertEquals(await sheets.get("Lançamentos!A2:C"), [["a", 1]]);
});

Deno.test("update faz PUT na faixa indicada", async () => {
  const { impl, chamadas } = fetchFalso([json({})]);
  const sheets = criarSheets("PLANILHA", token, impl);

  await sheets.update("Lançamentos!D42", [["mercado"]]);

  assertEquals(chamadas[0].method, "PUT");
  assertEquals(chamadas[0].body, { values: [["mercado"]] });
  assert(chamadas[0].url.includes("valueInputOption=USER_ENTERED"));
});

Deno.test("403 vira um erro que nomeia o compartilhamento com a service account", async () => {
  const { impl } = fetchFalso([
    new Response("The caller does not have permission", {
      status: 403,
    }),
  ]);
  const sheets = criarSheets("PLANILHA", token, impl);

  const erro = await assertRejects(() => sheets.get("Lançamentos!A2:C"), ErroSheets);
  assertEquals((erro as ErroSheets).status, 403);
  assert(erro.message.includes("compartilhada"));
});

Deno.test("outros erros HTTP carregam status e corpo", async () => {
  const { impl } = fetchFalso([new Response("quota exceeded", { status: 429 })]);
  const sheets = criarSheets("PLANILHA", token, impl);

  const erro = await assertRejects(() => sheets.get("Lançamentos!A2:C"), ErroSheets);
  assertEquals((erro as ErroSheets).status, 429);
  assert(erro.message.includes("quota exceeded"));
});

Deno.test("append rejeita resposta sem updatedRange reconhecível", async () => {
  const { impl } = fetchFalso([json({ updates: {} })]);
  const sheets = criarSheets("PLANILHA", token, impl);
  await assertRejects(() => sheets.append("Lançamentos!A:F", [["x"]]), Error);
});
