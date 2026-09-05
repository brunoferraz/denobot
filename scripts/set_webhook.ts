const token = Deno.env.get("BOT_TOKEN");
const publicUrl = Deno.env.get("PUBLIC_URL");
const secret = Deno.env.get("WEBHOOK_SECRET");

if (!token || !publicUrl || !secret) {
  console.error("defina BOT_TOKEN, PUBLIC_URL e WEBHOOK_SECRET");
  Deno.exit(1);
}

/**
 * A mensagem de erro do fetch do Deno inclui a URL inteira da requisição —
 * e a URL da API do Telegram carrega o BOT_TOKEN. Sem esse catch, uma falha
 * de rede (DNS, TLS) imprimiria o token em texto puro no terminal ou num
 * log de CI.
 */
const chamarTelegram = async (caminho: string, init?: RequestInit): Promise<unknown> => {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${caminho}`, init);
    return await res.json();
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    console.error(`falha de rede ao chamar ${caminho}: ${mensagem.replaceAll(token, "***")}`);
    Deno.exit(1);
  }
};

console.log(
  await chamarTelegram("setWebhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${publicUrl.replace(/\/$/, "")}/webhook`,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  }),
);

console.log(await chamarTelegram("getWebhookInfo"));
