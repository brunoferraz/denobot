import { assertEquals } from "@std/assert";
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
