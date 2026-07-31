"""
字幕抓取模块
"""

import logging
from typing import Optional

from bilibili_api import Credential, video
from bilibili_api.ass import request_subtitle_languages

from bilibili.formatters import save_subtitle

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


async def get_subtitle(
    bvid: str,
    page_index: int = 0,
    credential: Optional[Credential] = None,
    lan_code: str = "",
    save_fmt: str = "srt",
):
    """
    获取视频字幕

    Args:
        bvid: 视频BV号
        page_index: 分P索引
        credential: 登录凭证
        lan_code: 字幕语言代码 (如 ai-zh, en, ja)
        save_fmt: 保存格式 (srt/ass/lrc/json)

    Returns:
        Subtitle 对象；该视频无字幕时返回 None
    """
    v = video.Video(bvid=bvid, credential=credential)
    info = await v.get_info()
    cid = info["pages"][page_index]["cid"]
    logger.info("[视频] %s (cid=%s)", info["title"], cid)

    sub_obj = await request_subtitle_languages(
        obj=v, page_index=page_index, credential=credential
    )
    codes, docs = sub_obj.get_lan_list()
    if not codes:
        logger.warning("[字幕] 该视频没有字幕")
        return None

    logger.info("[字幕] 可用语言: %s", dict(zip(docs, codes)))

    # 用户指定语言 → 精确匹配；否则按 doc 关键词
    if lan_code:
        lan_code = _match_lan(lan_code, codes, docs)
    else:
        lan_code = next((c for c in codes if c in _PREFER_LAN), codes[0])

    lan_doc = SUBTITLE_LAN_MAP.get(lan_code, lan_code)
    logger.info("[字幕] 正在获取 %s (%s)...", lan_doc, lan_code)
    await sub_obj.request_ass_data_json(lan_set=lan_code)

    if save_fmt:
        save_subtitle(sub_obj, bvid, lan_code, save_fmt)

    return sub_obj
