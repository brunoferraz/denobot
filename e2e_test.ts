/**
 * Validação end-to-end da pilha inteira, sem rede.
 *
 * Monta o servidor exatamente como `main.ts` monta — mesmo `criarAuth` ->
 * `criarSheets` -> `criarLedger` -> `criarBot` -> `webhookCallback` ->
 * `criarHandler` — trocando apenas o `fetch`, que aponta para um Google
 * falso: endpoint de token que VERIFICA a assinatura RS256 com a chave
 * pública, e uma planilha em memória que reproduz a semântica do
 * `USER_ENTERED` (string ISO vira serial, número continua número) e do
 * `UNFORMATTED_VALUE` na leitura.
 *
 * É essa conversão ISO -> serial -> Date que fecha o laço do invariante de
 * data: se a normalização de fuso quebrar em qualquer costura, o dia ou o
 * mês saem errados aqui, e nenhum teste unitário pegaria.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { webhookCallback } from "grammy";
import type { Update } from "grammy/types";
import { criarBot } from "./bot.ts";
import { criarAuth, type ServiceAccount } from "./lib/google_auth.ts";
import { criarSheets } from "./lib/sheets.ts";
import { CABECALHO, criarLedger } from "./lib/ledger.ts";
import { criarHandler } from "./main.ts";

const SEGREDO = "segredo-do-webhook";
const EU = 55;
const ESTRANHO = 99;
const PLANILHA = "PLANILHA_TESTE";
const EPOCA_SHEETS = 25569;

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Bot",
  username: "bot_teste",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as unknown as Record<string, unknown>;

// ---------------------------------------------------------------- chave RSA

async function gerarServiceAccount() {
  const par = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", par.privateKey));
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    btoa(bin).match(/.{1,64}/g)!.join("\n")
  }\n-----END PRIVATE KEY-----\n`;
  const sa: ServiceAccount = {
    client_email: "denobot@projeto.iam.gserviceaccount.com",
    private_key: pem,
  };
  return { sa, publica: par.publicKey };
}

function b64urlParaBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// -------------------------------------------------------- planilha em memória

/** "Lançamentos!A2:C" -> colunas 0..2 a partir da linha 2. */
function parseA1(spec: string) {
  const depois = spec.split("!")[1];
  const partes = depois.split(":");
  const re = /^([A-Z]+)(\d+)?$/;
  const a = partes[0].match(re)!;
  const b = (partes[1] ?? partes[0]).match(re)!;
  return {
    c0: a[1].charCodeAt(0) - 65,
    c1: b[1].charCodeAt(0) - 65,
    r0: a[2] ? Number(a[2]) : 1,
    r1: b[2] ? Number(b[2]) : Infinity,
  };
}

const ISO = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** Reproduz o USER_ENTERED do Sheets: ISO vira serial, número continua número. */
function comoUserEntered(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const m = v.match(ISO);
  if (!m) return v;
  const [, Y, M, D, h, mi, s] = m.map(Number) as unknown as number[];
  return Date.UTC(Y, M - 1, D, h, mi, s) / 86_400_000 + EPOCA_SHEETS;
}

function googleFalso(sa: ServiceAccount, publica: CryptoKey) {
  const linhas: unknown[][] = [[...CABECALHO]]; // índice 0 = linha 1
  const chamadas: Array<{ metodo: string; url: string; corpo?: unknown }> = [];
  let jwtsAssinados = 0;

  const impl = async (entrada: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(entrada);
    const metodo = init?.method ?? "GET";
    const corpo = init?.body && metodo !== "POST_FORM" ? init.body : undefined;

    // ---- endpoint de token: verifica a assinatura de verdade
    if (url === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(String(init!.body));
      assertEquals(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [h, c, sig] = params.get("assertion")!.split(".");
      const valida = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publica,
        b64urlParaBytes(sig),
        new TextEncoder().encode(`${h}.${c}`),
      );
      assert(valida, "assinatura RS256 do JWT não confere");
      const claims = JSON.parse(new TextDecoder().decode(b64urlParaBytes(c)));
      assertEquals(claims.iss, sa.client_email);
      assertEquals(claims.scope, "https://www.googleapis.com/auth/spreadsheets");
      jwtsAssinados++;
      return Response.json({ access_token: "ya29.token-falso", expires_in: 3600 });
    }

    // ---- Sheets
    const u = new URL(url);
    assertEquals(new Headers(init?.headers).get("authorization"), "Bearer ya29.token-falso");
    const seg = decodeURIComponent(u.pathname.split("/values/")[1] ?? "");
    const range = seg.replace(/:append$/, "");
    chamadas.push({ metodo, url, corpo: corpo ? JSON.parse(String(corpo)) : undefined });

    if (seg.endsWith(":append")) {
      assert(u.searchParams.get("valueInputOption") === "USER_ENTERED", "append sem USER_ENTERED");
      assert(u.searchParams.get("insertDataOption") === "INSERT_ROWS", "append sem INSERT_ROWS");
      const { values } = JSON.parse(String(corpo)) as { values: unknown[][] };
      for (const linha of values) linhas.push(linha.map(comoUserEntered));
      const n = linhas.length;
      return Response.json({ updates: { updatedRange: `Lançamentos!A${n}:F${n}` } });
    }

    if (metodo === "PUT") {
      assert(u.searchParams.get("valueInputOption") === "USER_ENTERED", "update sem USER_ENTERED");
      const { c0, r0 } = parseA1(range);
      const { values } = JSON.parse(String(corpo)) as { values: unknown[][] };
      (linhas[r0 - 1] ??= [])[c0] = comoUserEntered(values[0][0]);
      return Response.json({});
    }

    // GET
    assert(
      u.searchParams.get("valueRenderOption") === "UNFORMATTED_VALUE",
      "leitura sem UNFORMATTED_VALUE — números voltariam formatados pelo locale",
    );
    const { c0, c1, r0, r1 } = parseA1(range);
    const fatia = linhas
      .slice(r0 - 1, r1 === Infinity ? undefined : r1)
      .map((l) => l.slice(c0, c1 + 1));
    while (fatia.length && fatia.at(-1)!.every((v) => v === undefined || v === "")) fatia.pop();
    return Response.json(fatia.length ? { values: fatia } : {});
  };

  return { impl: impl as unknown as typeof fetch, linhas, chamadas, jwts: () => jwtsAssinados };
}

// ------------------------------------------------------------------ o servidor

async function montarServidor(agora = () => new Date("2026-09-04T17:32:00Z")) {
  const { sa, publica } = await gerarServiceAccount();
  const google = googleFalso(sa, publica);

  // Mesma cadeia de main.ts; só o fetch é injetado.
  const obterToken = criarAuth(sa, google.impl);
  const ledger = criarLedger(criarSheets(PLANILHA, obterToken, google.impl));
  const bot = criarBot({
    token: "12345:fake",
    permitidos: new Set([EU]),
    ledger,
    agora,
    botInfo: BOT_INFO,
  });

  const telegram: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use((_prev, method, payload) => {
    telegram.push({ method, payload: payload as Record<string, unknown> });
    return Promise.resolve(
      // deno-lint-ignore no-explicit-any
      { ok: true, result: { message_id: 1, date: 0, chat: { id: EU, type: "private" } } } as any,
    );
  });

  const handler = criarHandler(webhookCallback(bot, "std/http", { secretToken: SEGREDO }));
  return { handler, telegram, google };
}

function pedido(update: Update, segredo: string | null = SEGREDO): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (segredo !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = segredo;
  return new Request("https://bot.deno.dev/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(update),
  });
}

let uid = 1000;
const texto = (text: string, extra = {}, from = EU): Update =>
  ({
    update_id: ++uid,
    message: {
      message_id: ++uid,
      date: 0,
      chat: { id: from, type: "private", first_name: "Bruno" },
      from: { id: from, is_bot: false, first_name: "Bruno" },
      text,
      ...extra,
    },
  }) as unknown as Update;

const callback = (data: string, from = EU): Update =>
  ({
    update_id: ++uid,
    callback_query: {
      id: `cb${uid}`,
      chat_instance: "ci",
      from: { id: from, is_bot: false, first_name: "Bruno" },
      data,
      message: { message_id: 10, date: 0, chat: { id: from, type: "private" }, text: "..." },
    },
  }) as unknown as Update;

const ultima = (t: Array<{ method: string; payload: Record<string, unknown> }>, m: string) =>
  [...t].reverse().find((c) => c.method === m)!;

// ============================================================== os cenários

Deno.test("e2e: segredo do webhook ausente ou errado é recusado", async () => {
  const { handler, telegram, google } = await montarServidor();

  assertEquals((await handler(pedido(texto("50"), null))).status, 401);
  assertEquals((await handler(pedido(texto("50"), "errado"))).status, 401);

  assertEquals(telegram, [], "nenhuma chamada ao Telegram deveria ter saído");
  assertEquals(google.chamadas, [], "nenhuma chamada ao Sheets deveria ter saído");
});

Deno.test("e2e: rota e método fora do contrato não chegam ao bot", async () => {
  const { handler, telegram } = await montarServidor();
  for (
    const req of [
      new Request("https://bot.deno.dev/webhook"),
      new Request("https://bot.deno.dev/", { method: "POST" }),
      new Request("https://bot.deno.dev/qualquer", { method: "POST" }),
    ]
  ) {
    assertEquals((await handler(req)).status, 200);
  }
  assertEquals(telegram, []);
});

Deno.test("e2e: usuário fora da allowlist recebe silêncio, com 200 para o Telegram", async () => {
  const { handler, telegram, google } = await montarServidor();
  assertEquals((await handler(pedido(texto("50", {}, ESTRANHO)))).status, 200);
  assertEquals(telegram, []);
  assertEquals(google.chamadas, []);
});

Deno.test("e2e: lançamento completo — valor, tipo, descrição, saldo e extrato", async () => {
  // 23:00 em São Paulo = 02:00 UTC do dia SEGUINTE. Se o invariante de fuso
  // quebrar em qualquer costura, o lançamento cai no dia 5 e o mês pode virar.
  const { handler, telegram, google } = await montarServidor(
    () => new Date("2026-09-05T02:00:00Z"),
  );

  // --- 1. manda o valor
  assertEquals((await handler(pedido(texto("1.234,56")))).status, 200);
  const pergunta = ultima(telegram, "sendMessage");
  assertStringIncludes(String(pergunta.payload.text), "R$ 1.234,56");
  const botoes = (pergunta.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  }).inline_keyboard[0];
  assertEquals(botoes.map((b) => b.callback_data), ["n|E|123456", "n|S|123456"]);
  assertEquals(google.chamadas.length, 0, "nada deveria ter sido gravado ainda");

  // --- 2. escolhe Saída: grava
  assertEquals((await handler(pedido(callback("n|S|123456")))).status, 200);

  const gravada = google.linhas[1];
  assertEquals(gravada[1], "Saída");
  assertEquals(gravada[2], 1234.56);
  assertEquals(typeof gravada[2], "number", "Valor precisa chegar como NÚMERO, não string");
  assertEquals(gravada[4], "Bruno");
  assertEquals(typeof gravada[0], "number", "Data virou serial do Sheets");

  // o serial precisa devolver 04/09 às 23:00 — o wall-clock de São Paulo
  const serial = gravada[0] as number;
  assertEquals(
    new Date(Math.round((serial - EPOCA_SHEETS) * 86_400_000)).toISOString(),
    "2026-09-04T23:00:00.000Z",
  );

  const confirmacao = ultima(telegram, "editMessageText");
  assertStringIncludes(String(confirmacao.payload.text), "Saída de R$ 1.234,56");
  assertStringIncludes(String(confirmacao.payload.text), "04/09");

  // --- 3. toca ✏️ e responde a descrição
  const linha = google.linhas.length; // 2
  assertEquals((await handler(pedido(callback(`d|${linha}`)))).status, 200);
  const prompt = ultima(telegram, "sendMessage");
  assertEquals(
    (prompt.payload.reply_markup as { force_reply: boolean }).force_reply,
    true,
  );

  assertEquals(
    (await handler(
      pedido(texto("mercado", {
        reply_to_message: {
          message_id: 9,
          date: 0,
          chat: { id: EU, type: "private" },
          text: String(prompt.payload.text),
        },
      })),
    )).status,
    200,
  );
  assertEquals(google.linhas[1][3], "mercado", "descrição gravada na coluna D da linha certa");

  // §6.2: a confirmação renasce COM a descrição e com o botão de compartilhar
  const depois = ultima(telegram, "sendMessage");
  assertStringIncludes(String(depois.payload.text), "mercado");
  const kb = (depois.payload.reply_markup as {
    inline_keyboard: Array<Array<{ url?: string; callback_data?: string }>>;
  }).inline_keyboard;
  assertEquals(kb.length, 1, "o botão de descrever some quando já há descrição");
  assert(kb[0][0].url!.startsWith("https://wa.me/?text="));
  const compartilhado = decodeURIComponent(kb[0][0].url!.split("?text=")[1]);
  assertStringIncludes(compartilhado, "mercado");
  assertStringIncludes(compartilhado, "R$ 1.234,56");

  // --- 4. uma entrada, para o saldo ter os dois lados
  await handler(pedido(texto("2000")));
  await handler(pedido(callback("n|E|200000")));

  // --- 5. /saldo
  await handler(pedido(texto("/saldo", {
    entities: [{ type: "bot_command", offset: 0, length: 6 }],
  })));
  const saldo = String(ultima(telegram, "sendMessage").payload.text);
  assertStringIncludes(saldo, "Setembro/2026");
  assertStringIncludes(saldo, "2.000,00"); // entradas
  assertStringIncludes(saldo, "1.234,56"); // saídas
  assertStringIncludes(saldo, "765,44"); // resultado

  // --- 6. /extrato
  await handler(pedido(texto("/extrato", {
    entities: [{ type: "bot_command", offset: 0, length: 8 }],
  })));
  const extrato = String(ultima(telegram, "sendMessage").payload.text);
  assertStringIncludes(extrato, "04/09");
  assertStringIncludes(extrato, "mercado");
  assertStringIncludes(extrato, "Bruno");

  // um único JWT assinado para todas essas requisições — o cache funciona
  assertEquals(google.jwts(), 1, "o access token deveria ter sido reaproveitado");
});

Deno.test("e2e: reentrega do mesmo update não duplica linha nem confirmação", async () => {
  const { handler, telegram, google } = await montarServidor();
  const dup = callback("n|S|5000");

  await handler(pedido(dup));
  await handler(pedido(dup)); // o Telegram reentrega o MESMO update_id

  // duas camadas independentes: o ledger recusa a segunda gravação...
  assertEquals(google.linhas.length, 2, "cabeçalho + uma linha, não duas");
  // ...e o bot não reenvia a confirmação de algo que não gravou de novo.
  assertEquals(
    telegram.filter((c) => c.method === "editMessageText").length,
    1,
    "a confirmação deveria sair uma única vez",
  );
});

Deno.test("e2e: valor ilegível pede nova digitação e não toca na planilha", async () => {
  const { handler, telegram, google } = await montarServidor();
  assertEquals((await handler(pedido(texto("50,5555")))).status, 200);

  const erro = ultima(telegram, "sendMessage");
  assertStringIncludes(String(erro.payload.text), "50,5555");
  assertEquals((erro.payload.reply_markup as { force_reply: boolean }).force_reply, true);
  assertEquals(google.chamadas, []);
});

Deno.test("e2e: mensagem sem dígito recebe só a dica de uso", async () => {
  const { handler, telegram, google } = await montarServidor();
  await handler(pedido(texto("bom dia")));
  assertStringIncludes(String(ultima(telegram, "sendMessage").payload.text), "/saldo");
  assertEquals(google.chamadas, []);
});
