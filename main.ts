import { webhookCallback } from "grammy";
import { criarBot } from "./bot.ts";
import { criarAuth, lerServiceAccount } from "./lib/google_auth.ts";
import { criarSheets } from "./lib/sheets.ts";
import { criarLedger } from "./lib/ledger.ts";
// TEMPORÁRIO — ver lib/onboarding.ts. Removê-lo é apagar este import e a
// linha `aoNegar:` abaixo; o padrão sem ele é o silêncio total do spec §9.
import { criarAvisoDeCadastro } from "./lib/onboarding.ts";

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
 * Chama montarPermitidos e falha alto se o resultado vier vazio. Um typo
 * plausível em ALLOWED_USER_IDS (IDs separados por espaço em vez de vírgula,
 * um "@usuario" colado, um comentário no fim) passa batido pelo filtro de
 * montarPermitidos e produz um Set vazio — o bot sobe, responde 200 pra
 * todo update e não fala com ninguém, porque o middleware de allowlist
 * derruba tudo em silêncio por design. Sem esta guarda, esse typo é
 * indistinguível de um deploy morto: getWebhookInfo fica limpo, não sobra
 * log nenhum dizendo por quê. lerEnv já falha alto para a env ausente; esta
 * função fecha o mesmo buraco para a env presente mas ilegível.
 */
export function exigirPermitidos(bruto: string): Set<number> {
  const permitidos = montarPermitidos(bruto);
  if (permitidos.size === 0) {
    throw new Error(
      "ALLOWED_USER_IDS não contém nenhum ID válido — confira o formato (números separados por vírgula)",
    );
  }
  return permitidos;
}

/**
 * Envolve o handler do grammY com duas garantias: só POST /webhook é
 * processado, e uma EXCEÇÃO nunca vira 500 — um 500 faria o Telegram
 * reentregar o mesmo update indefinidamente, então aqui ela vira 200.
 *
 * Exceção deliberada: se handleUpdate RESOLVER normalmente com um status
 * diferente de 200, essa resposta passa direto — não é forçada a 200. O
 * grammY devolve 401 quando o secret_token do pedido não bate com
 * WEBHOOK_SECRET, e isso só acontece por um erro de configuração (os dois
 * divergiram). É exatamente esse tipo de erro que precisa aparecer em
 * last_error_message no getWebhookInfo, que é o caminho de depuração que o
 * README indica; disfarçar de 200 esconderia um webhook mal configurado
 * atrás de um bot aparentemente saudável.
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

  const permitidos = exigirPermitidos(lerEnv("ALLOWED_USER_IDS"));
  // O admin é o PRIMEIRO id de ALLOWED_USER_IDS — o Set preserva a ordem de
  // inserção, e montarPermitidos insere na ordem em que aparecem na variável.
  const admin = [...permitidos][0];

  const bot = criarBot({
    token: lerEnv("BOT_TOKEN"),
    permitidos,
    ledger,
    aoNegar: criarAvisoDeCadastro(admin),
  });

  const handleUpdate = webhookCallback(bot, "std/http", {
    secretToken: lerEnv("WEBHOOK_SECRET"),
  });

  Deno.serve(criarHandler(handleUpdate));
}
