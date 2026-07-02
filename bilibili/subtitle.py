"""
字幕抓取模块
"""

from bilibili_api import video, Credential
from bilibili_api.ass import request_subtitle_languages

from bilibili.formatters import save_subtitle

# 字幕语言代码映射
SUBTITLE_LAN_MAP = {
    "ai-zh": "中文（AI自动生成）",
    "zh-Hans": "中文（简体）",
    "zh-Hant": "中文（繁体）",
    "en": "英语",
    "ja": "日语",
    "ko": "韩语",
}


async def get_subtitle(
    bvid: str,
    page_index: int = 0,
    credential: Credential = None,
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
    """
    v = video.Video(bvid=bvid, credential=credential)
    info = await v.get_info()
    cid = info["pages"][page_index]["cid"]
    print(f"[视频] {info['title']}  (cid={cid})")

    sub_obj = await request_subtitle_languages(
        obj=v, page_index=page_index, credential=credential
    )
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
