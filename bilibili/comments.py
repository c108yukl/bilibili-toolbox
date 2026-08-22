"""
评论抓取模块 - cursor 主流接口 → WBI 签名 → page 备用接口（移植扩展能力）

结构:
    get_comments      - 单页评论（带缓存，page 接口语义）
    get_all_comments  - 全量翻页评论（带缓存，cursor 接口优先）

特性:
- 主流接口 x/v2/reply/main 受限时自动降级：重试一次 WBI 签名版 → 切 x/v2/reply 分页接口
- 置顶评论与普通评论合并，按 rpid 去重（B站可能重复返回）
- 楼中楼自动翻页取全（每评论最多 20 页保护上限）
- 滑动窗口：max_comments > 0 时达到目标条数立即停止并截断（保留最热在前）
- 翻页速率可调（RATE_DELAY / REPLY_DELAY），连续 2 页无数据停止

返回结构与旧版兼容:
    [{"comment": {...原始评论 dict...}, "replies": [...]}, ...]
"""

import asyncio
import logging

from bilibili.cache import cache_get, cache_key, cache_set
from bilibili.client import BiliAPIError, BiliClient, BiliError
from bilibili.config import MAX_COMMENTS, RATE_DELAY, REPLY_DELAY, REPLY_PAGE_SIZE
from bilibili.formatters import save_comments
from bilibili.models import CookieCredential

logger = logging.getLogger(__name__)

_REPLY_MAX_PAGES = 20  # 楼中楼翻页保护上限


# ─── 单页获取 ─────────────────────────────────────────────

async def _fetch_page_cursor(
    client: BiliClient, aid: int, cursor: int | None, cookie: bool = True
) -> dict:
    """
    x/v2/reply/main cursor 接口；首次失败（风控）时重试一次 WBI 签名版

    Returns:
        原始响应 dict（含 replies/top_replies/cursor）
    """
    last_err: Exception | None = None
    for attempt in range(2):
        params = {"type": 1, "oid": aid, "mode": 3}
        if cursor:
            params["next"] = cursor
        try:
            return await client.fetch_json(
                "https://api.bilibili.com/x/v2/reply/main",
                params,
                wbi_sign=(attempt == 1),
                cookie=cookie,
            )
        except (BiliAPIError, BiliError) as e:
            last_err = e
            if attempt == 0:
                logger.info("  [评论] 主流API受限，尝试WBI签名...")
    raise last_err or BiliError("评论 cursor 接口失败")


async def _fetch_page_by_page(client: BiliClient, aid: int, page: int, cookie: bool = True) -> dict:
    """x/v2/reply 分页备用接口（WBI 签名）"""
    params = {"type": 1, "oid": aid, "pn": page, "sort": 2}
    data = await client.fetch_json(
        "https://api.bilibili.com/x/v2/reply", params, wbi_sign=True, cookie=cookie
    )
    replies = data.get("replies") or []
    page_info = data.get("page") or {}
    return {
        "replies": replies,
        "top_replies": data.get("top_replies") or [],
        "cursor": {
            "next": page + 1,
            "all_count": page_info.get("acount") or page_info.get("count") or 0,
            "is_end": not replies,
        },
    }


async def _fetch_all_replies(
    client: BiliClient, aid: int, rpid: int, rcount: int, cookie: bool = True
) -> list:
    """获取单条评论的全部楼中楼回复（翻页取全，失败返回已获取部分）"""
    if rcount <= 0:
        return []
    results: list = []
    total_pages = min((rcount + REPLY_PAGE_SIZE - 1) // REPLY_PAGE_SIZE, _REPLY_MAX_PAGES)
    for page in range(1, total_pages + 1):
        try:
            data = await client.fetch_json(
                "https://api.bilibili.com/x/v2/reply/reply",
                {"type": 1, "oid": aid, "root": rpid, "ps": REPLY_PAGE_SIZE, "pn": page},
                cookie=cookie,
            )
            replies = data.get("replies") or []
            results.extend(replies)
            if len(replies) < REPLY_PAGE_SIZE:
                break
        except Exception as e:
            logger.warning("回复获取失败 rpid=%s 第%s页: %s", rpid, page, e)
            break
        if page < total_pages:
            await asyncio.sleep(REPLY_DELAY / 1000)
    return results


async def _build_entries(
    client: BiliClient,
    aid: int,
    raw_replies: list,
    with_replies: bool,
    credential: CookieCredential | None,
) -> list:
    """原始评论列表 → [{"comment": ..., "replies": [...]}]（含置顶合并与 rpid 去重）"""
    result: list = []
    seen: set = set()
    cookie = bool(credential and credential.has_sessdata)
    for c in raw_replies:
        rpid = c.get("rpid", 0)
        if rpid in seen:
            continue
        seen.add(rpid)
        entry = {"comment": c, "replies": []}
        if with_replies and c.get("rcount", 0) > 0:
            entry["replies"] = await _fetch_all_replies(
                client, aid, rpid, c.get("rcount", 0), cookie
            )
            await asyncio.sleep(REPLY_DELAY / 1000)
        result.append(entry)
        extra = f" ({len(entry['replies'])}条回复)" if entry["replies"] else ""
        logger.info(
            "   +%s %s%s",
            c.get("like", 0),
            ((c.get("content") or {}).get("message", ""))[:60],
            extra,
        )
    return result


async def _get_video_aid(client: BiliClient, bvid: str) -> tuple:
    """获取 aid + 标题"""
    info = await client.fetch_json(
        "https://api.bilibili.com/x/web-interface/view", {"bvid": bvid}
    )
    return info.get("aid"), info.get("title", "")


# ─── 对外 API ─────────────────────────────────────────────

async def get_comments(
    bvid: str,
    page: int = 1,
    max_age: int = 30,
    credential: CookieCredential | None = None,
    save_fmt: str | None = None,
    with_replies: bool = False,
    client: BiliClient | None = None,
) -> list:
    """
    获取单页评论（带缓存，含置顶合并与去重）

    Returns:
        [{"comment": {...}, "replies": [...]}, ...]
    """
    if page < 1:
        raise ValueError(f"页码必须 >= 1, 收到 {page}")
    key = cache_key(bvid, f"comments_p{page}_r{int(with_replies)}", 0)
    cached = cache_get(key, max_age)
    if cached is not None:
        logger.info("[评论] 缓存命中 (%d 条)", len(cached))
        return cached

    own_client = client is None
    client = client or BiliClient(credential=credential)
    try:
        aid, title = await _get_video_aid(client, bvid)
        logger.info("[视频] %s (aid=%s)", title, aid)

        cookie = bool(credential and credential.has_sessdata)
        data = await _fetch_page_by_page(client, aid, page, cookie)
        replies = data.get("replies") or []
        top_replies = data.get("top_replies") or []
        total = (data.get("cursor") or {}).get("all_count", 0)
        logger.info("[评论] aid=%s 第%s页, 返回 %d 条 (总计约 %s)", aid, page, len(replies), total)

        result = await _build_entries(
            client, aid, [*top_replies, *replies], with_replies, credential
        )
        cache_set(key, result, max_age)

        if save_fmt:
            save_comments(result, bvid, save_fmt)
        return result
    finally:
        if own_client:
            await client.close()


async def get_all_comments(
    bvid: str,
    max_age: int = 30,
    credential: CookieCredential | None = None,
    save_fmt: str | None = None,
    with_replies: bool = False,
    max_pages: int = 0,
    max_comments: int = 0,
    client: BiliClient | None = None,
) -> list:
    """
    全量翻页获取评论（带缓存；cursor 接口 → WBI → page 接口自动降级）

    滑动窗口：max_comments > 0 时，累计达到目标条数立即停止翻页；
    若单页超出则截断，仅保留前 max_comments 条（按热度排序的前端，最热评论）。

    Args:
        bvid: 视频BV号
        max_age: 缓存有效期（秒），0 = 禁用缓存
        credential: 登录凭证
        save_fmt: 保存格式
        with_replies: 是否获取楼中楼回复
        max_pages: 最大页数，0 = 不限
        max_comments: 评论条数上限（滑动窗口），0 = 不限
        client: 复用请求客户端

    Returns:
        [{"comment": {...}, "replies": [...]}, ...]
    """
    key = cache_key(bvid, f"comments_all_r{int(with_replies)}_p{max_pages}_n{max_comments}", 0)
    cached = cache_get(key, max_age)
    if cached is not None:
        logger.info("[评论] 全量缓存命中 (%d 条)", len(cached))
        return cached

    own_client = client is None
    client = client or BiliClient(credential=credential)
    try:
        aid, title = await _get_video_aid(client, bvid)
        pages_info = f" 目标{max_pages}页" if max_pages > 0 else " 全量"
        count_info = f" 目标{max_comments}条" if max_comments > 0 else ""
        logger.info(
            "[视频] %s (aid=%s)%s%s%s",
            title, aid, pages_info, count_info,
            "  [含回复]" if with_replies else "",
        )

        all_items: list = []
        page = 1
        cursor: int | None = None
        empty_streak = 0
        known_total = 0
        using_page_api = False  # 一旦降级到 page 接口就保持使用
        cookie = bool(credential and credential.has_sessdata)

        while True:
            if max_pages > 0 and page > max_pages:
                logger.info("  已达目标页数 %s，停止", max_pages)
                break
            if max_comments > 0 and len(all_items) >= max_comments:
                logger.info("  已达目标条数 %s，停止", max_comments)
                break
            if len(all_items) > MAX_COMMENTS:
                logger.info("  达到安全上限 %s, 停止", MAX_COMMENTS)
                break

            if using_page_api:
                data = await _fetch_page_by_page(client, aid, page, cookie)
            else:
                try:
                    data = await _fetch_page_cursor(client, aid, cursor, cookie)
                except Exception as e:
                    logger.info("  [评论] 主流API被风控，切换备用接口... (%s)", e)
                    data = await _fetch_page_by_page(client, aid, page, cookie)
                    using_page_api = True

            cursor_data = data.get("cursor") or {}
            known_total = cursor_data.get("all_count") or known_total

            top_replies = data.get("top_replies") or []
            replies = data.get("replies") or []

            if not top_replies and not replies:
                empty_streak += 1
                if empty_streak >= 2:
                    logger.info("  连续%d页无数据, 停止", empty_streak)
                    break
            else:
                empty_streak = 0
                items = await _build_entries(
                    client, aid, [*top_replies, *replies], with_replies, credential
                )
                all_items.extend(items)
                # 滑动窗口：逐条累计，达到目标条数立即截断
                if max_comments > 0 and len(all_items) >= max_comments:
                    all_items = all_items[:max_comments]
                r_count = sum(len(e["replies"]) for e in items)
                top_tag = f" / {len(top_replies)} 置顶" if top_replies else ""
                logger.info(
                    "  第%s页 +%d 评论%s / +%d 回复 (累计 %d / %s)",
                    page, len(replies), top_tag, r_count, len(all_items), known_total or "?",
                )

            if cursor_data.get("is_end"):
                logger.info("  已到最后一页")
                break
            if known_total and len(all_items) >= known_total:
                logger.info("  已获取全部 %s 条", known_total)
                break
            if max_comments > 0 and len(all_items) >= max_comments:
                logger.info("  已达目标条数 %s，停止", max_comments)
                break

            if using_page_api:
                page += 1
            else:
                cursor = cursor_data.get("next")
                if not cursor:
                    break
                page += 1
            await asyncio.sleep(RATE_DELAY / 1000)

        total_r = sum(len(e["replies"]) for e in all_items)
        logger.info("[评论] 全量完成: %d 评论, %d 回复", len(all_items), total_r)
        for item in all_items[:2]:
            c = item["comment"]
            logger.info(
                "   +%s %s",
                c.get("like", 0),
                ((c.get("content") or {}).get("message", ""))[:60],
            )
            for r in item.get("replies", [])[:1]:
                logger.info(
                    "     ↳ %s: %s",
                    ((r.get("member") or {}).get("uname", "")),
                    ((r.get("content") or {}).get("message", ""))[:50],
                )

        cache_set(key, all_items, max_age)

        if save_fmt:
            save_comments(all_items, bvid, save_fmt)
        return all_items
    finally:
        if own_client:
            await client.close()
