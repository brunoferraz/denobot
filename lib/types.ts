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
