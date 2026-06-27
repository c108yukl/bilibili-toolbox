"""
B站 弹幕+评论(+回复) 爬取工具
依赖: pip install bilibili-api-python aiohttp

用法:
  python bilibili_demo.py BV1cmofByENF -dc --all --replies --save json
  python bilibili_demo.py BV1cmofByENF -c --all --replies --cookie "SESSDATA=xxx"
  python bilibili_demo.py BV1cmofByENF -d
"""
import asyncio, sys, io, json, csv, time, hashlib, argparse
from datetime import datetime
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from bilibili_api import video, comment, Credential
from bilibili_api.ass import request_subtitle_languages

CACHE_DIR = Path(__file__).parent / ".bili_cache"
CACHE_DIR.mkdir(exist_ok=True)

# ── 缓存 ──────────────────────────────────────────────

def _cache_key(bvid: str, dtype: str, page: int = 0) -> str:
    return hashlib.md5(f"{bvid}:{dtype}:{page}".encode()).hexdigest()

def _cache_get(key: str, max_age: int):
    path = CACHE_DIR / f"{key}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if time.time() - data.get("_cached_at", 0) > max_age:
        path.unlink()
        return None
    return data.get("payload")

def _cache_set(key: str, payload, max_age: int):
    path = CACHE_DIR / f"{key}.json"
    path.write_text(
        json.dumps({"_cached_at": time.time(), "max_age": max_age, "payload": payload},
                   ensure_ascii=False, indent=2),
        encoding="utf-8")

# ── 保存 ──────────────────────────────────────────────

def _fmt_time(ts: int) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")

def _format_comment(c: dict) -> dict:
    return {
        "like": c["like"], "uname": c["member"]["uname"],
        "time": _fmt_time(c["ctime"]), "text": c["content"]["message"],
        "reply_count": c.get("rcount", 0), "rpid": c["rpid"],
    }

def _format_reply(r: dict) -> dict:
    parent_uname = ""
    if r.get("parent") and r.get("members"):
        parent_uname = r["members"].get(r["parent"], {}).get("uname", "")
    return {
        "like": r["like"], "uname": r["member"]["uname"],
        "time": _fmt_time(r["ctime"]), "text": r["content"]["message"],
        "reply_to": parent_uname, "rpid": r["rpid"],
    }

def save_comments(comments_with_replies: list, bvid: str, fmt: str = "txt"):
    """comments_with_replies: [{"comment": {...}, "replies": [...]}, ...]"""
    title = f"comments_{bvid}"

    if fmt == "json":
        rows = []
        for item in comments_with_replies:
            c = _format_comment(item["comment"])
            c["replies"] = [_format_reply(r) for r in item.get("replies", [])]
            rows.append(c)
        out = Path(__file__).parent / f"{title}.json"
        out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    elif fmt == "csv":
        rows = []
        for item in comments_with_replies:
            c = _format_comment(item["comment"])
            rows.append({**c, "level": "comment", "reply_to": ""})
            for r in item.get("replies", []):
                rows.append({**_format_reply(r), "level": "reply",
                             "reply_count": "", "rpid": r["rpid"]})
        out = Path(__file__).parent / f"{title}.csv"
        with out.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=["level", "like", "uname", "time", "text",
                                                "reply_count", "reply_to", "rpid"])
            w.writeheader()
            w.writerows(rows)

    else:  # txt
        lines = []
        for item in comments_with_replies:
            c = item["comment"]
            lines.append(f"[+{c['like']}] {c['member']['uname']}: {c['content']['message']}")
            for r in item.get("replies", []):
                lines.append(f"  \u21b3[+{r['like']}] {r['member']['uname']}: {r['content']['message']}")
        out = Path(__file__).parent / f"{title}.txt"
        out.write_text("\n".join(lines), encoding="utf-8")

    total_c = len(comments_with_replies)
    total_r = sum(len(item.get("replies", [])) for item in comments_with_replies)
    print(f"   -> 已保存 {out.name}  (评论{total_c}, 回复{total_r})")

def save_danmaku(dms: list, bvid: str, fmt: str = "txt"):
    title = f"danmaku_{bvid}"
    out = Path(__file__).parent / f"{title}.{fmt}"
    if fmt == "json":
        rows = [{"time_s": round(d.dm_time, 1), "text": d.text,
                  "mode": d.mode, "font_size": d.font_size,
                  "color": d.color, "uid": d.uid} for d in dms]
        out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    elif fmt == "csv":
        with out.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=["time_s", "text", "mode", "font_size", "color", "uid"])
            w.writeheader()
            w.writerows([{"time_s": round(d.dm_time, 1), "text": d.text,
                          "mode": d.mode, "font_size": d.font_size,
                          "color": d.color, "uid": d.uid} for d in dms])
    else:
        out.write_text("\n".join(f"[{d.dm_time:7.1f}s] {d.text}" for d in dms), encoding="utf-8")
    print(f"   -> 已保存 {out.name}  ({len(dms)} 条)")

# ── 弹幕 ──────────────────────────────────────────────

async def get_danmaku(bvid: str, page_index: int = 0, max_age: int = 30,
                      credential: Credential = None, save_fmt: str = None):
    key = _cache_key(bvid, "danmaku", page_index)
    cached = _cache_get(key, max_age)
    if cached is not None:
        print(f"[弹幕] 缓存命中 (max_age={max_age}s)")
        return cached

    v = video.Video(bvid=bvid, credential=credential)
    info = await v.get_info()
    title = info["title"]
    cid = info["pages"][page_index]["cid"]
    print(f"[视频] {title}  (cid={cid})")

    dms = await v.get_danmakus(page_index=page_index)
    print(f"[弹幕] 共 {len(dms)} 条")
    for dm in dms[:10]:
        print(f"   [{dm.dm_time:7.1f}s] {dm.text}")

    data = [{"time": d.dm_time, "text": d.text, "mode": d.mode,
             "font_size": d.font_size, "color": d.color, "uid": d.uid} for d in dms]
    _cache_set(key, data, max_age)
    if save_fmt:
        save_danmaku(dms, bvid, save_fmt)
    return dms

# ── 评论 ──────────────────────────────────────────────

async def _fetch_one_page(aid: int, page: int, credential: Credential = None):
    resp = await comment.get_comments(
        oid=aid,
        type_=comment.CommentResourceType.VIDEO,
        page_index=page,
        order=comment.OrderType.LIKE,
        credential=credential,
    )
    replies = resp.get("replies") or []
    total = resp.get("page", {}).get("acount", 0) or 0
    return replies, total

async def _fetch_replies(aid: int, rpid: int, credential: Credential = None):
    """获取单条评论的楼中楼回复 (第1页, 最多20条)"""
    try:
        sub = await comment.Comment(
            oid=aid,
            type_=comment.CommentResourceType.VIDEO,
            rpid=rpid,
            credential=credential,
        ).get_sub_comments(page_index=1, page_size=20)
        return sub.get("data", {}).get("replies") or sub.get("replies") or []
    except Exception as e:
        print(f"   [!] 回复获取失败 rpid={rpid}: {e}")
        return []

async def get_comments(bvid: str, page: int = 1, max_age: int = 30,
                       credential: Credential = None, save_fmt: str = None,
                       with_replies: bool = False):
    key = _cache_key(bvid, f"comments_p{page}_r{int(with_replies)}", 0)
    cached = _cache_get(key, max_age)
    if cached is not None:
        print(f"[评论] 缓存命中")
        return cached

    v = video.Video(bvid=bvid, credential=credential)
    info = await v.get_info()
    aid = info["aid"]

    replies, total = await _fetch_one_page(aid, page, credential)
    print(f"[评论] aid={aid} 第{page}页, 返回 {len(replies)} 条 (总计约 {total})")

    result = []
    for i, c in enumerate(replies):
        entry = {"comment": c, "replies": []}
        if with_replies and c.get("rcount", 0) > 0:
            entry["replies"] = await _fetch_replies(aid, c["rpid"], credential)
            await asyncio.sleep(0.3)
        result.append(entry)
        print(f"   +{c['like']} {c['content']['message'][:60]}" +
              (f"  ({len(entry['replies'])}条回复)" if entry["replies"] else ""))

    _cache_set(key, result, max_age)
    if save_fmt:
        save_comments(result, bvid, save_fmt)
    return result

async def get_all_comments(bvid: str, max_age: int = 30,
                           credential: Credential = None, save_fmt: str = None,
                           with_replies: bool = False,
                           max_pages: int = 0):
    v = video.Video(bvid=bvid, credential=credential)
    info = await v.get_info()
    aid = info["aid"]
    title = info["title"]
    pages_info = f" 目标{max_pages}页" if max_pages > 0 else " 全量"
    print(f"[视频] {title}  (aid={aid}){pages_info}" + ("  [含回复]" if with_replies else ""))

    all_items = []
    page = 1
    empty_streak = 0
    known_total = 0

    while True:
        if max_pages > 0 and page > max_pages:
            print(f"  已达目标页数 {max_pages}，停止")
            break
        replies, total = await _fetch_one_page(aid, page, credential)
        if total:
            known_total = total
        if not replies:
            empty_streak += 1
        else:
            empty_streak = 0
            for c in replies:
                entry = {"comment": c, "replies": []}
                if with_replies and c.get("rcount", 0) > 0:
                    entry["replies"] = await _fetch_replies(aid, c["rpid"], credential)
                    await asyncio.sleep(0.3)
                all_items.append(entry)
            r_count = sum(len(e["replies"]) for e in all_items[-len(replies):])
            print(f"  第{page}页 +{len(replies)} 评论 / +{r_count} 回复 (累计 {len(all_items)} / {known_total or '?'})")

        if empty_streak >= 2:
            print(f"  连续{empty_streak}页无数据, 停止")
            break
        if known_total and len(all_items) >= known_total:
            break
        if len(all_items) > 10000:
            print("  达到安全上限, 停止")
            break
        page += 1
        await asyncio.sleep(0.5)

    total_r = sum(len(e["replies"]) for e in all_items)
    print(f"\n[评论] 全量完成: {len(all_items)} 评论, {total_r} 回复")
    for item in all_items[:2]:
        c = item["comment"]
        print(f"   +{c['like']} {c['content']['message'][:60]}")
        for r in item.get("replies", [])[:1]:
            print(f"     \u21b3 {r['member']['uname']}: {r['content']['message'][:50]}")

    if save_fmt:
        save_comments(all_items, bvid, save_fmt)
    return all_items

# ── 字幕 ──────────────────────────────────────────────

SUBTITLE_LAN_MAP = {
    "ai-zh": "中文（AI自动生成）",
    "zh-Hans": "中文（简体）",
    "zh-Hant": "中文（繁体）",
    "en": "英语",
    "ja": "日语",
    "ko": "韩语",
}

def save_subtitle(sub_obj, bvid: str, lan_code: str, fmt: str = "srt"):
    title = f"subtitle_{bvid}_{lan_code}"
    out = Path(__file__).parent / f"{title}.{fmt}"
    if fmt == "ass":
        text = sub_obj.to_ass()
    elif fmt == "lrc":
        text = sub_obj.to_lrc()
    elif fmt == "json":
        data = sub_obj.to_simple_json()
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"   -> 已保存 {out.name}  ({len(data)} 条字幕)")
        return
    else:
        text = sub_obj.to_srt()
    out.write_text(text, encoding="utf-8")
    count = text.count("\n\n")
    print(f"   -> 已保存 {out.name}  ({count} 条字幕)")

async def get_subtitle(bvid: str, page_index: int = 0,
                       credential: Credential = None,
                       lan_code: str = "", save_fmt: str = "srt"):
    v = video.Video(bvid=bvid, credential=credential)
    info = await v.get_info()
    cid = info["pages"][page_index]["cid"]
    print(f"[视频] {info['title']}  (cid={cid})")

    sub_obj = await request_subtitle_languages(obj=v, page_index=page_index,
                                                credential=credential)
    codes, docs = sub_obj.get_lan_list()
    if not codes:
        print("[字幕] 该视频没有字幕")
        return None

    print(f"[字幕] 可用语言: {dict(zip(docs, codes))}")

    # 用户指定语言 → 优先匹配 code；fallback 匹配 doc 关键词
    if lan_code:
        matched = lan_code if lan_code in codes else ""
        if not matched:
            for doc, code in zip(docs, codes):
                if lan_code.lower() in doc.lower() or lan_code.lower() in code.lower():
                    matched = code
                    break
        if not matched:
            print(f"[字幕] 未找到匹配语言 '{lan_code}'，使用第一个")
            lan_code = codes[0]
    else:
        # 默认优先中文
        prefer = ["ai-zh", "zh-Hans", "zh-Hant"]
        lan_code = next((c for c in codes if c in prefer), codes[0])

    lan_doc = SUBTITLE_LAN_MAP.get(lan_code, lan_code)
    print(f"[字幕] 正在获取 {lan_doc} ({lan_code})...")
    await sub_obj.request_ass_data_json(lan_set=lan_code)

    if save_fmt:
        save_subtitle(sub_obj, bvid, lan_code, save_fmt)

    return sub_obj

# ── Cookie ────────────────────────────────────────────

def parse_cookie(cookie_str: str) -> Credential | None:
    if not cookie_str:
        return None
    parts = {}
    for item in cookie_str.split(";"):
        if "=" in item:
            k, v = item.strip().split("=", 1)
            parts[k] = v
    sess = parts.get("SESSDATA", "")
    if not sess:
        return None
    print("[登录] 已加载Cookie凭证")
    return Credential(
        sessdata=sess,
        bili_jct=parts.get("bili_jct", ""),
        buvid3=parts.get("buvid3", ""),
        dedeuserid=parts.get("DedeUserID", ""),
    )

# ── CLI ───────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="B站 弹幕+评论(+回复) 爬取工具",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog="""示例:
  python bilibili_demo.py BV1cmofByENF -dc --all --replies --save json
  python bilibili_demo.py BV1cmofByENF -c --all --replies --cookie "SESSDATA=xxx"
  python bilibili_demo.py BV1cmofByENF -d --save csv
  python bilibili_demo.py BV1cmofByENF --save txt
  python bilibili_demo.py BV1cmofByENF -s --sub-lan en --save srt
  python bilibili_demo.py BV1cmofByENF -s --save ass
                        """)
    p.add_argument("bvid", help="视频BV号 / 完整B站URL")
    p.add_argument("-d", "--danmaku", action="store_true", help="获取弹幕")
    p.add_argument("-c", "--comments", action="store_true", help="获取评论")
    p.add_argument("-dc", action="store_true", dest="both", help="弹幕+评论")
    p.add_argument("-s", "--subtitle", action="store_true", dest="subtitle",
                   help="获取字幕")
    p.add_argument("--sub-lan", default="",
                   help="字幕语言代码 (如 ai-zh, en, ja; 默认自动选择)")
    p.add_argument("--all", action="store_true", dest="all_pages",
                   help="全量翻页评论")
    p.add_argument("--replies", action="store_true",
                   help="同时提取评论的回复(楼中楼)")
    p.add_argument("--page", type=int, default=1, help="评论起始页码 (默认1)")
    p.add_argument("--max-pages", type=int, default=0,
                   help="目标页数, 0=全部 (默认0)")
    p.add_argument("--max-age", type=int, default=30,
                   help="缓存有效期秒, 0=禁用 (默认30)")
    p.add_argument("--save", choices=["txt", "json", "csv", "srt", "ass", "lrc"], default=None,
                   help="保存到文件 (字幕支持 srt/ass/lrc/json)")
    p.add_argument("--cookie", default="", help="Cookie (含SESSDATA)")
    p.add_argument("--danmaku-only", action="store_true", dest="dm_only")
    p.add_argument("--comments-only", action="store_true", dest="cm_only")
    return p.parse_args()

def extract_bvid(raw: str) -> str:
    raw = raw.strip().rstrip("/")
    if "bilibili.com/video/" in raw or "b23.tv" in raw:
        import re
        m = re.search(r"(BV[a-zA-Z0-9]+)", raw)
        if m:
            return m.group(1)
    if raw.startswith("BV"):
        return raw
    raise ValueError(f"无法解析BV号: {raw}")

async def main():
    args = parse_args()
    bvid = extract_bvid(args.bvid)
    credential = parse_cookie(args.cookie)
    max_age = args.max_age if args.max_age > 0 else 0

    do_danmaku = args.danmaku or args.both or args.dm_only or (
        not args.cm_only and not args.comments and not args.subtitle and not args.all_pages)
    do_comments = args.comments or args.both or args.cm_only or (
        not args.dm_only and not args.danmaku and not args.subtitle and not args.all_pages)
    do_subtitle = args.subtitle or (
        not args.danmaku and not args.comments and not args.both
        and not args.dm_only and not args.cm_only and not args.all_pages)

    if do_danmaku:
        await get_danmaku(bvid, max_age=max_age, credential=credential,
                          save_fmt=args.save)

    if do_subtitle:
        await get_subtitle(bvid, page_index=0, credential=credential,
                           lan_code=args.sub_lan, save_fmt=args.save or "srt")

    if do_comments:
        if args.all_pages or args.max_pages:
            await get_all_comments(bvid, max_age=max_age,
                                    credential=credential, save_fmt=args.save,
                                    with_replies=args.replies,
                                    max_pages=args.max_pages)
        else:
            await get_comments(bvid, page=args.page, max_age=max_age,
                               credential=credential, save_fmt=args.save,
                               with_replies=args.replies)

    if max_age > 0:
        print(f"\n[缓存] {CACHE_DIR}")

if __name__ == "__main__":
    asyncio.run(main())
