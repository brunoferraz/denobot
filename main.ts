import { webhookCallback } from "grammy";
import { criarBot } from "./bot.ts";
import { criarAuth, lerServiceAccount } from "./lib/google_auth.ts";
import { criarSheets } from "./lib/sheets.ts";
import { criarLedger } from "./lib/ledger.ts";

export function lerEnv(nome: string): string {
  const v = Deno.env.get(nome);
  if (!v) throw new Error(`variável de ambiente ausente: ${nome}`);
  return v;
}

export function montarPermitidos(bruto: string): Set<number> {
  return new Set(
    bruto.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0),
  );
}

/**
 * Envolve o handler do grammY com duas garantias:
 * só POST /webhook é processado, e a resposta é SEMPRE 200 —
 * um 500 faria o Telegram reentregar o mesmo update indefinidamente.
 */
export function criarHandler(
  handleUpdate: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/webhook") {
      return new Response("ok");
    }
    try {
      return await handleUpdate(req);
    } catch (err) {
      console.error("webhook:", err);
      return new Response("ok");
    }
  };
}

// Tudo abaixo roda uma vez por isolate. O auth criado aqui mantém o access
// token em cache entre requisições, tirando a assinatura RSA do caminho quente.
if (import.meta.main) {
  const obterToken = criarAuth(lerServiceAccount(lerEnv("GOOGLE_SERVICE_ACCOUNT_JSON")));
  const ledger = criarLedger(criarSheets(lerEnv("SPREADSHEET_ID"), obterToken));

  const bot = criarBot({
    token: lerEnv("BOT_TOKEN"),
    permitidos: montarPermitidos(lerEnv("ALLOWED_USER_IDS")),
    ledger,
  });

  const handleUpdate = webhookCallback(bot, "std/http", {
    secretToken: lerEnv("WEBHOOK_SECRET"),
  });

  Deno.serve(criarHandler(handleUpdate));
}
