const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
/** Renova um pouco antes de expirar, para não usar um token que vence no meio do voo. */
const MARGEM_SEGUNDOS = 60;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export type ObterToken = () => Promise<string>;

/**
 * Variáveis de ambiente costumam guardar a chave com \n escapado.
 * Desfazer isso aqui evita um erro de importKey difícil de diagnosticar.
 */
export function lerServiceAccount(json: string): ServiceAccount {
  const obj = JSON.parse(json);
  if (typeof obj?.client_email !== "string" || typeof obj?.private_key !== "string") {
    throw new Error("service account inválida: faltam client_email e/ou private_key");
  }
  return {
    client_email: obj.client_email,
    private_key: obj.private_key.replaceAll("\\n", "\n"),
  };
}

function b64url(dados: ArrayBuffer | string): string {
  const bytes = typeof dados === "string" ? new TextEncoder().encode(dados) : new Uint8Array(dados);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function importarChave(pem: string): Promise<CryptoKey> {
  const corpo = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(corpo), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Devolve uma função que entrega um access token válido, com cache em closure.
 * Criar o auth uma única vez no escopo do módulo faz o cache sobreviver entre
 * requisições no mesmo isolate — é o que mantém a assinatura RSA fora do
 * caminho quente e longe do limite de CPU do Deno Deploy.
 */
export function criarAuth(sa: ServiceAccount, fetchImpl: typeof fetch = fetch): ObterToken {
  let cache: { token: string; expiraEm: number } | null = null;

  return async function obterToken(): Promise<string> {
    const agora = Math.floor(Date.now() / 1000);
    if (cache && cache.expiraEm > agora + MARGEM_SEGUNDOS) return cache.token;

    const cabecalho = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: agora,
      exp: agora + 3600,
    }));

    const chave = await importarChave(sa.private_key);
    const assinatura = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      chave,
      new TextEncoder().encode(`${cabecalho}.${claims}`),
    );
    const assertion = `${cabecalho}.${claims}.${b64url(assinatura)}`;

    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });

    if (!res.ok) {
      throw new Error(`falha ao obter access token (${res.status}): ${await res.text()}`);
    }

    const { access_token, expires_in } = await res.json();
    cache = { token: access_token, expiraEm: agora + expires_in };
    return access_token;
  };
}
