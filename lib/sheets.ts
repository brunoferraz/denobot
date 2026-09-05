import type { ObterToken } from "./google_auth.ts";

export class ErroSheets extends Error {
  constructor(readonly status: number, mensagem: string) {
    super(mensagem);
    this.name = "ErroSheets";
  }
}

export interface SheetsClient {
  append(range: string, linhas: unknown[][]): Promise<{ linha: number }>;
  get(range: string): Promise<unknown[][]>;
  update(range: string, linhas: unknown[][]): Promise<void>;
}

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** "Lançamentos!A42:F42" -> 42 */
function primeiraLinha(updatedRange: string): number {
  const m = updatedRange.match(/![A-Z]+(\d+)/);
  if (!m) throw new Error(`não consegui ler a linha de "${updatedRange}"`);
  return Number(m[1]);
}

export function criarSheets(
  spreadsheetId: string,
  obterToken: ObterToken,
  fetchImpl: typeof fetch = fetch,
): SheetsClient {
  async function chamar(caminho: string, init?: RequestInit): Promise<unknown> {
    const res = await fetchImpl(`${BASE}/${spreadsheetId}/values/${caminho}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await obterToken()}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    });

    if (!res.ok) {
      const corpo = await res.text();
      // 403 aqui é quase sempre a mesma causa; dizer isso economiza uma hora de depuração.
      const dica = res.status === 403
        ? " — verifique se a planilha está compartilhada com o e-mail da service account, como Editor"
        : "";
      throw new ErroSheets(res.status, `Sheets ${res.status}: ${corpo}${dica}`);
    }
    return await res.json();
  }

  return {
    async append(range, linhas) {
      const qs = "valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";
      const dados = await chamar(`${encodeURIComponent(range)}:append?${qs}`, {
        method: "POST",
        body: JSON.stringify({ values: linhas }),
      }) as { updates?: { updatedRange?: string } };

      const faixa = dados.updates?.updatedRange;
      if (!faixa) throw new Error("append não devolveu updates.updatedRange");
      return { linha: primeiraLinha(faixa) };
    },

    async get(range) {
      const dados = await chamar(
        `${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`,
      ) as { values?: unknown[][] };
      return dados.values ?? [];
    },

    async update(range, linhas) {
      await chamar(`${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
        method: "PUT",
        body: JSON.stringify({ values: linhas }),
      });
    },
  };
}
