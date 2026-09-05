import { criarAuth, lerServiceAccount } from "../lib/google_auth.ts";
import { criarSheets } from "../lib/sheets.ts";
import { ABA, CABECALHO } from "../lib/ledger.ts";

const sa = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
const planilha = Deno.env.get("SPREADSHEET_ID");

if (!sa || !planilha) {
  console.error("defina GOOGLE_SERVICE_ACCOUNT_JSON e SPREADSHEET_ID");
  Deno.exit(1);
}

const sheets = criarSheets(planilha, criarAuth(lerServiceAccount(sa)));

// A aba precisa existir antes: crie-a na interface do Google Sheets com o
// nome exato "Lançamentos". Este script só grava o cabeçalho.
await sheets.update(`${ABA}!A1:F1`, [CABECALHO]);
console.log(`cabeçalho gravado em ${ABA}!A1:F1`);

const conferencia = await sheets.get(`${ABA}!A1:F1`);
console.log(conferencia);
