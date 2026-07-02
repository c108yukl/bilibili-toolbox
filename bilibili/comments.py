"""
评论抓取模块
"""

import asyncio

from bilibili_api import video, comment, Credential

from bilibili.cache import cache_key, cache_get, cache_set
from bilibili.formatters import save_comments


async def _fetch_one_page(aid: int, page: int, credential: Credential = None):
    """获取评论单页"""
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


async def get_comments(
    bvid: str,
    page: int = 1,
    max_age: int = 30,
    credential: Credential = None,
    save_fmt: str = None,
    with_replies: bool = False,
):
    """
    获取单页评论

    Args:
        bvid: 视频BV号
        page: 页码
        max_age: 缓存有效期（秒）
        credential: 登录凭证
        save_fmt: 保存格式
        with_replies: 是否获取楼中楼回复
    """
    key = cache_key(bvid, f"comments_p{page}_r{int(with_replies)}", 0)
    cached = cache_get(key, max_age)
    if cached is not None:
        print("[评论] 缓存命中")
        return cached

    v = video.Video(bvid=bvid, credential=credential)
    info = await v.get_info()
    aid = info["aid"]

    replies, total = await _fetch_one_page(aid, page, credential)
    print(f"[评论] aid={aid} 第{page}页, 返回 {len(replies)} 条 (总计约 {total})")

    result = []
    for c in replies:
        entry = {"comment": c, "replies": []}
        if with_replies and c.get("rcount", 0) > 0:
            entry["replies"] = await _fetch_replies(aid, c["rpid"], credential)
            await asyncio.sleep(0.3)
        result.append(entry)
        print(
            f"   +{c['like']} {c['content']['message'][:60]}"
            + (f"  ({len(entry['replies'])}条回复)" if entry["replies"] else "")
        )

    cache_set(key, result, max_age)
    if save_fmt:
        save_comments(result, bvid, save_fmt)
    return result


async def get_all_comments(
    bvid: str,
    max_age: int = 30,
    credential: Credential = None,
    save_fmt: str = None,
    with_replies: bool = False,
    max_pages: int = 0,
):
    """
    全量翻页获取评论

    Args:
        bvid: 视频BV号
        max_age: 缓存有效期（秒）
        credential: 登录凭证
        save_fmt: 保存格式
        with_replies: 是否获取楼中楼回复
        max_pages: 最大页数，0 = 不限
    """
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
            print(
                f"  第{page}页 +{len(replies)} 评论 / +{r_count} 回复"
                f" (累计 {len(all_items)} / {known_total or '?'})"
            )

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
            print(f"     ↳ {r['member']['uname']}: {r['content']['message'][:50]}")

    if save_fmt:
        save_comments(all_items, bvid, save_fmt)
    return all_items
