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
