// kefu-gate — Turnstile 驗證門口，過了才轉發給 n8n
//
// 規則：
//   1) action:'poll'（輪詢「回覆好了沒」）→ 不花 AI，直接放行、免驗。
//   2) action:'send'（送訊息）→ 同一個 session 第一次要通過 Turnstile；
//      通過後把 session 記進 KV 一段時間，之後連發免驗（不然連打的第 2、3 則
//      因為 Turnstile 一次只發一個 token 會被擋掉）。
//
// 需要的綁定：
//   - env.TURNSTILE_SECRET  （原本就有）
//   - env.SESS              （新增一個 KV Namespace 綁定，變數名 SESS；設定步驟見 README/對話說明）

const N8N_WEBHOOK = 'https://boss-n8n.zeabur.app/webhook/playground-chat';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SESSION_TTL = 1800; // 通過驗證後，同一 session 免驗 30 分鐘

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// 把（去掉 cf_token 的）body 轉發給 n8n，原樣回傳 n8n 的回應
async function forwardToN8n(body) {
  const { cf_token, ...forward } = body;
  const resp = await fetch(N8N_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(forward),
  });
  const text = await resp.text();
  return new Response(text, { status: resp.status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ reply: '方法不允許' }, 405);

    let body;
    try { body = await request.json(); } catch (e) { return json({ reply: '格式錯誤' }, 400); }

    // 1) 輪詢：只是問「聚合回覆好了沒」，不觸發 AI，直接放行
    if (body.action === 'poll') {
      return forwardToN8n(body);
    }

    const sid = String(body.session_id || '');
    const kv = env.SESS; // KV binding

    // 2) 這個 session 最近已通過驗證 → 免驗放行（支援連發）
    if (kv && sid) {
      const trusted = await kv.get('ok:' + sid);
      if (trusted) return forwardToN8n(body);
    }

    // 3) 否則需要先通過 Turnstile
    const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET || '',
        response: body.cf_token || '',
        remoteip: request.headers.get('CF-Connecting-IP') || '',
      }),
    });
    const outcome = await verify.json().catch(() => ({ success: false }));
    if (!outcome.success) return json({ reply: '安全驗證沒通過，請重新整理頁面再試一次 🙏' }, 200);

    // 通過 → 記住這個 session，之後連發免驗
    if (kv && sid) {
      try { await kv.put('ok:' + sid, '1', { expirationTtl: SESSION_TTL }); } catch (e) {}
    }
    return forwardToN8n(body);
  },
};
