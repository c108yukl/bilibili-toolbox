"""
字幕抓取模块 - Player API（WBI）→ 视频信息字幕字段 → 重新拉取（移植扩展能力）

语言选择:
- 用户指定 lan_code：精确匹配 → 文档关键词模糊匹配
- 未指定：按 _PREFER_LAN 优先级 (ai-zh → zh-Hans → zh-Hant) → 第一个可用

返回:
    Subtitle 对象（提供 to_srt/to_ass/to_lrc/to_simple_json）；无字幕返回 None
"""

import logging
from typing import List, Optional

from bilibili.client import BiliAPIError, BiliClient
from bilibili.formatters import save_subtitle
from bilibili.models import CookieCredential, Subtitle, SubtitleLine

logger = logging.getLogger(__name__)

# 字幕语言代码映射
SUBTITLE_LAN_MAP = {
    "ai-zh": "中文（AI自动生成）",
    "zh-Hans": "中文（简体）",
    "zh-Hant": "中文（繁体）",
    "en": "英语",
    "ja": "日语",
    "ko": "韩语",
}

# 默认优先级
_PREFER_LAN = ["ai-zh", "zh-Hans", "zh-Hant"]

# 字幕支持保存的格式
SUBTITLE_FORMATS = {"srt", "ass", "lrc", "json"}

# 登录态相关错误码
_CODE_NEED_LOGIN = (-101, -352)  # 未登录 / 风控


def _match_lan(lan_code: str, codes: list, docs: list) -> str:
    """匹配用户指定语言 → code；失败时 fallback 到 doc 关键词"""
    if lan_code in codes:
        return lan_code
    lower = lan_code.lower()
    for doc, code in zip(docs, codes):
        if lower in doc.lower() or lower in code.lower():
            return code
    logger.warning("未找到匹配语言 '%s'，使用第一个 (%s)", lan_code, codes[0])
    return codes[0]


async def _fetch_player_subtitles(
    client: BiliClient, aid: int, cid: int, cookie: bool
) -> list:
    """Player WBI 接口获取字幕列表；失败返回空列表（走降级链路）"""
    try:
        params = {"aid": aid, "cid": cid, "isGaiaAvoided": False, "web_location": 1315873}
        data = await client.fetch_json(
            "https://api.bilibili.com/x/player/wbi/v2",
            params,
            wbi_sign=True,
            cookie=cookie,
        )
        return (data.get("subtitle") or {}).get("subtitles") or []
    except BiliAPIError as e:
        if e.code in _CODE_NEED_LOGIN:
            raise  # 需要登录：交给上层处理
        logger.debug("[字幕] Player API失败: %s", e)
        return []
    except Exception as e:
        logger.debug("[字幕] Player API失败: %s", e)
        return []


def _build_subtitle_candidates(subtitles: list, lan_code: str) -> list:
    """按语言优先级排序候选：所选语言 → ai-zh/zh-Hans/zh-Hant → 其余"""
    ordered: list = []
    seen: set = set()

    def push(s) -> None:
        if not s or s.get("lan") in seen:
            return
        seen.add(s.get("lan"))
        ordered.append(s)

    if lan_code:
        push(next((s for s in subtitles if s.get("lan") == lan_code), None))
    for prefer in _PREFER_LAN:
        if prefer == lan_code:
            continue
        push(next((s for s in subtitles if s.get("lan") == prefer), None))
    for s in subtitles:
        push(s)
    return ordered


async def _download_subtitle(client: BiliClient, subtitles: list, lan_code: str, cookie: bool):
    """
    按候选顺序下载字幕 JSON → (Subtitle, picked) 或 None

    Raises:
        ValueError: 明确需要登录（-101/-352）且未提供 Cookie
    """
    candidates = _build_subtitle_candidates(subtitles, lan_code)
    need_login = False
    for picked in candidates:
        url = picked.get("subtitle_url") or ""
        if not url:
            logger.debug("[字幕] 跳过 %s (URL为空)", picked.get("lan_doc") or picked.get("lan"))
            continue
        if url.startswith("//"):
            url = "https:" + url
        elif not url.startswith("http"):
            url = "https:" + url
        try:
            raw = await client.fetch_raw(url, cookie=cookie)
            import json

            data = json.loads(raw.decode("utf-8", "replace"))
            body = data.get("body") or []
            if body:
                lan = picked.get("lan") or lan_code or "unknown"
                lan_doc = picked.get("lan_doc") or SUBTITLE_LAN_MAP.get(lan, lan)
                logger.info("[字幕] 成功获取: %s (%d条)", lan_doc, len(body))
                return Subtitle(
                    lan=lan,
                    lan_doc=lan_doc,
                    lines=[SubtitleLine.from_json(line) for line in body],
                )
            logger.debug("[字幕] %s 内容为空，尝试下一个", picked.get("lan_doc") or picked.get("lan"))
        except BiliAPIError as e:
            if e.code in _CODE_NEED_LOGIN:
                need_login = True
            logger.info("  [字幕] %s 下载失败，尝试下一个...", picked.get("lan_doc") or picked.get("lan"))
        except Exception as e:
            logger.info("  [字幕] %s 下载失败，尝试下一个... (%s)", picked.get("lan_doc") or picked.get("lan"), e)

    if need_login and not cookie:
        raise ValueError("获取字幕需要登录 Cookie（B站字幕接口强制登录），请传入 --cookie 或 --browser-cookie")
    return None


async def get_subtitle(
    bvid: str,
    page_index: int = 0,
    credential: Optional[CookieCredential] = None,
    lan_code: str = "",
    save_fmt: str = "srt",
    client: Optional[BiliClient] = None,
):
    """
    获取视频字幕（Player WBI → view 字幕字段 → 重拉 三级降级）

    Args:
        bvid: 视频BV号
        page_index: 分P索引
        credential: 登录凭证（B站字幕接口强制登录）
        lan_code: 字幕语言代码 (如 ai-zh, en, ja)
        save_fmt: 保存格式 (srt/ass/lrc/json)，None = 不保存
        client: 复用请求客户端

    Returns:
        Subtitle 对象；该视频无字幕时返回 None
    """
    own_client = client is None
    client = client or BiliClient(credential=credential)
    try:
        info = await client.fetch_json(
            "https://api.bilibili.com/x/web-interface/view", {"bvid": bvid}
        )
        pages = info.get("pages") or []
        if not 0 <= page_index < len(pages):
            raise ValueError(f"分P索引越界: page_index={page_index}, 该视频共 {len(pages)} 个分P")
        cid = pages[page_index].get("cid")
        aid = info.get("aid")
        title = info.get("title", "")
        logger.info("[视频] %s (cid=%s)", title, cid)

        cookie = bool(credential and credential.has_sessdata)

        # Try 1: Player API（WBI 签名，字幕的正确来源）
        subs: List[dict] = []
        try:
            if aid and cid:
                subs = await _fetch_player_subtitles(client, aid, cid, cookie)
        except BiliAPIError as e:
            if e.code in _CODE_NEED_LOGIN:
                if not cookie:
                    raise ValueError(
                        "获取字幕需要登录 Cookie（B站字幕接口强制登录），请传入 --cookie 或 --browser-cookie"
                    ) from None
                logger.warning("[字幕] Player API 提示未登录，尝试兜底链路...")
            else:
                raise

        # Try 2: 视频信息中的字幕字段（常含空 URL，作为兜底）
        if not subs:
            subs = (info.get("subtitle") or {}).get("subtitles") or []

        # Try 3: 重新拉取视频信息
        if not subs:
            try:
                info2 = await client.fetch_json(
                    "https://api.bilibili.com/x/web-interface/view", {"bvid": bvid}
                )
                subs = (info2.get("subtitle") or {}).get("subtitles") or []
            except Exception as e:
                logger.debug("[字幕] 重拉视频信息失败: %s", e)

        if not subs:
            logger.warning("[字幕] 该视频没有字幕")
            return None

        codes = [s.get("lan", "") for s in subs]
        docs = [s.get("lan_doc", "") or SUBTITLE_LAN_MAP.get(c, c) for c, s in zip(codes, subs)]
        logger.info("[字幕] 可用语言: %s", dict(zip(docs, codes)))

        # 用户指定语言 → 精确匹配；否则按优先级
        if lan_code:
            lan_code = _match_lan(lan_code, codes, docs)
        else:
            lan_code = next((c for c in codes if c in _PREFER_LAN), codes[0])

        sub = await _download_subtitle(client, subs, lan_code, cookie)
        if sub is None:
            return None

        if save_fmt:
            save_subtitle(sub, bvid, sub.lan, save_fmt)
        return sub
    finally:
        if own_client:
            await client.close()
