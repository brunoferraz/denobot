# Bot financeiro no Telegram — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um bot de Telegram em Deno, stateless, que registra entradas e saídas numa planilha do Google Sheets e responde consultas de saldo e extrato.

**Architecture:** Servidor stateless por webhook. O estado de conversa viaja no `callback_data` dos botões e no `reply_to_message` das respostas — não há banco de dados. A planilha é a única fonte de verdade. Camadas puras (`money`, `callback`, `render`) são isoladas das camadas de I/O (`google_auth`, `sheets`), e o domínio (`ledger`) fica entre as duas.

**Tech Stack:** Deno 2.x, TypeScript, grammY (`npm:grammy`), Google Sheets API v4 REST, Web Crypto para o JWT RS256, Deno Deploy.

**Spec:** `docs/superpowers/specs/2026-09-04-bot-financeiro-telegram-design.md`

## Global Constraints

- **Runtime:** Deno 2.x. Única dependência externa: `npm:grammy@^1.30.0`. O JWT é assinado com Web Crypto nativo — não adicionar biblioteca de JWT.
- **Dinheiro:** todo valor monetário trafega internamente como **inteiro em centavos**. Nunca usar float para dinheiro fora da fronteira de formatação.
- **Limite de valor:** `R$ 1.000.000,00` = `100_000_000` centavos. Acima disso, recusar.
- **Timezone:** `America/Sao_Paulo`, fixo. Datas gravadas como wall-clock local em ISO.
- **Planilha:** aba `Lançamentos`. Colunas A–F: `Data`, `Tipo`, `Valor`, `Descrição`, `Quem`, `update_id`. Cabeçalho na linha 1; dados a partir da linha 2.
- **Tipo de lançamento:** exatamente as strings `Entrada` e `Saída` (com cedilha e acento).
- **Escrita no Sheets:** `valueInputOption=USER_ENTERED`. Valor e `update_id` vão como **número JSON**; Data vai como **string ISO** `YYYY-MM-DD HH:mm:ss`.
- **Leitura no Sheets:** sempre `valueRenderOption=UNFORMATTED_VALUE`. Sem isso, números voltam como strings formatadas pelo locale e o parsing quebra.
- **`callback_data`:** máximo 64 bytes UTF-8. O codec deve falhar ruidosamente se estourar.
- **Resposta ao Telegram:** o handler HTTP **nunca** devolve status diferente de 200, mesmo em exceção.
- **Escopo Google:** `https://www.googleapis.com/auth/spreadsheets`.
- **Testes:** `deno test` sem permissão de rede. Toda dependência de I/O é injetada.
- **Commits:** estilo convencional `<type>(<scope>): <título>`, título em minúsculas, sem `Co-Authored-By`, sem emoji.

---

### Task 1: Bootstrap do projeto e `lib/money.ts`

O parser de valores é o coração do produto e a lógica que mais erra. Ele vem primeiro, junto com o esqueleto mínimo que permite rodar testes.

**Files:**
- Create: `deno.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `lib/money.ts`
- Test: `lib/money_test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `type ErroValor = "formato" | "zero" | "negativo" | "muito-alto"`
  - `type ParseResult = { ok: true; centavos: number } | { ok: false; erro: ErroValor }`
  - `parseValor(entrada: string): ParseResult`
  - `pareceValor(texto: string): boolean`
  - `formatarBRL(centavos: number): string` — retorna `"1.234,56"`, sem o prefixo `R$`
  - `LIMITE_CENTAVOS: number`

- [ ] **Step 1: Criar `deno.json`**

```json
{
  "tasks": {
    "dev": "deno run --allow-net --allow-env --watch main.ts",
    "test": "deno test",
    "check": "deno check main.ts && deno lint && deno fmt --check",
    "set-webhook": "deno run --allow-net --allow-env scripts/set_webhook.ts",
    "bootstrap-sheet": "deno run --allow-net --allow-env scripts/bootstrap_sheet.ts"
  },
  "imports": {
    "grammy": "npm:grammy@^1.30.0"
  },
  "fmt": { "lineWidth": 100 },
  "lock": true
}
```

- [ ] **Step 2: Criar `.gitignore` e `.env.example`**

`.gitignore`:

```
.env
*.local
service-account*.json
.DS_Store
```

`.env.example`:

```
BOT_TOKEN=
WEBHOOK_SECRET=
PUBLIC_URL=https://seu-app.deno.dev
GOOGLE_SERVICE_ACCOUNT_JSON=
SPREADSHEET_ID=
ALLOWED_USER_IDS=
```

- [ ] **Step 3: Escrever os testes que falham**

Crie `lib/money_test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { formatarBRL, parseValor, pareceValor } from "./money.ts";

const validos: Array<[string, number]> = [
  ["50", 5000],
  ["0,50", 50],
  ["50,5", 5050],
  ["50,55", 5055],
  ["50.5", 5050],
  ["50.55", 5055],
  ["1.234", 123400],
  ["1,234", 123400],
  ["1.234.567", 123456700],
  ["1.234,56", 123456],
  ["1,234.56", 123456],
  ["R$ 12,30", 1230],
  ["r$12,30", 1230],
  [" 42 ", 4200],
  ["+50", 5000],
  ["1000000", 100000000],
];

Deno.test("parseValor aceita os formatos previstos", () => {
  for (const [entrada, esperado] of validos) {
    assertEquals(parseValor(entrada), { ok: true, centavos: esperado }, entrada);
  }
});

const invalidos: Array<[string, string]> = [
  ["50,5555", "formato"],
  ["12..3", "formato"],
  ["1.23.4", "formato"],
  ["1.234.56", "formato"],
  ["1234.567", "formato"],
  ["50.", "formato"],
  ["abc", "formato"],
  ["R$ abc4", "formato"],
  ["", "formato"],
  ["-50", "negativo"],
  ["0", "zero"],
  ["0,00", "zero"],
  ["1000000,01", "muito-alto"],
];

Deno.test("parseValor recusa o que não bate com nenhuma regra", () => {
  for (const [entrada, erro] of invalidos) {
    assertEquals(parseValor(entrada), { ok: false, erro }, entrada);
  }
});

Deno.test("pareceValor separa tentativa de valor de conversa solta", () => {
  for (const t of ["50", "50,5555", "12..3", "R$ abc4", "quero 30"]) {
    assertEquals(pareceValor(t), true, t);
  }
  for (const t of ["oi", "bom dia", "obrigado", ""]) {
    assertEquals(pareceValor(t), false, t);
  }
});

Deno.test("formatarBRL usa separadores pt-BR e duas casas", () => {
  assertEquals(formatarBRL(5000), "50,00");
  assertEquals(formatarBRL(123456), "1.234,56");
  assertEquals(formatarBRL(7), "0,07");
  assertEquals(formatarBRL(100000000), "1.000.000,00");
});
```

- [ ] **Step 4: Rodar os testes e confirmar que falham**

Run: `deno test lib/money_test.ts`
Expected: FAIL — `Module not found "./money.ts"`

- [ ] **Step 5: Implementar `lib/money.ts`**

```ts
export const LIMITE_CENTAVOS = 100_000_000; // R$ 1.000.000,00

export type ErroValor = "formato" | "zero" | "negativo" | "muito-alto";

export type ParseResult =
  | { ok: true; centavos: number }
  | { ok: false; erro: ErroValor };

/** Uma mensagem com ao menos um dígito é tratada como tentativa de informar um valor. */
export function pareceValor(texto: string): boolean {
  return /\d/.test(texto);
}

/** Grupos separados por milhar: o primeiro tem 1–3 dígitos, os demais exatamente 3. */
function milharValido(partes: string[]): boolean {
  if (partes.length < 2) return false;
  if (!/^\d{1,3}$/.test(partes[0])) return false;
  return partes.slice(1).every((p) => /^\d{3}$/.test(p));
}

export function parseValor(entrada: string): ParseResult {
  let s = entrada.trim().toLowerCase().replace(/r\$/g, "").replace(/\s/g, "");

  let negativo = false;
  if (s.startsWith("-")) {
    negativo = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return { ok: false, erro: "formato" };

  const pontos = (s.match(/\./g) ?? []).length;
  const virgulas = (s.match(/,/g) ?? []).length;
  let normalizado: string;

  if (pontos > 0 && virgulas > 0) {
    // Os dois separadores presentes: o ÚLTIMO é o decimal, o outro é milhar.
    const decimal = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const milhar = decimal === "." ? "," : ".";
    if ((decimal === "." ? pontos : virgulas) !== 1) return { ok: false, erro: "formato" };
    const [inteiro, frac] = s.split(decimal);
    if (!milharValido(inteiro.split(milhar))) return { ok: false, erro: "formato" };
    if (!/^\d{1,2}$/.test(frac)) return { ok: false, erro: "formato" };
    normalizado = inteiro.split(milhar).join("") + "." + frac;
  } else if (pontos + virgulas === 0) {
    normalizado = s;
  } else {
    const sep = pontos > 0 ? "." : ",";
    const partes = s.split(sep);
    const depois = partes[partes.length - 1].length;

    if (partes.length > 2) {
      // Separador repetido: só pode ser milhar.
      if (!milharValido(partes)) return { ok: false, erro: "formato" };
      normalizado = partes.join("");
    } else if (depois === 1 || depois === 2) {
      normalizado = partes.join(".");
    } else if (depois === 3) {
      // Ambíguo entre decimal e milhar; no contexto pt-BR, milhar.
      if (!milharValido(partes)) return { ok: false, erro: "formato" };
      normalizado = partes.join("");
    } else {
      return { ok: false, erro: "formato" };
    }
  }

  if (!/^\d+(\.\d{1,2})?$/.test(normalizado)) return { ok: false, erro: "formato" };

  const centavos = Math.round(Number(normalizado) * 100);
  if (!Number.isFinite(centavos)) return { ok: false, erro: "formato" };
  if (centavos === 0) return { ok: false, erro: "zero" };
  if (negativo) return { ok: false, erro: "negativo" };
  if (centavos > LIMITE_CENTAVOS) return { ok: false, erro: "muito-alto" };
  return { ok: true, centavos };
}

/** Formata centavos como "1.234,56" — sem o prefixo "R$". */
export function formatarBRL(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
```

**Nota sobre a ordem das checagens:** `zero` é verificado antes de `negativo` para que `-0` e `0` produzam o mesmo erro, e `muito-alto` por último porque só faz sentido num número já válido.

- [ ] **Step 6: Rodar os testes e confirmar que passam**

Run: `deno test lib/money_test.ts`
Expected: PASS — 4 testes.

- [ ] **Step 7: Commit**

```bash
git add deno.json .gitignore .env.example lib/money.ts lib/money_test.ts
git commit -m "feat(money): parser de valores em pt-BR com centavos inteiros"
```

---

### Task 2: `lib/types.ts` e `lib/callback.ts`

Tipos de domínio compartilhados e o codec que carrega todo o estado de conversa dentro dos 64 bytes do `callback_data`.

**Files:**
- Create: `lib/types.ts`
- Create: `lib/callback.ts`
- Test: `lib/callback_test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `type TipoLancamento = "Entrada" | "Saída"`
  - `interface Lancamento { data: Date; tipo: TipoLancamento; centavos: number; descricao: string; quem: string }`
  - `interface Saldo { mes: string; entradasCentavos: number; saidasCentavos: number; resultadoCentavos: number; acumuladoCentavos: number }`
  - `type Callback = { tipo: "n"; lancamento: TipoLancamento; centavos: number } | { tipo: "d"; linha: number } | { tipo: "m"; mes: string } | { tipo: "x"; offset: number }`
  - `encodeCallback(cb: Callback): string`
  - `decodeCallback(raw: string): Callback | null`

- [ ] **Step 1: Escrever os testes que falham**

Crie `lib/callback_test.ts`:

```ts
import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import { type Callback, decodeCallback, encodeCallback } from "./callback.ts";

const casos: Array<[Callback, string]> = [
  [{ tipo: "n", lancamento: "Entrada", centavos: 5000 }, "n|E|5000"],
  [{ tipo: "n", lancamento: "Saída", centavos: 5000 }, "n|S|5000"],
  [{ tipo: "d", linha: 42 }, "d|42"],
  [{ tipo: "m", mes: "2026-08" }, "m|2026-08"],
  [{ tipo: "x", offset: 20 }, "x|20"],
];

Deno.test("encodeCallback produz o formato compacto esperado", () => {
  for (const [cb, esperado] of casos) assertEquals(encodeCallback(cb), esperado);
});

Deno.test("decodeCallback é o inverso de encodeCallback", () => {
  for (const [cb, raw] of casos) assertEquals(decodeCallback(raw), cb);
});

Deno.test("decodeCallback devolve null para entrada inválida", () => {
  for (const raw of ["", "z|1", "n|X|5000", "n|E|abc", "d|", "d|x", "m|agosto", "x|-1"]) {
    assertEquals(decodeCallback(raw), null, raw);
  }
});

Deno.test("encodeCallback recusa payload acima de 64 bytes", () => {
  assertThrows(() => encodeCallback({ tipo: "m", mes: "x".repeat(70) }));
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `deno test lib/callback_test.ts`
Expected: FAIL — `Module not found "./callback.ts"`

- [ ] **Step 3: Implementar `lib/types.ts`**

```ts
export type TipoLancamento = "Entrada" | "Saída";

export interface Lancamento {
  /** Wall-clock em America/Sao_Paulo; comparar sempre pelos getters UTC. */
  data: Date;
  tipo: TipoLancamento;
  centavos: number;
  descricao: string;
  quem: string;
}

export interface Saldo {
  /** "YYYY-MM" */
  mes: string;
  entradasCentavos: number;
  saidasCentavos: number;
  /** entradas - saídas no mês */
  resultadoCentavos: number;
  /** entradas - saídas em toda a planilha */
  acumuladoCentavos: number;
}
```

- [ ] **Step 4: Implementar `lib/callback.ts`**

```ts
import type { TipoLancamento } from "./types.ts";

export const LIMITE_CALLBACK_BYTES = 64;

export type Callback =
  | { tipo: "n"; lancamento: TipoLancamento; centavos: number }
  | { tipo: "d"; linha: number }
  | { tipo: "m"; mes: string }
  | { tipo: "x"; offset: number };

export function encodeCallback(cb: Callback): string {
  let raw: string;
  switch (cb.tipo) {
    case "n":
      raw = `n|${cb.lancamento === "Entrada" ? "E" : "S"}|${cb.centavos}`;
      break;
    case "d":
      raw = `d|${cb.linha}`;
      break;
    case "m":
      raw = `m|${cb.mes}`;
      break;
    case "x":
      raw = `x|${cb.offset}`;
      break;
  }
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > LIMITE_CALLBACK_BYTES) {
    throw new Error(`callback_data com ${bytes} bytes excede o limite de ${LIMITE_CALLBACK_BYTES}`);
  }
  return raw;
}

const INTEIRO_POSITIVO = /^\d+$/;

export function decodeCallback(raw: string): Callback | null {
  const partes = raw.split("|");
  switch (partes[0]) {
    case "n": {
      const [, letra, centavos] = partes;
      if (partes.length !== 3) return null;
      if (letra !== "E" && letra !== "S") return null;
      if (!INTEIRO_POSITIVO.test(centavos)) return null;
      return {
        tipo: "n",
        lancamento: letra === "E" ? "Entrada" : "Saída",
        centavos: Number(centavos),
      };
    }
    case "d": {
      if (partes.length !== 2 || !INTEIRO_POSITIVO.test(partes[1])) return null;
      return { tipo: "d", linha: Number(partes[1]) };
    }
    case "m": {
      if (partes.length !== 2 || !/^\d{4}-\d{2}$/.test(partes[1])) return null;
      return { tipo: "m", mes: partes[1] };
    }
    case "x": {
      if (partes.length !== 2 || !INTEIRO_POSITIVO.test(partes[1])) return null;
      return { tipo: "x", offset: Number(partes[1]) };
    }
    default:
      return null;
  }
}
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `deno test lib/callback_test.ts`
Expected: PASS — 4 testes.

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/callback.ts lib/callback_test.ts
git commit -m "feat(callback): codec de estado de conversa em callback_data"
```

---

### Task 3: `lib/tempo.ts` e `lib/render.ts`

Toda a apresentação: datas, mensagens, teclados e o link de compartilhamento. Camada pura — nenhuma dessas funções toca rede.

**Files:**
- Create: `lib/tempo.ts`
- Create: `lib/render.ts`
- Test: `lib/tempo_test.ts`
- Test: `lib/render_test.ts`

**Interfaces:**
- Consumes: `formatarBRL`, `ErroValor` (Task 1); `Lancamento`, `Saldo`, `TipoLancamento` (Task 2); `encodeCallback` (Task 2).
- Produces:
  - `lib/tempo.ts`: `TZ`, `agoraISO(agora?: Date): string`, `agoraLocal(agora?: Date): Date`, `dataParaISO(d: Date): string`, `serialParaDate(serial: number): Date`, `mesDe(d: Date): string`, `ddMM(d: Date): string`, `mesPorExtenso(mes: string): string`, `mesAnterior(mes: string): string`, `mesSeguinte(mes: string): string`
  - `lib/render.ts`: `interface Mensagem { text: string; reply_markup?: unknown }`, `PAGINA_EXTRATO`, `perguntaTipo`, `confirmacao`, `perguntaDescricao`, `erroValor`, `textoSaldo`, `textoExtrato`, `dicaUso`, `linkWhatsApp`, `extrairLinha`

**Invariante de data:** uma `Date` que representa um lançamento sempre tem os
campos **UTC** iguais ao wall-clock de São Paulo — seja ela vinda de
`agoraLocal()` ou de `serialParaDate()`. Por isso `mesDe` e `ddMM` usam
`getUTC*`. Nunca construa um `Lancamento` com `new Date()` cru.

**Decisão de segurança:** nenhuma mensagem usa `parse_mode`. Descrições são texto livre do usuário; sem Markdown/HTML não há o que escapar e não há como o usuário quebrar a formatação ou injetar marcação.

- [ ] **Step 1: Escrever `lib/tempo_test.ts`**

```ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  agoraISO,
  agoraLocal,
  dataParaISO,
  ddMM,
  mesAnterior,
  mesDe,
  mesPorExtenso,
  mesSeguinte,
  serialParaDate,
} from "./tempo.ts";

Deno.test("agoraISO devolve wall-clock de São Paulo em ISO", () => {
  // 2026-09-04T17:32:00Z = 14:32 em São Paulo (UTC-3)
  assertEquals(agoraISO(new Date("2026-09-04T17:32:00Z")), "2026-09-04 14:32:00");
});

Deno.test("agoraLocal impede que lançamento noturno caia no dia seguinte", () => {
  // 01:30Z do dia 5 ainda é 22:30 do dia 4 em São Paulo.
  const d = agoraLocal(new Date("2026-09-05T01:30:00Z"));
  assertEquals(dataParaISO(d), "2026-09-04 22:30:00");
  assertEquals(ddMM(d), "04/09");
  assertEquals(mesDe(d), "2026-09");
});

Deno.test("serialParaDate converte o serial do Sheets", () => {
  assertEquals(serialParaDate(25569).toISOString(), "1970-01-01T00:00:00.000Z");
  assertEquals(serialParaDate(46269).toISOString(), "2026-09-04T00:00:00.000Z");
});

Deno.test("mesDe e ddMM leem a data pelos getters UTC", () => {
  const d = serialParaDate(46269.5); // 2026-09-04 12:00
  assertEquals(mesDe(d), "2026-09");
  assertEquals(ddMM(d), "04/09");
});

Deno.test("navegação de meses atravessa a virada de ano", () => {
  assertEquals(mesAnterior("2026-01"), "2025-12");
  assertEquals(mesSeguinte("2025-12"), "2026-01");
  assertEquals(mesAnterior("2026-09"), "2026-08");
  assertEquals(mesPorExtenso("2026-09"), "Setembro/2026");
  assertEquals(mesPorExtenso("2026-01"), "Janeiro/2026");
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `deno test lib/tempo_test.ts`
Expected: FAIL — `Module not found "./tempo.ts"`

- [ ] **Step 3: Implementar `lib/tempo.ts`**

```ts
export const TZ = "America/Sao_Paulo";

/** Dias entre a época do Sheets (1899-12-30) e a época Unix. */
const EPOCA_SHEETS = 25569;

const FMT_ISO = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/**
 * Wall-clock de São Paulo como "YYYY-MM-DD HH:mm:ss".
 * O locale sv-SE já produz esse formato; é o truque que evita montar a string à mão.
 */
export function agoraISO(agora: Date = new Date()): string {
  return dataParaISO(agoraLocal(agora));
}

/**
 * Converte um instante real numa Date cujos campos UTC são o wall-clock de
 * São Paulo. Todo o resto do sistema lê datas pelos getters UTC — inclusive as
 * que voltam da planilha —, então essa normalização é o que impede que um
 * lançamento feito às 22h caia no dia seguinte.
 */
export function agoraLocal(agora: Date = new Date()): Date {
  const [data, hora] = FMT_ISO.format(agora).split(/\s+/);
  return new Date(`${data}T${hora}Z`);
}

/** "YYYY-MM-DD HH:mm:ss" a partir dos campos UTC de uma Date wall-clock. */
export function dataParaISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * O Sheets guarda datas como dias desde 1899-12-30, no fuso da planilha.
 * Como gravamos wall-clock local, a Date resultante tem os campos UTC iguais
 * ao horário local — por isso toda leitura usa os getters UTC.
 */
export function serialParaDate(serial: number): Date {
  return new Date(Math.round((serial - EPOCA_SHEETS) * 86_400_000));
}

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const pad = (n: number) => String(n).padStart(2, "0");

export function mesDe(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export function ddMM(d: Date): string {
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
}

export function mesPorExtenso(mes: string): string {
  const [ano, m] = mes.split("-");
  return `${MESES[Number(m) - 1]}/${ano}`;
}

function deslocarMes(mes: string, delta: number): string {
  const [ano, m] = mes.split("-").map(Number);
  const total = ano * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

export function mesAnterior(mes: string): string {
  return deslocarMes(mes, -1);
}

export function mesSeguinte(mes: string): string {
  return deslocarMes(mes, 1);
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `deno test lib/tempo_test.ts`
Expected: PASS — 4 testes.

- [ ] **Step 5: Escrever `lib/render_test.ts`**

```ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import type { Lancamento, Saldo } from "./types.ts";
import { serialParaDate } from "./tempo.ts";
import {
  confirmacao,
  erroValor,
  extrairLinha,
  linkWhatsApp,
  perguntaDescricao,
  perguntaTipo,
  textoExtrato,
  textoSaldo,
} from "./render.ts";

const lanc: Lancamento = {
  data: serialParaDate(46269.5),
  tipo: "Saída",
  centavos: 5000,
  descricao: "pão & café",
  quem: "Bruno",
};

Deno.test("perguntaTipo ecoa o valor interpretado e oferece os dois botões", () => {
  const m = perguntaTipo(123456);
  assertStringIncludes(m.text, "R$ 1.234,56");
  const kb = (m.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
  assertEquals(kb[0].map((b) => b.callback_data), ["n|E|123456", "n|S|123456"]);
});

Deno.test("linkWhatsApp codifica acento, & e quebra de linha", () => {
  const url = linkWhatsApp(lanc);
  assert(url.startsWith("https://wa.me/?text="));
  const texto = decodeURIComponent(url.slice("https://wa.me/?text=".length));
  assertStringIncludes(texto, "pão & café");
  assertStringIncludes(texto, "R$ 50,00");
  assertStringIncludes(texto, "Saída");
  // nada de caractere cru que quebre a query string
  assert(!url.includes(" "));
  assert(!url.includes("\n"));
  assert(!url.includes("&text"));
});

Deno.test("confirmacao traz o botão de descrever e o de compartilhar", () => {
  const m = confirmacao(lanc, 42);
  const kb = (m.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data?: string; url?: string }>>;
  }).inline_keyboard;
  assertEquals(kb[0][0].callback_data, "d|42");
  assert(kb[1][0].url!.startsWith("https://wa.me/?text="));
});

Deno.test("perguntaDescricao usa force_reply e carrega a linha no texto", () => {
  const m = perguntaDescricao(42);
  assertEquals(extrairLinha(m.text), 42);
  assertEquals((m.reply_markup as { force_reply: boolean }).force_reply, true);
});

Deno.test("extrairLinha ignora texto sem marcador", () => {
  assertEquals(extrairLinha("qualquer coisa"), null);
  assertEquals(extrairLinha("Qual foi o gasto? #7"), 7);
});

Deno.test("erroValor pede nova digitação com force_reply", () => {
  const m = erroValor("50,5555", "formato");
  assertStringIncludes(m.text, "50,5555");
  assertStringIncludes(m.text, "1.234,56");
  assertEquals((m.reply_markup as { force_reply: boolean }).force_reply, true);
});

Deno.test("erroValor explica cada motivo de recusa", () => {
  assertStringIncludes(erroValor("0", "zero").text, "maior que zero");
  assertStringIncludes(erroValor("-5", "negativo").text, "sem sinal");
  assertStringIncludes(erroValor("9999999", "muito-alto").text, "1.000.000");
});

Deno.test("textoSaldo mostra mês e acumulado", () => {
  const s: Saldo = {
    mes: "2026-09",
    entradasCentavos: 200000,
    saidasCentavos: 35000,
    resultadoCentavos: 165000,
    acumuladoCentavos: 482000,
  };
  const m = textoSaldo(s);
  assertStringIncludes(m.text, "Setembro/2026");
  assertStringIncludes(m.text, "2.000,00");
  assertStringIncludes(m.text, "1.650,00");
  assertStringIncludes(m.text, "4.820,00");
  const kb = (m.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
  assertEquals(kb[0][0].callback_data, "m|2026-08");
});

Deno.test("textoExtrato lista lançamentos e pagina só quando há mais", () => {
  const m = textoExtrato([lanc], 0, true);
  assertStringIncludes(m.text, "04/09");
  assertStringIncludes(m.text, "50,00");
  assertStringIncludes(m.text, "pão & café");
  const kb = (m.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
  assertEquals(kb[0][0].callback_data, "x|10");

  const fim = textoExtrato([lanc], 10, false);
  assertEquals(fim.reply_markup, undefined);
});

Deno.test("textoExtrato lida com planilha vazia", () => {
  assertStringIncludes(textoExtrato([], 0, false).text, "nenhum lançamento");
});
```

- [ ] **Step 6: Rodar e confirmar que falha**

Run: `deno test lib/render_test.ts`
Expected: FAIL — `Module not found "./render.ts"`

- [ ] **Step 7: Implementar `lib/render.ts`**

```ts
import { type ErroValor, formatarBRL } from "./money.ts";
import type { Lancamento, Saldo } from "./types.ts";
import { encodeCallback } from "./callback.ts";
import { ddMM, mesAnterior, mesPorExtenso, mesSeguinte } from "./tempo.ts";

export interface Mensagem {
  text: string;
  reply_markup?: unknown;
}

export const PAGINA_EXTRATO = 10;

const SETA: Record<Lancamento["tipo"], string> = { Entrada: "⬇️", Saída: "⬆️" };

export function perguntaTipo(centavos: number): Mensagem {
  return {
    text: `R$ ${formatarBRL(centavos)} — entrada ou saída?`,
    reply_markup: {
      inline_keyboard: [[
        { text: "⬇️ Entrada", callback_data: encodeCallback({ tipo: "n", lancamento: "Entrada", centavos }) },
        { text: "⬆️ Saída", callback_data: encodeCallback({ tipo: "n", lancamento: "Saída", centavos }) },
      ]],
    },
  };
}

/** Texto enviado ao WhatsApp; também é a base da mensagem de confirmação. */
function resumo(l: Lancamento): string {
  const desc = l.descricao ? ` · ${l.descricao}` : "";
  return `${l.tipo} de R$ ${formatarBRL(l.centavos)}${desc} · ${ddMM(l.data)} · ${l.quem}`;
}

export function linkWhatsApp(l: Lancamento): string {
  return `https://wa.me/?text=${encodeURIComponent(resumo(l))}`;
}

export function confirmacao(l: Lancamento, linha: number): Mensagem {
  const teclado: Array<Array<Record<string, string>>> = [];
  if (!l.descricao) {
    teclado.push([{
      text: "✏️ Qual foi o gasto?",
      callback_data: encodeCallback({ tipo: "d", linha }),
    }]);
  }
  teclado.push([{ text: "📤 Compartilhar", url: linkWhatsApp(l) }]);
  return { text: `✅ ${resumo(l)}`, reply_markup: { inline_keyboard: teclado } };
}

const MARCADOR = /#(\d+)\s*$/;

export function perguntaDescricao(linha: number): Mensagem {
  return {
    text: `Qual foi o gasto? #${linha}`,
    reply_markup: {
      force_reply: true,
      input_field_placeholder: "ex.: mercado",
    },
  };
}

/** Recupera o número da linha embutido em "Qual foi o gasto? #42". */
export function extrairLinha(texto: string): number | null {
  const m = texto.match(MARCADOR);
  return m ? Number(m[1]) : null;
}

const MOTIVOS: Record<ErroValor, string> = {
  formato: "não consegui ler isso como um valor.",
  zero: "o valor precisa ser maior que zero.",
  negativo: "manda o valor sem sinal — o tipo você escolhe no botão.",
  "muito-alto": "esse valor passa do limite de R$ 1.000.000,00.",
};

export function erroValor(entrada: string, erro: ErroValor): Mensagem {
  return {
    text: [
      `❌ "${entrada}" — ${MOTIVOS[erro]}`,
      "",
      "Manda de novo — aceito assim:",
      "   50        50,90       1.234,56",
      "   R$ 12,30  1234.56",
    ].join("\n"),
    reply_markup: {
      force_reply: true,
      input_field_placeholder: "valor, ex.: 50,90",
    },
  };
}

export function textoSaldo(s: Saldo): Mensagem {
  const linha = (rotulo: string, centavos: number) =>
    `  ${rotulo.padEnd(10)} R$ ${formatarBRL(centavos).padStart(12)}`;

  const teclado = [[
    { text: `◀️ ${mesPorExtenso(mesAnterior(s.mes)).split("/")[0]}`, callback_data: encodeCallback({ tipo: "m", mes: mesAnterior(s.mes) }) },
    { text: `${mesPorExtenso(mesSeguinte(s.mes)).split("/")[0]} ▶️`, callback_data: encodeCallback({ tipo: "m", mes: mesSeguinte(s.mes) }) },
  ]];

  return {
    text: [
      `📅 ${mesPorExtenso(s.mes)}`,
      linha("Entradas", s.entradasCentavos),
      linha("Saídas", s.saidasCentavos),
      linha("Resultado", s.resultadoCentavos),
      "",
      `Σ Acumulado geral  R$ ${formatarBRL(s.acumuladoCentavos)}`,
    ].join("\n"),
    reply_markup: { inline_keyboard: teclado },
  };
}

export function textoExtrato(ls: Lancamento[], offset: number, temMais: boolean): Mensagem {
  if (ls.length === 0) {
    return { text: "Ainda não há nenhum lançamento registrado." };
  }
  const linhas = ls.map((l) =>
    `${ddMM(l.data)}  ${SETA[l.tipo]} ${formatarBRL(l.centavos).padStart(10)}  ${l.descricao || "—"}  ·  ${l.quem}`
  );
  const msg: Mensagem = { text: linhas.join("\n") };
  if (temMais) {
    msg.reply_markup = {
      inline_keyboard: [[{
        text: `⬇️ Ver mais ${PAGINA_EXTRATO}`,
        callback_data: encodeCallback({ tipo: "x", offset: offset + PAGINA_EXTRATO }),
      }]],
    };
  }
  return msg;
}

export function dicaUso(): Mensagem {
  return {
    text: [
      "Manda um valor para registrar um lançamento. Ex.: 50 · 12,90 · 1.234,56",
      "",
      "/saldo — resumo do mês e acumulado",
      "/extrato — últimos lançamentos",
    ].join("\n"),
  };
}
```

- [ ] **Step 8: Rodar e confirmar que passa**

Run: `deno test lib/render_test.ts`
Expected: PASS — 10 testes.

- [ ] **Step 9: Commit**

```bash
git add lib/tempo.ts lib/tempo_test.ts lib/render.ts lib/render_test.ts
git commit -m "feat(render): mensagens, teclados e link de compartilhamento no whatsapp"
```

---

### Task 4: `lib/google_auth.ts`

Troca a chave da service account por um access token, assinando um JWT RS256 com Web Crypto. Nenhuma biblioteca externa.

**Files:**
- Create: `lib/google_auth.ts`
- Test: `lib/google_auth_test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `interface ServiceAccount { client_email: string; private_key: string }`
  - `type ObterToken = () => Promise<string>`
  - `criarAuth(sa: ServiceAccount, fetchImpl?: typeof fetch): ObterToken`
  - `lerServiceAccount(json: string): ServiceAccount`

- [ ] **Step 1: Escrever `lib/google_auth_test.ts`**

```ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { criarAuth, lerServiceAccount, type ServiceAccount } from "./google_auth.ts";

function b64urlParaBytes(s: string): Uint8Array {
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
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;

  return {
    sa: { client_email: "bot@proj.iam.gserviceaccount.com", private_key: pem },
    publica: par.publicKey,
  };
}

/** fetch falso que registra as chamadas e devolve um token. */
function fetchFalso(respostas: Response[]) {
  const chamadas: Array<{ url: string; body: URLSearchParams }> = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    chamadas.push({
      url: String(input),
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    return respostas.shift() ?? new Response("sem resposta", { status: 500 });
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
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `deno test lib/google_auth_test.ts`
Expected: FAIL — `Module not found "./google_auth.ts"`

- [ ] **Step 3: Implementar `lib/google_auth.ts`**

```ts
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
  const bytes = typeof dados === "string"
    ? new TextEncoder().encode(dados)
    : new Uint8Array(dados);
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
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `deno test lib/google_auth_test.ts`
Expected: PASS — 5 testes.

- [ ] **Step 5: Commit**

```bash
git add lib/google_auth.ts lib/google_auth_test.ts
git commit -m "feat(auth): access token do google via jwt rs256 com web crypto"
```

---

### Task 5: `lib/sheets.ts`

Cliente REST mínimo do Google Sheets: três operações, `fetch` injetável, erros com mensagem que aponta a causa provável.

**Files:**
- Create: `lib/sheets.ts`
- Test: `lib/sheets_test.ts`

**Interfaces:**
- Consumes: `ObterToken` (Task 4).
- Produces:
  - `interface SheetsClient { append(range: string, linhas: unknown[][]): Promise<{ linha: number }>; get(range: string): Promise<unknown[][]>; update(range: string, linhas: unknown[][]): Promise<void> }`
  - `criarSheets(spreadsheetId: string, obterToken: ObterToken, fetchImpl?: typeof fetch): SheetsClient`
  - `class ErroSheets extends Error { status: number }`

- [ ] **Step 1: Escrever `lib/sheets_test.ts`**

```ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { criarSheets, ErroSheets } from "./sheets.ts";

function fetchFalso(respostas: Response[]) {
  const chamadas: Array<{ url: string; method: string; auth: string; body: unknown }> = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    chamadas.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.get("authorization") ?? "",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return respostas.shift() ?? new Response("sem resposta", { status: 500 });
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

  const { linha } = await sheets.append("Lançamentos!A:F", [["2026-09-04 14:32:00", "Saída", 50.5, "", "Bruno", 7]]);

  assertEquals(linha, 42);
  assertEquals(chamadas[0].method, "POST");
  assertEquals(chamadas[0].auth, "Bearer ya29.token");
  assert(chamadas[0].url.includes("/v4/spreadsheets/PLANILHA/values/"));
  assert(chamadas[0].url.includes(":append"));
  assert(chamadas[0].url.includes("valueInputOption=USER_ENTERED"));
  assert(chamadas[0].url.includes("insertDataOption=INSERT_ROWS"));
  assertEquals(chamadas[0].body, { values: [["2026-09-04 14:32:00", "Saída", 50.5, "", "Bruno", 7]] });
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
  const { impl } = fetchFalso([new Response("The caller does not have permission", { status: 403 })]);
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
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `deno test lib/sheets_test.ts`
Expected: FAIL — `Module not found "./sheets.ts"`

- [ ] **Step 3: Implementar `lib/sheets.ts`**

```ts
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
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `deno test lib/sheets_test.ts`
Expected: PASS — 6 testes.

- [ ] **Step 5: Commit**

```bash
git add lib/sheets.ts lib/sheets_test.ts
git commit -m "feat(sheets): cliente rest do google sheets com fetch injetável"
```

---

### Task 6: `lib/ledger.ts`

O domínio. Traduz linhas da planilha em lançamentos e implementa registrar, descrever, saldo e extrato. Nenhum conhecimento de Telegram.

**Files:**
- Create: `lib/ledger.ts`
- Test: `lib/ledger_test.ts`

**Interfaces:**
- Consumes: `SheetsClient` (Task 5); `Lancamento`, `Saldo` (Task 2); `dataParaISO`, `serialParaDate`, `mesDe` (Task 3).
- Produces:
  - `const ABA = "Lançamentos"`
  - `const CABECALHO: string[]`
  - `interface Ledger { registrar(l: Lancamento, updateId: number): Promise<{ linha: number; duplicado: boolean }>; descrever(linha: number, descricao: string): Promise<void>; saldo(mes: string): Promise<Saldo>; extrato(offset: number, limite: number): Promise<{ itens: Lancamento[]; temMais: boolean }> }`
  - `criarLedger(sheets: SheetsClient): Ledger`

- [ ] **Step 1: Escrever `lib/ledger_test.ts`**

```ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import type { SheetsClient } from "./sheets.ts";
import type { Lancamento } from "./types.ts";
import { serialParaDate } from "./tempo.ts";
import { criarLedger } from "./ledger.ts";

/** Planilha falsa em memória: cada item é uma linha A..F. */
function sheetsFalso(linhas: unknown[][] = []) {
  const dados = linhas.map((l) => [...l]);
  const client: SheetsClient = {
    // deno-lint-ignore require-await
    async append(_range, novas) {
      dados.push(...novas.map((l) => [...l]));
      return { linha: dados.length + 1 }; // +1 por causa do cabeçalho
    },
    // deno-lint-ignore require-await
    async get(range) {
      const colunas = range.includes("!F") ? [5] : range.includes("A2:C") ? [0, 1, 2] : [0, 1, 2, 3, 4];
      return dados.map((l) => colunas.map((i) => l[i]));
    },
    // deno-lint-ignore require-await
    async update(range, valores) {
      const linha = Number(range.match(/(\d+)$/)![1]);
      dados[linha - 2][3] = valores[0][0];
    },
  };
  return { client, dados };
}

const SERIAL_04_09 = 46269; // 2026-09-04
const SERIAL_28_08 = 46262; // 2026-08-28

const novo = (over: Partial<Lancamento> = {}): Lancamento => ({
  data: serialParaDate(SERIAL_04_09),
  tipo: "Saída",
  centavos: 5000,
  descricao: "",
  quem: "Bruno",
  ...over,
});

Deno.test("registrar grava valor como número e devolve a linha", async () => {
  const { client, dados } = sheetsFalso();
  const ledger = criarLedger(client);

  const r = await ledger.registrar(novo({ centavos: 5055 }), 7);

  assertEquals(r, { linha: 2, duplicado: false });
  assertEquals(dados[0][1], "Saída");
  assertEquals(dados[0][2], 50.55);
  assertEquals(typeof dados[0][2], "number");
  assertEquals(dados[0][5], 7);
});

Deno.test("registrar ignora update_id já visto", async () => {
  const { client, dados } = sheetsFalso([
    [SERIAL_04_09, "Saída", 50, "", "Bruno", 7],
  ]);
  const ledger = criarLedger(client);

  const r = await ledger.registrar(novo(), 7);

  assertEquals(r, { linha: 2, duplicado: true });
  assertEquals(dados.length, 1, "não deveria ter gravado de novo");
});

Deno.test("descrever escreve na coluna D da linha certa", async () => {
  const { client, dados } = sheetsFalso([
    [SERIAL_04_09, "Saída", 50, "", "Bruno", 7],
    [SERIAL_04_09, "Saída", 30, "", "Ana", 8],
  ]);
  const ledger = criarLedger(client);

  await ledger.descrever(3, "farmácia");

  assertEquals(dados[1][3], "farmácia");
  assertEquals(dados[0][3], "");
});

Deno.test("saldo separa o mês pedido do acumulado geral", async () => {
  const { client } = sheetsFalso([
    [SERIAL_28_08, "Entrada", 100, "", "Bruno", 1],
    [SERIAL_04_09, "Entrada", 2000, "salário", "Bruno", 2],
    [SERIAL_04_09, "Saída", 350, "mercado", "Ana", 3],
  ]);
  const ledger = criarLedger(client);

  assertEquals(await ledger.saldo("2026-09"), {
    mes: "2026-09",
    entradasCentavos: 200000,
    saidasCentavos: 35000,
    resultadoCentavos: 165000,
    acumuladoCentavos: 175000,
  });
});

Deno.test("saldo de mês sem lançamentos devolve zeros mas mantém o acumulado", async () => {
  const { client } = sheetsFalso([[SERIAL_04_09, "Entrada", 100, "", "Bruno", 1]]);
  const ledger = criarLedger(client);

  assertEquals(await ledger.saldo("2026-07"), {
    mes: "2026-07",
    entradasCentavos: 0,
    saidasCentavos: 0,
    resultadoCentavos: 0,
    acumuladoCentavos: 10000,
  });
});

Deno.test("saldo de planilha vazia devolve tudo zerado", async () => {
  const { client } = sheetsFalso();
  const ledger = criarLedger(client);
  const s = await ledger.saldo("2026-09");
  assertEquals(s.acumuladoCentavos, 0);
  assertEquals(s.resultadoCentavos, 0);
});

Deno.test("extrato devolve do mais recente para o mais antigo, paginado", async () => {
  const linhas = Array.from({ length: 12 }, (_, i) => [
    SERIAL_04_09,
    "Saída",
    i + 1,
    `item ${i + 1}`,
    "Bruno",
    i,
  ]);
  const { client } = sheetsFalso(linhas);
  const ledger = criarLedger(client);

  const p1 = await ledger.extrato(0, 10);
  assertEquals(p1.itens.length, 10);
  assertEquals(p1.itens[0].descricao, "item 12");
  assertEquals(p1.temMais, true);

  const p2 = await ledger.extrato(10, 10);
  assertEquals(p2.itens.map((i) => i.descricao), ["item 2", "item 1"]);
  assertEquals(p2.temMais, false);
});

Deno.test("linhas corrompidas por edição manual são ignoradas, não derrubam o bot", async () => {
  const { client } = sheetsFalso([
    [SERIAL_04_09, "Entrada", 100, "", "Bruno", 1],
    ["texto solto", "Entrada", "não é número", "", "", 2],
    [SERIAL_04_09, "Tipo Errado", 50, "", "", 3],
    [],
  ]);
  const ledger = criarLedger(client);

  const s = await ledger.saldo("2026-09");
  assertEquals(s.acumuladoCentavos, 10000);
  assertEquals((await ledger.extrato(0, 10)).itens.length, 1);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `deno test lib/ledger_test.ts`
Expected: FAIL — `Module not found "./ledger.ts"`

- [ ] **Step 3: Implementar `lib/ledger.ts`**

```ts
import type { SheetsClient } from "./sheets.ts";
import type { Lancamento, Saldo, TipoLancamento } from "./types.ts";
import { dataParaISO, mesDe, serialParaDate } from "./tempo.ts";

export const ABA = "Lançamentos";
export const CABECALHO = ["Data", "Tipo", "Valor", "Descrição", "Quem", "update_id"];

/** Quantos update_id recentes olhar ao procurar reentrega do Telegram. */
const JANELA_DEDUPE = 20;

export interface Ledger {
  registrar(l: Lancamento, updateId: number): Promise<{ linha: number; duplicado: boolean }>;
  descrever(linha: number, descricao: string): Promise<void>;
  saldo(mes: string): Promise<Saldo>;
  extrato(offset: number, limite: number): Promise<{ itens: Lancamento[]; temMais: boolean }>;
}

function ehTipo(v: unknown): v is TipoLancamento {
  return v === "Entrada" || v === "Saída";
}

/**
 * Converte uma linha da planilha em Lancamento, ou null se ela não for válida.
 * A planilha é editável à mão: uma linha estragada não pode derrubar o bot.
 */
function paraLancamento(linha: unknown[]): Lancamento | null {
  const [data, tipo, valor, descricao, quem] = linha;
  if (typeof data !== "number" || !Number.isFinite(data)) return null;
  if (!ehTipo(tipo)) return null;
  if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
  return {
    data: serialParaDate(data),
    tipo,
    centavos: Math.round(valor * 100),
    descricao: descricao == null ? "" : String(descricao),
    quem: quem == null ? "" : String(quem),
  };
}

export function criarLedger(sheets: SheetsClient): Ledger {
  async function todos(): Promise<Lancamento[]> {
    const linhas = await sheets.get(`${ABA}!A2:E`);
    return linhas.map(paraLancamento).filter((l): l is Lancamento => l !== null);
  }

  return {
    async registrar(l, updateId) {
      const ids = (await sheets.get(`${ABA}!F2:F`)).map((r) => r[0]);
      const inicio = Math.max(0, ids.length - JANELA_DEDUPE);
      const jaVisto = ids.indexOf(updateId, inicio);
      if (jaVisto >= 0) return { linha: jaVisto + 2, duplicado: true };

      const { linha } = await sheets.append(`${ABA}!A:F`, [[
        dataParaISO(l.data),
        l.tipo,
        l.centavos / 100,
        l.descricao,
        l.quem,
        updateId,
      ]]);
      return { linha, duplicado: false };
    },

    async descrever(linha, descricao) {
      await sheets.update(`${ABA}!D${linha}`, [[descricao]]);
    },

    async saldo(mes) {
      const linhas = await sheets.get(`${ABA}!A2:C`);
      let entradasCentavos = 0;
      let saidasCentavos = 0;
      let acumuladoCentavos = 0;

      for (const bruta of linhas) {
        const l = paraLancamento(bruta);
        if (!l) continue;
        const sinal = l.tipo === "Entrada" ? 1 : -1;
        acumuladoCentavos += sinal * l.centavos;
        if (mesDe(l.data) !== mes) continue;
        if (l.tipo === "Entrada") entradasCentavos += l.centavos;
        else saidasCentavos += l.centavos;
      }

      return {
        mes,
        entradasCentavos,
        saidasCentavos,
        resultadoCentavos: entradasCentavos - saidasCentavos,
        acumuladoCentavos,
      };
    },

    async extrato(offset, limite) {
      const itens = (await todos()).reverse();
      return {
        itens: itens.slice(offset, offset + limite),
        temMais: itens.length > offset + limite,
      };
    },
  };
}
```

**Nota sobre `dataParaISO(l.data)`:** o `Lancamento` já chega com a data normalizada para wall-clock de São Paulo pelo chamador (via `agoraLocal`). O ledger só formata — não converte fuso. Formatar e converter no mesmo lugar causaria dupla conversão em quem já normalizou.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `deno test lib/ledger_test.ts`
Expected: PASS — 8 testes.

- [ ] **Step 5: Rodar a suíte inteira**

Run: `deno task test`
Expected: PASS — todos os testes das tasks 1 a 6.

- [ ] **Step 6: Commit**

```bash
git add lib/ledger.ts lib/ledger_test.ts
git commit -m "feat(ledger): domínio de lançamentos, saldo e extrato sobre a planilha"
```

---

### Task 7: `bot.ts` — allowlist e registro de lançamento

Primeira metade dos handlers: quem pode falar com o bot, o que acontece com uma mensagem de texto, e a gravação disparada pelos botões Entrada/Saída.

**Files:**
- Create: `bot.ts`
- Test: `bot_test.ts`

**Interfaces:**
- Consumes: `Ledger` (Task 6); `parseValor`, `pareceValor` (Task 1); `decodeCallback` (Task 2); `perguntaTipo`, `confirmacao`, `erroValor`, `dicaUso`, `Mensagem` (Task 3).
- Produces:
  - `interface DepsBot { token: string; permitidos: Set<number>; ledger: Ledger; agora?: () => Date; botInfo?: unknown }`
  - `criarBot(deps: DepsBot): Bot`
  - `criarTestBot(...)` NÃO existe — os testes montam o bot com `criarBot` e interceptam via `bot.api.config.use`.

- [ ] **Step 1: Escrever `bot_test.ts` (parte 1)**

```ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import type { Update } from "grammy/types";
import type { Ledger } from "./lib/ledger.ts";
import type { Lancamento, Saldo } from "./lib/types.ts";
import { criarBot } from "./bot.ts";

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Bot",
  username: "bot_teste",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as unknown as Record<string, unknown>;

const EU = 55;
const ESTRANHO = 99;

export interface Chamada {
  method: string;
  payload: Record<string, unknown>;
}

/** Ledger falso que registra o que foi pedido e devolve respostas fixas. */
function ledgerFalso(over: Partial<Ledger> = {}) {
  const registros: Array<{ l: Lancamento; updateId: number }> = [];
  const descricoes: Array<{ linha: number; descricao: string }> = [];
  const ledger: Ledger = {
    // deno-lint-ignore require-await
    async registrar(l, updateId) {
      registros.push({ l, updateId });
      return { linha: 42, duplicado: false };
    },
    // deno-lint-ignore require-await
    async descrever(linha, descricao) {
      descricoes.push({ linha, descricao });
    },
    // deno-lint-ignore require-await
    async saldo(mes): Promise<Saldo> {
      return {
        mes,
        entradasCentavos: 0,
        saidasCentavos: 0,
        resultadoCentavos: 0,
        acumuladoCentavos: 0,
      };
    },
    // deno-lint-ignore require-await
    async extrato() {
      return { itens: [], temMais: false };
    },
    ...over,
  };
  return { ledger, registros, descricoes };
}

export function montar(ledger: Ledger) {
  const chamadas: Chamada[] = [];
  const bot = criarBot({
    token: "12345:fake",
    permitidos: new Set([EU]),
    ledger,
    agora: () => new Date("2026-09-04T17:32:00Z"),
    botInfo: BOT_INFO,
  });
  bot.api.config.use((_prev, method, payload) => {
    chamadas.push({ method, payload: payload as Record<string, unknown> });
    return Promise.resolve({
      ok: true,
      result: { message_id: 1, date: 0, chat: { id: EU, type: "private" } },
      // deno-lint-ignore no-explicit-any
    } as any);
  });
  return { bot, chamadas };
}

export function updTexto(
  text: string,
  extra: Record<string, unknown> = {},
  from = EU,
  update_id = 100,
): Update {
  return {
    update_id,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: from, type: "private", first_name: "Bruno" },
      from: { id: from, is_bot: false, first_name: from === EU ? "Bruno" : "Estranho" },
      text,
      ...extra,
    },
  } as unknown as Update;
}

export function updCallback(data: string, update_id = 200, from = EU): Update {
  return {
    update_id,
    callback_query: {
      id: "cb1",
      chat_instance: "ci",
      from: { id: from, is_bot: false, first_name: "Bruno" },
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: from, type: "private" },
        text: "R$ 50,00 — entrada ou saída?",
      },
    },
  } as unknown as Update;
}

Deno.test("ignora em silêncio quem não está na allowlist", async () => {
  const { ledger } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updTexto("50", {}, ESTRANHO));
  assertEquals(chamadas, []);
});

Deno.test("valor válido ecoa a interpretação e oferece os botões", async () => {
  const { ledger } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updTexto("1.234,56"));

  assertEquals(chamadas.length, 1);
  assertEquals(chamadas[0].method, "sendMessage");
  assertStringIncludes(String(chamadas[0].payload.text), "R$ 1.234,56");
});

Deno.test("valor ilegível pede nova digitação com force_reply", async () => {
  const { ledger } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updTexto("50,5555"));

  assertEquals(chamadas[0].method, "sendMessage");
  assertStringIncludes(String(chamadas[0].payload.text), "50,5555");
  assertEquals(
    (chamadas[0].payload.reply_markup as { force_reply: boolean }).force_reply,
    true,
  );
});

Deno.test("mensagem sem dígito nenhum recebe só a dica de uso", async () => {
  const { ledger } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updTexto("bom dia"));

  assertStringIncludes(String(chamadas[0].payload.text), "/saldo");
  assertEquals(chamadas[0].payload.reply_markup, undefined);
});

Deno.test("botão Saída grava o lançamento e edita a mensagem", async () => {
  const { ledger, registros } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("n|S|5000", 777));

  assertEquals(registros.length, 1);
  assertEquals(registros[0].l.tipo, "Saída");
  assertEquals(registros[0].l.centavos, 5000);
  assertEquals(registros[0].l.quem, "Bruno");
  assertEquals(registros[0].updateId, 777);

  const editar = chamadas.find((c) => c.method === "editMessageText");
  assert(editar, "deveria editar a mensagem original");
  assertStringIncludes(String(editar.payload.text), "R$ 50,00");
  assert(chamadas.some((c) => c.method === "answerCallbackQuery"));
});

Deno.test("reentrega do Telegram não gera segunda linha", async () => {
  const { ledger } = ledgerFalso({
    // deno-lint-ignore require-await
    async registrar() {
      return { linha: 42, duplicado: true };
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("n|S|5000", 777));

  assert(chamadas.some((c) => c.method === "answerCallbackQuery"));
  assert(!chamadas.some((c) => c.method === "sendMessage"));
});

Deno.test("callback_data corrompido não derruba o handler", async () => {
  const { ledger, registros } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("lixo"));

  assertEquals(registros.length, 0);
  assert(chamadas.some((c) => c.method === "answerCallbackQuery"));
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `deno test bot_test.ts`
Expected: FAIL — `Module not found "./bot.ts"`

- [ ] **Step 3: Implementar `bot.ts`**

```ts
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Ledger } from "./lib/ledger.ts";
import type { Lancamento } from "./lib/types.ts";
import { pareceValor, parseValor } from "./lib/money.ts";
import { decodeCallback } from "./lib/callback.ts";
import { agoraLocal, mesDe } from "./lib/tempo.ts";
import {
  confirmacao,
  dicaUso,
  erroValor,
  extrairLinha,
  type Mensagem,
  PAGINA_EXTRATO,
  perguntaDescricao,
  perguntaTipo,
  textoExtrato,
  textoSaldo,
} from "./lib/render.ts";

export interface DepsBot {
  token: string;
  permitidos: Set<number>;
  ledger: Ledger;
  agora?: () => Date;
  botInfo?: unknown;
}

export function criarBot({ token, permitidos, ledger, agora = () => new Date(), botInfo }: DepsBot): Bot {
  const bot = new Bot(token, botInfo ? { botInfo: botInfo as UserFromGetMe } : undefined);

  // Quem não está na allowlist não recebe resposta alguma — nem um erro.
  // Silêncio evita confirmar que o bot existe para quem descobriu o @.
  bot.use(async (ctx, next) => {
    if (ctx.from && permitidos.has(ctx.from.id)) await next();
  });

  bot.command(["start", "ajuda", "help"], (ctx) => responder(ctx, dicaUso()));

  bot.on("message:text", async (ctx) => {
    const texto = ctx.message.text;

    // 1. Resposta a "Qual foi o gasto? #42" -> é descrição, não passa pelo parser.
    const linha = extrairLinha(ctx.message.reply_to_message?.text ?? "");
    if (linha !== null) {
      await ledger.descrever(linha, texto.trim());
      await ctx.reply(`✏️ Descrição salva: ${texto.trim()}`);
      return;
    }

    // 2. Tem dígito -> tentativa de valor.
    if (pareceValor(texto)) {
      const r = parseValor(texto);
      await responder(ctx, r.ok ? perguntaTipo(r.centavos) : erroValor(texto.trim(), r.erro));
      return;
    }

    // 3. Nem uma coisa nem outra -> só a dica.
    await responder(ctx, dicaUso());
  });

  bot.callbackQuery(/^n\|/, async (ctx) => {
    const cb = decodeCallback(ctx.callbackQuery.data);
    if (cb?.tipo !== "n") return await ctx.answerCallbackQuery();

    const lancamento: Lancamento = {
      // agoraLocal normaliza para wall-clock de SP; sem isso, um lançamento
      // feito depois das 21h seria gravado com a data do dia seguinte.
      data: agoraLocal(agora()),
      tipo: cb.lancamento,
      centavos: cb.centavos,
      descricao: "",
      quem: ctx.from.first_name,
    };

    const { linha, duplicado } = await ledger.registrar(lancamento, ctx.update.update_id);
    await ctx.answerCallbackQuery();
    if (duplicado) return;

    const msg = confirmacao(lancamento, linha);
    await ctx.editMessageText(msg.text, { reply_markup: msg.reply_markup as never });
  });

  // Qualquer callback que não bata com os prefixos conhecidos: só apaga o spinner.
  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery());

  bot.catch((err) => console.error("erro no handler:", err));

  return bot;
}

// deno-lint-ignore no-explicit-any
function responder(ctx: any, m: Mensagem) {
  return ctx.reply(m.text, m.reply_markup ? { reply_markup: m.reply_markup } : {});
}
```

**Nota sobre a ordem dos handlers:** `bot.command` precisa vir antes de `bot.on("message:text")`, senão `/saldo` cairia no fluxo de valor. O `callback_query:data` genérico vem por último, como rede de segurança para dados corrompidos.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `deno test bot_test.ts`
Expected: PASS — 7 testes.

- [ ] **Step 5: Commit**

```bash
git add bot.ts bot_test.ts
git commit -m "feat(bot): allowlist, leitura de valor e gravação pelos botões de tipo"
```

---

### Task 8: `bot.ts` — descrição, saldo e extrato

Segunda metade dos handlers: o botão de descrever, os comandos de consulta e a navegação entre meses e páginas.

**Files:**
- Modify: `bot.ts` (acrescentar handlers antes do `bot.catch`)
- Modify: `bot_test.ts` (acrescentar testes ao final)

**Interfaces:**
- Consumes: tudo da Task 7, mais `textoSaldo`, `textoExtrato`, `perguntaDescricao`, `PAGINA_EXTRATO` (Task 3) e `mesDe` (Task 3).
- Produces: nenhuma interface nova; completa os handlers de `criarBot`.

- [ ] **Step 1: Acrescentar os testes que falham em `bot_test.ts`**

```ts
Deno.test("botão de descrever manda a pergunta com force_reply e a linha embutida", async () => {
  const { ledger } = ledgerFalso();
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("d|42"));

  const envio = chamadas.find((c) => c.method === "sendMessage")!;
  assertStringIncludes(String(envio.payload.text), "#42");
  assertEquals((envio.payload.reply_markup as { force_reply: boolean }).force_reply, true);
});

Deno.test("resposta à pergunta grava a descrição na linha certa", async () => {
  const { ledger, descricoes } = ledgerFalso();
  const { bot } = montar(ledger);
  await bot.handleUpdate(updTexto("mercado", {
    reply_to_message: {
      message_id: 9,
      date: 0,
      chat: { id: 55, type: "private" },
      text: "Qual foi o gasto? #42",
    },
  }));

  assertEquals(descricoes, [{ linha: 42, descricao: "mercado" }]);
});

Deno.test("uma resposta com número não é confundida com novo lançamento", async () => {
  const { ledger, descricoes } = ledgerFalso();
  const { bot } = montar(ledger);
  await bot.handleUpdate(updTexto("uber 2 corridas", {
    reply_to_message: {
      message_id: 9,
      date: 0,
      chat: { id: 55, type: "private" },
      text: "Qual foi o gasto? #42",
    },
  }));

  assertEquals(descricoes, [{ linha: 42, descricao: "uber 2 corridas" }]);
});

Deno.test("/saldo consulta o mês corrente segundo o relógio injetado", async () => {
  const mesesPedidos: string[] = [];
  const { ledger } = ledgerFalso({
    // deno-lint-ignore require-await
    async saldo(mes) {
      mesesPedidos.push(mes);
      return {
        mes,
        entradasCentavos: 200000,
        saidasCentavos: 35000,
        resultadoCentavos: 165000,
        acumuladoCentavos: 482000,
      };
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updTexto("/saldo", { entities: [{ type: "bot_command", offset: 0, length: 6 }] }));

  assertEquals(mesesPedidos, ["2026-09"]);
  assertStringIncludes(String(chamadas[0].payload.text), "Setembro/2026");
  assertStringIncludes(String(chamadas[0].payload.text), "1.650,00");
});

Deno.test("botão de mês reconsulta e edita a mesma mensagem", async () => {
  const mesesPedidos: string[] = [];
  const { ledger } = ledgerFalso({
    // deno-lint-ignore require-await
    async saldo(mes) {
      mesesPedidos.push(mes);
      return {
        mes,
        entradasCentavos: 0,
        saidasCentavos: 0,
        resultadoCentavos: 0,
        acumuladoCentavos: 0,
      };
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("m|2026-08"));

  assertEquals(mesesPedidos, ["2026-08"]);
  assert(chamadas.some((c) => c.method === "editMessageText"));
});

Deno.test("/extrato pede a primeira página", async () => {
  const pedidos: Array<[number, number]> = [];
  const { ledger } = ledgerFalso({
    // deno-lint-ignore require-await
    async extrato(offset, limite) {
      pedidos.push([offset, limite]);
      return { itens: [], temMais: false };
    },
  });
  const { bot } = montar(ledger);
  await bot.handleUpdate(updTexto("/extrato", { entities: [{ type: "bot_command", offset: 0, length: 8 }] }));

  assertEquals(pedidos, [[0, 10]]);
});

Deno.test("botão Ver mais avança o offset e edita a mensagem", async () => {
  const pedidos: Array<[number, number]> = [];
  const { ledger } = ledgerFalso({
    // deno-lint-ignore require-await
    async extrato(offset, limite) {
      pedidos.push([offset, limite]);
      return { itens: [], temMais: false };
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("x|10"));

  assertEquals(pedidos, [[10, 10]]);
  assert(chamadas.some((c) => c.method === "editMessageText"));
});

Deno.test("falha do ledger vira aviso ao usuário, não exceção não tratada", async () => {
  const { ledger } = ledgerFalso({
    registrar() {
      return Promise.reject(new Error("Sheets 403: sem permissão"));
    },
  });
  const { bot, chamadas } = montar(ledger);
  await bot.handleUpdate(updCallback("n|S|5000"));

  assert(
    chamadas.some((c) => String(c.payload.text ?? "").includes("não consegui")),
    "usuário precisa ser avisado da falha",
  );
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `deno test bot_test.ts`
Expected: FAIL — os 8 testes novos falham (handlers ainda não existem).

- [ ] **Step 3: Acrescentar os handlers em `bot.ts`**

Insira estes handlers **depois** do `bot.callbackQuery(/^n\|/, ...)` e **antes** do `bot.on("callback_query:data", ...)` genérico:

```ts
  bot.command("saldo", async (ctx) => {
    const s = await ledger.saldo(mesDe(agora()));
    await responder(ctx, textoSaldo(s));
  });

  bot.command("extrato", async (ctx) => {
    const { itens, temMais } = await ledger.extrato(0, PAGINA_EXTRATO);
    await responder(ctx, textoExtrato(itens, 0, temMais));
  });

  bot.callbackQuery(/^d\|/, async (ctx) => {
    const cb = decodeCallback(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery();
    if (cb?.tipo !== "d") return;
    const m = perguntaDescricao(cb.linha);
    await ctx.reply(m.text, { reply_markup: m.reply_markup as never });
  });

  bot.callbackQuery(/^m\|/, async (ctx) => {
    const cb = decodeCallback(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery();
    if (cb?.tipo !== "m") return;
    const m = textoSaldo(await ledger.saldo(cb.mes));
    await ctx.editMessageText(m.text, { reply_markup: m.reply_markup as never });
  });

  bot.callbackQuery(/^x\|/, async (ctx) => {
    const cb = decodeCallback(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery();
    if (cb?.tipo !== "x") return;
    const { itens, temMais } = await ledger.extrato(cb.offset, PAGINA_EXTRATO);
    const m = textoExtrato(itens, cb.offset, temMais);
    await ctx.editMessageText(m.text, { reply_markup: (m.reply_markup ?? { inline_keyboard: [] }) as never });
  });
```

Os comandos `saldo` e `extrato` precisam ser registrados **junto dos demais `bot.command`**, antes do `bot.on("message:text")`. Mova-os para lá se necessário.

- [ ] **Step 4: Trocar o `bot.catch` por um que avisa o usuário**

Substitua a linha do `bot.catch` por:

```ts
  bot.catch(async (err) => {
    console.error("erro no handler:", err.error);
    // O usuário precisa saber que a ação não teve efeito; sem isso ele
    // acha que gravou e não gravou.
    try {
      await err.ctx.reply("⚠️ Não consegui falar com a planilha agora. Tenta de novo em instantes.");
    } catch (e) {
      console.error("falhei até para avisar o usuário:", e);
    }
  });
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `deno test bot_test.ts`
Expected: PASS — 15 testes.

- [ ] **Step 6: Rodar a suíte inteira e o check**

Run: `deno task test && deno task check`
Expected: PASS em ambos.

- [ ] **Step 7: Commit**

```bash
git add bot.ts bot_test.ts
git commit -m "feat(bot): descrição por force_reply, saldo, extrato e navegação"
```

---

### Task 9: `main.ts`, scripts operacionais e README

O servidor HTTP, os dois scripts de setup e a documentação para colocar em pé.

**Files:**
- Create: `main.ts`
- Create: `scripts/set_webhook.ts`
- Create: `scripts/bootstrap_sheet.ts`
- Create: `README.md`
- Test: `main_test.ts`

**Interfaces:**
- Consumes: `criarBot` (Tasks 7–8); `criarAuth`, `lerServiceAccount` (Task 4); `criarSheets` (Task 5); `criarLedger`, `ABA`, `CABECALHO` (Task 6).
- Produces:
  - `lerEnv(nome: string): string`
  - `montarPermitidos(bruto: string): Set<number>`
  - `criarHandler(handleUpdate: (req: Request) => Promise<Response>): (req: Request) => Promise<Response>`

- [ ] **Step 1: Escrever `main_test.ts`**

Os testes cobrem só a parte testável sem rede: leitura de env, parsing da allowlist e a garantia de que o handler nunca devolve status diferente de 200.

```ts
import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
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
  for (const req of [
    new Request("https://x/webhook"),
    new Request("https://x/", { method: "POST" }),
    new Request("https://x/outro", { method: "POST" }),
  ]) {
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
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `deno test main_test.ts`
Expected: FAIL — `Module not found "./main.ts"`

- [ ] **Step 3: Implementar `main.ts`**

```ts
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
```

**Nota sobre `import.meta.main`:** sem essa guarda, importar `main.ts` no teste tentaria ler as variáveis de ambiente e subir um servidor.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `deno test main_test.ts`
Expected: PASS — 5 testes.

- [ ] **Step 5: Criar `scripts/set_webhook.ts`**

```ts
const token = Deno.env.get("BOT_TOKEN");
const publicUrl = Deno.env.get("PUBLIC_URL");
const secret = Deno.env.get("WEBHOOK_SECRET");

if (!token || !publicUrl || !secret) {
  console.error("defina BOT_TOKEN, PUBLIC_URL e WEBHOOK_SECRET");
  Deno.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: `${publicUrl.replace(/\/$/, "")}/webhook`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  }),
});

console.log(await res.json());

const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
console.log(await info.json());
```

- [ ] **Step 6: Criar `scripts/bootstrap_sheet.ts`**

```ts
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
```

- [ ] **Step 7: Rodar `bootstrap_sheet` contra a planilha real**

Pré-requisitos, nesta ordem:
1. Planilha criada, com uma aba renomeada para exatamente `Lançamentos`.
2. Planilha compartilhada com o `client_email` da service account, como **Editor**.
3. `.env` preenchido a partir do `.env.example`.

Run: `deno task bootstrap-sheet`
Expected: imprime o cabeçalho gravado. Se der `Sheets 403`, o passo 2 não foi feito.

- [ ] **Step 8: Escrever o `README.md`**

````markdown
# denobot

Bot de Telegram para controle de entradas e saídas numa planilha do Google Sheets.
Roda stateless em Deno: sem banco de dados, sem sessão — o estado de conversa
viaja no `callback_data` dos botões e no `reply_to_message` das respostas.

## Como se usa

Mande um valor para o bot:

```
você:  50
bot:   R$ 50,00 — entrada ou saída?
       [ ⬇️ Entrada ]  [ ⬆️ Saída ]
você:  (toca Saída)
bot:   ✅ Saída de R$ 50,00 · 04/09 · Bruno
       [ ✏️ Qual foi o gasto? ]
       [ 📤 Compartilhar ]
```

O botão **Compartilhar** abre o WhatsApp com o texto pronto; você escolhe o grupo
e confirma.

Formatos de valor aceitos: `50` · `50,90` · `50.90` · `1.234,56` · `1,234.56` ·
`R$ 12,30`. Um separador com três dígitos depois é lido como milhar
(`1.234` = mil duzentos e trinta e quatro). O bot sempre ecoa a interpretação
antes de gravar.

Comandos: `/saldo` (mês corrente + acumulado) e `/extrato` (últimos 10).

## Configuração

1. `@BotFather` → criar o bot, guardar o token.
2. Google Cloud → habilitar a **Google Sheets API**, criar uma service account,
   baixar a chave JSON.
3. Criar a planilha, renomear a aba para `Lançamentos`, e **compartilhá-la com o
   `client_email` da service account como Editor**. Sem isso, tudo responde 403.
4. `cp .env.example .env` e preencher.
5. `deno task bootstrap-sheet` → grava o cabeçalho.
6. `deno task dev` + um túnel (`cloudflared tunnel --url http://localhost:8000`).
7. `PUBLIC_URL=<url do túnel> deno task set-webhook`.

## Deploy

Deno Deploy, com as variáveis de ambiente pelo dashboard. Depois do deploy,
rode `set-webhook` apontando para a URL de produção.

Para depurar entrega de update, olhe `last_error_message` em `getWebhookInfo` —
o `set-webhook` já imprime isso.

## Desenvolvimento

```
deno task test    # suíte completa, sem rede
deno task check   # type-check, lint e fmt
```

Documentos: [design](docs/superpowers/specs/2026-09-04-bot-financeiro-telegram-design.md)
e [plano de implementação](docs/superpowers/plans/2026-09-04-bot-financeiro-telegram.md).
````

- [ ] **Step 9: Rodar a suíte inteira e o check**

Run: `deno task test && deno task check`
Expected: PASS em ambos.

- [ ] **Step 10: Teste manual ponta a ponta**

Com o bot no ar e o webhook registrado, verifique na ordem:

1. Mandar `50` → aparecem os botões com `R$ 50,00`.
2. Tocar `Saída` → mensagem editada para confirmação; **conferir na planilha** que a coluna C ficou como número (alinhado à direita), não texto.
3. Tocar `✏️` e responder `mercado` → coluna D preenchida na mesma linha.
4. Tocar `📤 Compartilhar` → o WhatsApp abre com o texto correto, acentos inclusos.
5. Mandar `50,5555` → mensagem de erro com o campo de digitação reaberto.
6. Mandar `bom dia` → só a dica de uso.
7. `/saldo` e `/extrato` → conferir os números contra a planilha.
8. Mandar `50` de outra conta, fora da allowlist → nenhuma resposta.

- [ ] **Step 11: Commit**

```bash
git add main.ts main_test.ts scripts/set_webhook.ts scripts/bootstrap_sheet.ts README.md
git commit -m "feat(main): servidor de webhook, scripts de setup e readme"
```

---

## Verificação final

Ao terminar a Task 9, confirme com evidência:

- [ ] `deno task test` — toda a suíte passa, nos 9 arquivos de teste
- [ ] `deno task check` — type-check, lint e fmt limpos
- [ ] Roteiro manual do Step 10 da Task 9 executado ponta a ponta
- [ ] Coluna C da planilha contém **números**, não texto (o sintoma de erro de locale)
- [ ] `getWebhookInfo` sem `last_error_message`

## Cobertura do spec

| Seção do spec | Onde é implementada |
|---|---|
| §2 D1 webhook, sempre 200 | Task 9 (`criarHandler`) |
| §2 D2 grammY | Tasks 7–8 |
| §2 D3 service account | Task 4 |
| §2 D4 WhatsApp por link | Task 3 (`linkWhatsApp`) |
| §2 D5 planilha como fonte única | Task 6 |
| §3 módulos | Tasks 1–9 |
| §4 modelo de dados e idempotência | Task 6 (`registrar`), Task 9 (`bootstrap_sheet`) |
| §4 valor como número, data ISO | Task 5 (`append`), Task 6 |
| §5 parsing e classificação | Task 1, Task 7 |
| §6.1 registrar | Task 7 |
| §6.2 descrição opcional | Task 8 |
| §6.3 saldo | Tasks 6, 8 |
| §6.4 extrato | Tasks 6, 8 |
| §6.5 valor não reconhecido | Task 1, Task 3, Task 7 |
| §7 callback_data | Task 2 |
| §8 erros | Tasks 5, 6, 8, 9 |
| §9 segurança | Task 7 (allowlist), Task 9 (secret token, path) |
| §10 configuração | Tasks 1, 9 |
| §11 testes | todas |
| §12 deploy | Task 9 |
