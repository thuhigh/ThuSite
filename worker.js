// ThuSite Cloudflare Worker
//  ?user=a | ?users=a,b (so sánh) | ?tag=fyp (hashtag)   — giới hạn 1 lượt / 3 phút / IP
const H = { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0" } };
const CORS = { "access-control-allow-origin": "*", "content-type": "application/json; charset=utf-8" };
const json = (o, status = 200, x = {}) => new Response(JSON.stringify(o), { status, headers: { ...CORS, ...x } });
const get = async (u) => { try { const r = await fetch(u, H); return r.ok ? await r.text() : null; } catch { return null; } };
const ID = "__UNIVERSAL_DATA_FOR_REHYDRATION__";
const sj = (h) => {
  const m = h && h.match(new RegExp('<script[^>]*id="' + ID + '"[^>]*>([\\s\\S]*?)</script>'));
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
};
const img64 = async (u) => {
  try {
    const r = await fetch(u, H); if (!r.ok) return null;
    const b = new Uint8Array(await r.arrayBuffer()); let s = "";
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
    return "data:" + (r.headers.get("content-type") || "image/jpeg").split(";")[0] + ";base64," + btoa(s);
  } catch { return null; }
};

async function channel(user, env) {
  const [ph, eh] = await Promise.all([get("https://www.tiktok.com/@" + user), get("https://www.tiktok.com/embed/@" + user)]);
  let profile = null;
  try {
    const u = sj(ph)["__DEFAULT_SCOPE__"]["webapp.user-detail"].userInfo;
    profile = { nickname: u.user.nickname, followers: +u.stats.followerCount, following: +(u.stats.followingCount || 0),
      likes: +u.stats.heartCount, avatar: await img64(u.user.avatarMedium || u.user.avatarThumb) };
  } catch {}
  const ids = [...new Set([...(eh || "").matchAll(new RegExp("@" + user.replace(/\./g, "\\.") + "/video/(\\d{18,20})", "gi"))].map((m) => m[1]))]
    .sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1)).slice(0, 8);
  const videos = (await Promise.all(ids.map(async (id) => {
    try {
      const it = sj(await get(`https://www.tiktok.com/@${user}/video/${id}`))["__DEFAULT_SCOPE__"]["webapp.video-detail"].itemInfo.itemStruct;
      return { id, views: +it.stats.playCount, likes: +it.stats.diggCount, time: +(it.createTime || Number(BigInt(id) >> 32n)),
        cover: (it.video && (it.video.cover || it.video.originCover)) || null, url: `https://www.tiktok.com/@${user}/video/${id}` };
    } catch { return null; }
  }))).filter(Boolean);
  if (!profile && !videos.length) return null;
  const v = videos.map((x) => x.views).sort((a, b) => a - b), n = v.length;
  const med = n ? Math.round(n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : null;
  const usd = med == null ? null : Math.round((med / 1000) * 10);
  return { username: user, updated: new Date().toISOString(), profile, videos, medianViews: med, estUsd: usd,
    estVnd: usd == null ? null : Math.round(usd * (+env.USD_VND || 26000)) };
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "access-control-allow-methods": "GET", "access-control-allow-headers": "*" } });
    const q = new URL(req.url).searchParams;
    if (q.get("visit")) { // ?visit=1[&hit=1][&new=1] : bộ đếm lượt ghé thăm (cần KV tên VISITS)
      const kv = env.VISITS;
      if (!kv) return json({ error: "no_kv" }, 501);
      const day = "d:" + new Date().toISOString().slice(0, 10);
      let [t, u, d] = (await Promise.all([kv.get("total"), kv.get("unique"), kv.get(day)])).map((x) => +x || 0);
      try {
        if (q.get("hit")) { t++; d++; await Promise.all([kv.put("total", String(t)), kv.put(day, String(d), { expirationTtl: 5184000 })]); }
        if (q.get("new")) { u++; await kv.put("unique", String(u)); }
      } catch {}
      return json({ total: t, unique: u, today: d }, 200, { "cache-control": "no-store" });
    }
    const tag = (q.get("tag") || "").replace(/^#/, "").toLowerCase();
    const users = (q.get("users") || q.get("user") || "").split(",").map((x) => x.trim().replace(/^@/, "").toLowerCase()).filter(Boolean).slice(0, 2);
    if (tag ? !/^[\p{L}\p{N}_]{1,40}$/u.test(tag) : !users.length || users.some((u) => !/^[\w.]{2,24}$/.test(u)))
      return json({ error: "bad_request" }, 400);

    // giới hạn 3 phút / IP (Cache API, theo từng trung tâm dữ liệu)
    const c = caches.default, ip = req.headers.get("cf-connecting-ip") || "x", rk = new Request("https://rl.local/" + ip);
    const hit = await c.match(rk);
    if (hit) { const until = +(await hit.text()) || 0; return json({ error: "rate_limited", retryAfter: Math.max(1, Math.ceil((until - Date.now()) / 1000)) }, 429); }
    await c.put(rk, new Response(String(Date.now() + 180000), { headers: { "cache-control": "max-age=180" } }));

    const ck = new Request("https://cache.local/" + (tag ? "tag/" + tag : users.join(","))), cached = await c.match(ck);
    if (cached) return cached;
    let body;
    if (tag) {
      let ci = null;
      try { ci = sj(await get("https://www.tiktok.com/tag/" + encodeURIComponent(tag)))["__DEFAULT_SCOPE__"]["webapp.challenge-detail"].challengeInfo; } catch {}
      if (!ci) return json({ error: "not_found" }, 404);
      body = { tag, title: ci.challenge.title, desc: ci.challenge.desc || "", videoCount: +ci.stats.videoCount || 0, viewCount: +ci.stats.viewCount || 0 };
    } else {
      const rs = await Promise.all(users.map((u) => channel(u, env)));
      if (rs.some((r) => !r)) return json({ error: "not_found" }, 404);
      body = users.length > 1 ? { channels: rs } : rs[0];
    }
    const res = json(body, 200, { "cache-control": "public, max-age=180" });
    ctx.waitUntil(c.put(ck, res.clone()));
    return res;
  },
};
