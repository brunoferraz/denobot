import { assert, assertEquals, assertRejects } from "@std/assert";
import { criarAuth, lerServiceAccount, type ServiceAccount } from "./google_auth.ts";

function b64urlParaBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function gerarServiceAccount(): Promise<{ sa: ServiceAccount; publica: CryptoKey }> {
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
  const b64 = btoa(String.fromCharCode(...pkcs8));
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    b64.match(/.{1,64}/g)!.join("\n")
  }\n-----END PRIVATE KEY-----\n`;

  return {
    sa: { client_email: "bot@proj.iam.gserviceaccount.com", private_key: pem },
    publica: par.publicKey,
  };
}

/** fetch falso que registra as chamadas e devolve um token. */
function fetchFalso(respostas: Response[]) {
  const chamadas: Array<{ url: string; body: URLSearchParams }> = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    chamadas.push({
      url: String(input),
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    return Promise.resolve(respostas.shift() ?? new Response("sem resposta", { status: 500 }));
  };
  return { impl: impl as unknown as typeof fetch, chamadas };
}

const tokenOk = () =>
  new Response(JSON.stringify({ access_token: "ya29.token", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

Deno.test("monta um JWT RS256 verificável, com as claims que o Google exige", async () => {
  const { sa, publica } = await gerarServiceAccount();
  const { impl, chamadas } = fetchFalso([tokenOk()]);

  const token = await criarAuth(sa, impl)();
  assertEquals(token, "ya29.token");
  assertEquals(chamadas.length, 1);
  assertEquals(chamadas[0].url, "https://oauth2.googleapis.com/token");
  assertEquals(
    chamadas[0].body.get("grant_type"),
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );

  const assertion = chamadas[0].body.get("assertion")!;
  const [h, c, s] = assertion.split(".");

  assertEquals(JSON.parse(new TextDecoder().decode(b64urlParaBytes(h))), {
    alg: "RS256",
    typ: "JWT",
  });

  const claims = JSON.parse(new TextDecoder().decode(b64urlParaBytes(c)));
  assertEquals(claims.iss, sa.client_email);
  assertEquals(claims.aud, "https://oauth2.googleapis.com/token");
  assertEquals(claims.scope, "https://www.googleapis.com/auth/spreadsheets");
  assert(claims.exp - claims.iat <= 3600, "exp não pode passar de 1h após iat");

  const valida = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publica,
    b64urlParaBytes(s),
    new TextEncoder().encode(`${h}.${c}`),
  );
  assert(valida, "assinatura do JWT não confere");
});

Deno.test("reaproveita o token enquanto ele é válido", async () => {
  const { sa } = await gerarServiceAccount();
  const { impl, chamadas } = fetchFalso([tokenOk(), tokenOk()]);

  const obter = criarAuth(sa, impl);
  assertEquals(await obter(), "ya29.token");
  assertEquals(await obter(), "ya29.token");
  assertEquals(chamadas.length, 1, "a segunda chamada deveria vir do cache");
});

Deno.test("propaga falha do endpoint de token com o corpo do erro", async () => {
  const { sa } = await gerarServiceAccount();
  const { impl } = fetchFalso([new Response("invalid_grant", { status: 400 })]);

  await assertRejects(() => criarAuth(sa, impl)(), Error, "invalid_grant");
});

Deno.test("lerServiceAccount aceita \\n escapado na private_key", () => {
  const sa = lerServiceAccount(
    JSON.stringify({ client_email: "a@b.com", private_key: "linha1\\nlinha2" }),
  );
  assertEquals(sa.private_key, "linha1\nlinha2");
});

Deno.test("lerServiceAccount recusa JSON sem os campos obrigatórios", () => {
  let erro: unknown;
  try {
    lerServiceAccount(JSON.stringify({ client_email: "a@b.com" }));
  } catch (e) {
    erro = e;
  }
  assert(erro instanceof Error);
});
