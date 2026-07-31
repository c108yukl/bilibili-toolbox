"""
评论抓取模块

结构:
    get_comments      - 单页评论（带缓存）
    get_all_comments  - 全量翻页评论（带缓存）
    楼中楼回复自动翻页取全（每评论最多 REPLY_PAGE_SIZE 条/页，循环至 rcount）
"""

import asyncio
import logging
from typing import Optional

from bilibili_api import Credential, comment, video

from bilibili.cache import cache_get, cache_key, cache_set
from bilibili.config import MAX_COMMENTS, REPLY_PAGE_SIZE, REPLY_DELAY, RATE_DELAY
from bilibili.formatters import save_comments

logger = logging.getLogger(__name__)


async def _fetch_one_page(aid: int, page: int, credential: Optional[Credential] = None):
    """获取评论单页（page 从 1 起）"""
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


async def _fetch_all_replies(aid: int, rpid: int, rcount: int, credential: Optional[Credential] = None) -> list:
    """获取单条评论的全部楼中楼回复（翻页取全）"""
    if rcount <= 0:
        return []
    results = []
    total_pages = min((rcount + REPLY_PAGE_SIZE - 1) // REPLY_PAGE_SIZE, 20)  # 上限保护
    try:
        sub = comment.Comment(
            oid=aid,
            type_=comment.CommentResourceType.VIDEO,
            rpid=rpid,
            credential=credential,
        )
        for page in range(1, total_pages + 1):
            resp = await sub.get_sub_comments(page_index=page, page_size=REPLY_PAGE_SIZE)
            replies = resp.get("data", {}).get("replies") or resp.get("replies") or []
            results.extend(replies)
            if len(replies) < REPLY_PAGE_SIZE:
                break
            if page < total_pages:
                await asyncio.sleep(REPLY_DELAY / 1000)
    except Exception as e:
        logger.warning("回复获取失败 rpid=%s: %s", rpid, e)
    return results


async def _build_entries(aid: int, replies: list, with_replies: bool, credential: Optional[Credential] = None) -> list:
    """将原始评论组装为 [{"comment": ..., "replies": [...]}, ...]"""
    result = []
    for c in replies:
        entry = {"comment": c, "replies": []}
        if with_replies:
            entry["replies"] = await _fetch_all_replies(aid, c["rpid"], c.get("rcount", 0), credential)
            await asyncio.sleep(REPLY_DELAY / 1000)
        result.append(entry)
        extra = f" ({len(entry['replies'])}条回复)" if entry["replies"] else ""
        logger.info("   +%s %s%s", c["like"], c["content"]["message"][:60], extra)
    return result


async def _get_video_info(bvid: str, credential: Optional[Credential] = None):
    """获取 aid + 标题"""
    v = video.Video(bvid=bvid, credential=credential)
    info = await v.get_info()
    return info["aid"], info["title"], v


async def get_comments(
    bvid: str,
    page: int = 1,
    max_age: int = 30,
    credential: Optional[Credential] = None,
    save_fmt: Optional[str] = None,
    with_replies: bool = False,
) -> list:
    """
    获取单页评论（带缓存）

    Returns:
        [{"comment": {...}, "replies": [...]}, ...]
    """
    key = cache_key(bvid, f"comments_p{page}_r{int(with_replies)}", 0)
    cached = cache_get(key, max_age)
    if cached is not None:
        logger.info("[评论] 缓存命中 (%d 条)", len(cached))
        return cached

    aid, title, _v = await _get_video_info(bvid, credential)
    logger.info("[视频] %s (aid=%s)", title, aid)

    replies, total = await _fetch_one_page(aid, page, credential)
    logger.info("[评论] aid=%s 第%s页, 返回 %d 条 (总计约 %s)", aid, page, len(replies), total)

    result = await _build_entries(aid, replies, with_replies, credential)
    cache_set(key, result, max_age)

    if save_fmt:
        save_comments(result, bvid, save_fmt)
    return result


async def get_all_comments(
    bvid: str,
    max_age: int = 30,
    credential: Optional[Credential] = None,
    save_fmt: Optional[str] = None,
    with_replies: bool = False,
    max_pages: int = 0,
) -> list:
    """
    全量翻页获取评论（带缓存）

    Args:
        bvid: 视频BV号
        max_age: 缓存有效期（秒），0 = 禁用缓存
        credential: 登录凭证
        save_fmt: 保存格式
        with_replies: 是否获取楼中楼回复
        max_pages: 最大页数，0 = 不限

    Returns:
        [{"comment": {...}, "replies": [...]}, ...]
    """
    key = cache_key(bvid, f"comments_all_r{int(with_replies)}_p{max_pages}", 0)
    cached = cache_get(key, max_age)
    if cached is not None:
        logger.info("[评论] 全量缓存命中 (%d 条)", len(cached))
        return cached

    aid, title, _v = await _get_video_info(bvid, credential)
    pages_info = f" 目标{max_pages}页" if max_pages > 0 else " 全量"
    logger.info("[视频] %s (aid=%s)%s%s", title, aid, pages_info,
                "  [含回复]" if with_replies else "")

    all_items = []
    page = 1
    empty_streak = 0
    known_total = 0

    while True:
        if max_pages > 0 and page > max_pages:
            logger.info("  已达目标页数 %s，停止", max_pages)
            break

        replies, total = await _fetch_one_page(aid, page, credential)
        if total:
            known_total = total

        if not replies:
            empty_streak += 1
        else:
            empty_streak = 0
            items = await _build_entries(aid, replies, with_replies, credential)
            all_items.extend(items)
            r_count = sum(len(e["replies"]) for e in items)
            logger.info("  第%s页 +%d 评论 / +%d 回复 (累计 %d / %s)",
                        page, len(replies), r_count, len(all_items), known_total or "?")

        if empty_streak >= 2:
            logger.info("  连续%d页无数据, 停止", empty_streak)
            break
        if known_total and len(all_items) >= known_total:
            logger.info("  已获取全部 %s 条", known_total)
            break
        if len(all_items) > MAX_COMMENTS:
            logger.info("  达到安全上限 %s, 停止", MAX_COMMENTS)
            break

        page += 1
        await asyncio.sleep(RATE_DELAY / 1000)

    total_r = sum(len(e["replies"]) for e in all_items)
    logger.info("[评论] 全量完成: %d 评论, %d 回复", len(all_items), total_r)
    for item in all_items[:2]:
        c = item["comment"]
        logger.info("   +%s %s", c["like"], c["content"]["message"][:60])
        for r in item.get("replies", [])[:1]:
            logger.info("     ↳ %s: %s", r["member"]["uname"], r["content"]["message"][:50])

    cache_set(key, all_items, max_age)

    if save_fmt:
        save_comments(all_items, bvid, save_fmt)
    return all_items
