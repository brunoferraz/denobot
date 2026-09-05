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
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
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
