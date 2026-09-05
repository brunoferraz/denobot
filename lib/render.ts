import { type ErroValor, formatarBRL } from "./money.ts";
import type { Lancamento, Saldo, TipoLancamento } from "./types.ts";
import { encodeCallback } from "./callback.ts";
import { ddMM, mesAnterior, mesPorExtenso, mesSeguinte } from "./tempo.ts";

export interface Mensagem {
  text: string;
  reply_markup?: unknown;
}

export const PAGINA_EXTRATO = 10;

/**
 * Limites de caracteres para textos de entrada livre do usuário (descrição e
 * nome de exibição do Telegram) embutidos em mensagens e na URL do WhatsApp.
 * Sem isso, um valor longo pode estourar o limite de 4096 caracteres do
 * `sendMessage` do Telegram — e, pior, uma vez gravado na planilha,
 * quebraria permanentemente qualquer página de `/extrato` que o incluísse.
 * Truncar aqui repara também as linhas que já existem na planilha.
 */
export const MAX_DESCRICAO = 80;
export const MAX_QUEM = 32;
/**
 * O eco de `erroValor` existe só para mostrar o que o bot leu; 40 chars
 * bastam para reconhecer a própria entrada.
 */
export const MAX_ENTRADA_ECO = 40;

function truncar(texto: string, max: number): string {
  // Itera por code point (não por unidade UTF-16) para nunca partir um
  // emoji ao meio — um surrogate solto quebraria encodeURIComponent.
  const pontos = Array.from(texto);
  return pontos.length > max ? `${pontos.slice(0, max).join("")}…` : texto;
}

const SETA: Record<Lancamento["tipo"], string> = { Entrada: "⬇️", Saída: "⬆️" };

export function perguntaTipo(centavos: number): Mensagem {
  return {
    text: `R$ ${formatarBRL(centavos)} — entrada ou saída?`,
    reply_markup: {
      inline_keyboard: [[
        {
          text: "⬇️ Entrada",
          callback_data: encodeCallback({ tipo: "n", lancamento: "Entrada", centavos }),
        },
        {
          text: "⬆️ Saída",
          callback_data: encodeCallback({ tipo: "n", lancamento: "Saída", centavos }),
        },
      ]],
    },
  };
}

/** Texto enviado ao WhatsApp; também é a base da mensagem de confirmação. */
function resumo(l: Lancamento): string {
  const desc = l.descricao ? ` · ${truncar(l.descricao, MAX_DESCRICAO)}` : "";
  return `${l.tipo} de R$ ${formatarBRL(l.centavos)}${desc} · ${ddMM(l.data)} · ${
    truncar(l.quem, MAX_QUEM)
  }`;
}

export function linkWhatsApp(l: Lancamento): string {
  return `https://wa.me/?text=${encodeURIComponent(resumo(l))}`;
}

export function confirmacao(l: Lancamento, linha: number): Mensagem {
  const teclado: Array<Array<Record<string, string>>> = [];
  if (!l.descricao) {
    teclado.push([{
      text: l.tipo === "Entrada" ? "✏️ Qual a fonte?" : "✏️ Qual foi o gasto?",
      callback_data: encodeCallback({ tipo: "d", linha, lancamento: l.tipo }),
    }]);
  }
  teclado.push([{ text: "📤 Compartilhar", url: linkWhatsApp(l) }]);
  return { text: `✅ ${resumo(l)}`, reply_markup: { inline_keyboard: teclado } };
}

/** Uma pergunta por tipo: dinheiro que sai teve um gasto, dinheiro que entra teve uma fonte. */
const PERGUNTAS = {
  Entrada: { frase: "Qual a fonte do dinheiro?", exemplo: "ex.: salário" },
  Saída: { frase: "Qual foi o gasto?", exemplo: "ex.: mercado" },
} as const;

/**
 * Reconhece as duas perguntas, e SÓ elas, da primeira à última letra. A âncora
 * é o que impede que um nome de exibição terminado em "#2" — texto controlado
 * pelo usuário, que o `resumo` interpola no fim da linha — seja lido como um
 * marcador e escreva a descrição na linha errada.
 */
const MARCADOR = new RegExp(
  `^(?:${Object.values(PERGUNTAS).map((p) => p.frase.replace("?", "\\?")).join("|")}) #(\\d+)$`,
);

export function perguntaDescricao(linha: number, tipo?: TipoLancamento): Mensagem {
  const { frase, exemplo } = PERGUNTAS[tipo ?? "Saída"];
  return {
    text: `${frase} #${linha}`,
    reply_markup: {
      force_reply: true,
      input_field_placeholder: exemplo,
    },
  };
}

/** Recupera o número da linha embutido em "Qual foi o gasto? #42" e congêneres. */
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
      `❌ "${truncar(entrada, MAX_ENTRADA_ECO)}" — ${MOTIVOS[erro]}`,
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
    {
      text: `◀️ ${mesPorExtenso(mesAnterior(s.mes)).split("/")[0]}`,
      callback_data: encodeCallback({ tipo: "m", mes: mesAnterior(s.mes) }),
    },
    {
      text: `${mesPorExtenso(mesSeguinte(s.mes)).split("/")[0]} ▶️`,
      callback_data: encodeCallback({ tipo: "m", mes: mesSeguinte(s.mes) }),
    },
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
  const linhas = ls.slice(0, PAGINA_EXTRATO).map((l) =>
    `${ddMM(l.data)}  ${SETA[l.tipo]} ${formatarBRL(l.centavos).padStart(10)}  ${
      l.descricao ? truncar(l.descricao, MAX_DESCRICAO) : "—"
    }  ·  ${truncar(l.quem, MAX_QUEM)}`
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
