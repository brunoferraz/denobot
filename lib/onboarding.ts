/**
 * TEMPORÁRIO — remover quando a família estiver toda cadastrada.
 *
 * Responde a quem não está na ALLOWED_USER_IDS com o próprio ID do Telegram,
 * e avisa o admin. Existe só para o cadastro inicial: sem isso, descobrir o
 * ID de alguém exige um bot de terceiros (@userinfobot) e um copia-e-cola.
 *
 * COMO REMOVER — nenhum passo mexe em lógica:
 *   1. em main.ts, apague DUAS linhas: o `import { criarAvisoDeCadastro }` e
 *      o `aoNegar: criarAvisoDeCadastro(admin)`. As duas juntas: apagar só a
 *      segunda deixa o import órfão e o `deno task check` reprova
 *      (no-unused-vars) — verificado.
 *   2. apague este arquivo e onboarding_test.ts
 *   3. (opcional) apague `aoNegar` de DepsBot e a linha que o chama em bot.ts
 *
 * O passo 1 já restaura o silêncio total do spec §9: `aoNegar` é opcional e o
 * padrão, sem ele, é exatamente o comportamento original. Os passos 2 e 3 são
 * faxina — nada mais os referencia.
 */
import type { Context } from "grammy";

/**
 * O aviso só responde a MENSAGENS DE TEXTO. Toque em botão, mensagem editada
 * e qualquer outro update de quem não tem acesso seguem em silêncio — mantém
 * a superfície pequena, e `/start` já é o primeiro contato natural.
 *
 * Nada aqui pode lançar: este código roda no gate de allowlist, que fica
 * ANTES do wrapper de erro do bot.ts (ordem deliberada, ver comentário lá).
 * Uma exceção aqui escaparia até o criarHandler e viraria um 200 mudo.
 */
export function criarAvisoDeCadastro(admin: number): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    const de = ctx.from;
    if (!de || !ctx.message?.text) return;

    // Deliberadamente seco: não diz o que o bot faz, só devolve o ID.
    try {
      await ctx.reply(
        [
          "Você ainda não tem acesso a este bot.",
          "",
          `Seu ID: ${de.id}`,
          "",
          "Passe esse número para quem administra o bot.",
        ].join("\n"),
      );
    } catch (err) {
      console.error("onboarding: falhei ao responder a quem pediu acesso:", err);
    }

    if (admin === de.id) return;

    const quem = de.username ? `${de.first_name} (@${de.username})` : de.first_name;
    try {
      await ctx.api.sendMessage(admin, `🔑 ${quem} pediu acesso.\nID: ${de.id}`);
    } catch (err) {
      // O admin pode nunca ter aberto conversa com o bot, ou tê-lo bloqueado.
      // Não é motivo para negar ao solicitante a resposta que ele já recebeu.
      console.error("onboarding: falhei ao avisar o admin:", err);
    }
  };
}
