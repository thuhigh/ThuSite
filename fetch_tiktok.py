"""Chạy bởi GitHub Actions / Run by GitHub Actions: ghi data/tiktok.json."""
import asyncio, json, os, re, statistics, time
from datetime import datetime, timezone
import aiohttp

PROXY = os.getenv("TT_PROXY") or None
USD_VND = float(os.getenv("USD_VND", "26000"))
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"}
SEM = asyncio.Semaphore(2)
OUT = "data/tiktok.json"


def script_json(html, sid):
    if not html:
        return None
    m = re.search(rf'<script[^>]*id="{sid}"[^>]*>(.*?)</script>', html, re.S)
    try:
        return json.loads(m[1]) if m else None
    except Exception:
        return None


async def http_get(url):
    try:
        async with aiohttp.ClientSession(headers=HEADERS, timeout=aiohttp.ClientTimeout(total=20)) as s:
            async with s.get(url, proxy=PROXY) as r:
                return await r.text() if r.status == 200 else None
    except Exception:
        return None


async def latest_videos(user, need=8):
    html = await http_get(f"https://www.tiktok.com/embed/@{user}")
    if not html:
        return None
    ids = sorted(set(re.findall(rf"@{re.escape(user)}/video/(\d{{18,20}})", html, re.I)), key=int, reverse=True)

    async def one(vid):
        async with SEM:
            h = await http_get(f"https://www.tiktok.com/@{user}/video/{vid}")
            d = script_json(h, "__UNIVERSAL_DATA_FOR_REHYDRATION__")
            try:
                it = d["__DEFAULT_SCOPE__"]["webapp.video-detail"]["itemInfo"]["itemStruct"]
                st = it["stats"]
                return {"id": vid, "views": int(st.get("playCount", 0)), "likes": int(st.get("diggCount", 0)),
                        "time": int(it.get("createTime", int(vid) >> 32)),
                        "url": f"https://www.tiktok.com/@{user}/video/{vid}"}
            except Exception:
                return None

    return [v for v in await asyncio.gather(*(one(x) for x in ids[:need])) if v] or None


async def profile(user):
    d = script_json(await http_get(f"https://www.tiktok.com/@{user}"), "__UNIVERSAL_DATA_FOR_REHYDRATION__")
    try:
        u = d["__DEFAULT_SCOPE__"]["webapp.user-detail"]["userInfo"]
        return {"nickname": u["user"]["nickname"], "followers": int(u["stats"]["followerCount"]),
                "following": int(u["stats"].get("followingCount", 0)), "likes": int(u["stats"]["heartCount"])}
    except Exception:
        return None


async def one_account(user):
    prof, vids = await asyncio.gather(profile(user), latest_videos(user))
    if not prof and not vids:
        return None
    med = int(statistics.median([v["views"] for v in vids])) if vids else None
    usd = med / 1000 * 10 if med is not None else None
    return {"username": user, "profile": prof, "videos": vids or [], "medianViews": med,
            "estUsd": round(usd) if usd is not None else None,
            "estVnd": round(usd * USD_VND) if usd is not None else None}


async def main():
    users = [l.strip().lstrip("@").lower() for l in open("accounts.txt", encoding="utf-8") if l.strip() and not l.startswith("#")]
    try:
        old = json.load(open(OUT, encoding="utf-8")).get("accounts", {})
    except Exception:
        old = {}
    new = dict(old)  # lỗi thì giữ dữ liệu cũ / keep old data on failure
    for u, r in zip(users, await asyncio.gather(*(one_account(u) for u in users))):
        if r:
            new[u] = r
        else:
            print("failed:", u)
    os.makedirs("data", exist_ok=True)
    json.dump({"updated": datetime.now(timezone.utc).isoformat(), "accounts": new},
              open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

asyncio.run(main())
