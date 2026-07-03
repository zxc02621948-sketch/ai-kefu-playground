// kefu-gate — Turnstile 驗證門口（開場驗一次，之後免驗）
//
// 規則：
//   A) action:'unlock' — 前端一載入就驗一次 Turnstile；通過就把 session 記進 KV，
//      之後選場景/連發/輪詢全部免票（避免「點太快票還沒好」被擋）。
//   B) action:'poll'   — 輪詢「回覆好了沒」，不花 AI，直接放行。
//   C) action:'send'   — session 已驗過(KV) 就放行；否則若帶有效 token 也驗一次並記住。
//
// 綁定：env.TURNSTILE_SECRET（原本就有）、env.SESS（KV Namespace，變數名 SESS）

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

async function turnstilePass(env, request, token) {
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET || '',
      response: token || '',
      remoteip: request.headers.get('CF-Connecting-IP') || '',
    }),
  });
  const o = await r.json().catch(() => ({ success: false }));
  return !!o.success;
}

async function trust(env, sid) {
  if (env.SESS && sid) {
    try { await env.SESS.put('ok:' + sid, '1', { expirationTtl: SESSION_TTL }); } catch (e) {}
  }
}

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

    const sid = String(body.session_id || '');

    // A) 開場驗證：前端一載入就驗一次，通過即記住 session
    if (body.action === 'unlock') {
      if (!(await turnstilePass(env, request, body.cf_token))) return json({ ok: false });
      await trust(env, sid);
      return json({ ok: true });
    }
    // B) 輪詢：直接放行
    if (body.action === 'poll') return forwardToN8n(body);
    // C) 已驗過（KV）→ 放行（支援連發）
    if (env.SESS && sid && await env.SESS.get('ok:' + sid)) return forwardToN8n(body);
    // D) 沒驗過但帶了有效 token → 驗、記住、放行
    if (body.cf_token && await turnstilePass(env, request, body.cf_token)) {
      await trust(env, sid);
      return forwardToN8n(body);
    }
    // E) 都沒有 → 擋
    return json({ reply: '安全驗證沒通過，請重新整理頁面再試一次 🙏' });
  },
};
