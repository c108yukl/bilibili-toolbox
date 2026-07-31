"""
B站 弹幕+评论+字幕 爬取工具 - Streamlit 本地网页版

运行: streamlit run app.py
"""

import asyncio
import logging
from pathlib import Path

import streamlit as st

from bilibili import (
    extract_bvid,
    get_all_comments,
    get_comments,
    get_danmaku,
    get_subtitle,
    parse_cookie,
)
from bilibili.config import OUTPUT_DIR, ensure_dirs

st.set_page_config(page_title="B站爬虫工具", page_icon="📥", layout="centered")
st.title("📥 B站 弹幕 / 评论 / 字幕 爬取工具")

with st.sidebar:
    st.header("参数设置")
    bvid = st.text_input(
        "视频 BV 号 / URL",
        placeholder="BV1cmofByENF",
        help="支持 BV 号或完整 bilibili 链接",
    )
    col1, col2 = st.columns(2)
    with col1:
        get_dm = st.checkbox("弹幕", value=True)
        get_cm = st.checkbox("评论")
        get_sub = st.checkbox("字幕")
    with col2:
        max_pages = st.number_input(
            "目标页数 (0=全部)", min_value=0, value=0, help="0=爬取全部页面; 输入N则只爬前N页"
        )
        with_replies = st.checkbox("楼中楼回复")
        sub_lan = st.selectbox(
            "字幕语言",
            ["ai-zh (中文AI)", "zh-Hans (简体)", "zh-Hant (繁体)", "en (英语)", "ja (日语)", "ko (韩语)"],
            index=0,
        )
    save_fmt = st.selectbox("保存格式", ["txt", "json", "csv", "srt", "ass", "lrc"], index=0)
    cookie = st.text_input("Cookie (含 SESSDATA)", type="password", placeholder="SESSDATA=xxx")
    disable_cache = st.checkbox("禁用缓存", value=False)
    go = st.button("🚀 开始爬取", type="primary", use_container_width=True)

# 字幕格式映射：txt/csv 对字幕不适用，兜底 srt
_SUB_FMT_MAP = {"txt": "srt", "csv": "srt"}
_FILE_MIMES = {
    "json": "application/json",
    "csv": "text/csv",
    "srt": "text/plain",
    "ass": "text/plain",
    "lrc": "text/plain",
    "txt": "text/plain",
}


class StreamlitLogHandler(logging.Handler):
    """将 SDK 日志实时渲染到页面日志区"""

    def __init__(self, log_area):
        super().__init__(level=logging.INFO)
        self.lines = []
        self.log_area = log_area
        self.setFormatter(logging.Formatter("%(message)s"))

    def emit(self, record):
        try:
            msg = self.format(record)
            self.lines.append(msg)
            self.log_area.code("\n".join(self.lines[-60:]), language="")
        except Exception:
            pass


def _attach_log_handler(log_area) -> StreamlitLogHandler:
    logging.getLogger().setLevel(logging.INFO)
    handler = StreamlitLogHandler(log_area)
    logging.getLogger().addHandler(handler)
    return handler


def main():
    if not go or not bvid.strip():
        return

    try:
        real_bvid = extract_bvid(bvid.strip())
    except ValueError as e:
        st.error(f"❌ {e}")
        return

    credential = parse_cookie(cookie) if cookie else None
    max_age = 0 if disable_cache else 30

    ensure_dirs()
    log_area = st.empty()
    progress_text = st.empty()
    handler = _attach_log_handler(log_area)

    async def run():
        if get_dm:
            progress_text.info("📺 正在获取弹幕...")
            await get_danmaku(real_bvid, max_age=max_age, credential=credential, save_fmt=save_fmt)
        if get_sub:
            lan_code = sub_lan.split(" ")[0]
            progress_text.info(f"📄 正在获取字幕 ({lan_code})...")
            await get_subtitle(
                real_bvid,
                credential=credential,
                lan_code=lan_code,
                save_fmt=_SUB_FMT_MAP.get(save_fmt, save_fmt),
            )
        if get_cm:
            if max_pages:
                progress_text.info(f"💬 正在获取评论 (目标 {max_pages} 页)...")
                await get_all_comments(
                    real_bvid,
                    max_age=max_age,
                    credential=credential,
                    save_fmt=save_fmt,
                    with_replies=with_replies,
                    max_pages=max_pages,
                )
            else:
                progress_text.info("💬 正在获取评论 (单页)...")
                await get_comments(
                    real_bvid,
                    max_age=max_age,
                    credential=credential,
                    save_fmt=save_fmt,
                    with_replies=with_replies,
                )

    try:
        asyncio.run(run())
        progress_text.success("✅ 爬取完成！")

        # 收集本次生成的输出文件，提供下载按钮
        patterns = [
            f"danmaku_{real_bvid}.*",
            f"comments_{real_bvid}.*",
            f"subtitle_{real_bvid}*",
        ]
        files = []
        for pattern in patterns:
            files.extend(sorted(OUTPUT_DIR.glob(pattern)))
        if files:
            st.subheader("📎 下载文件")
            for fp in files:
                data = fp.read_text(encoding="utf-8")
                st.download_button(
                    label=f"下载 {fp.name}",
                    data=data,
                    file_name=fp.name,
                    mime=_FILE_MIMES.get(fp.suffix.lstrip("."), "text/plain"),
                )
            st.caption(f"文件保存在: {OUTPUT_DIR}")
    except Exception as e:
        st.error(f"❌ 出错: {e}")
    finally:
        logging.getLogger().removeHandler(handler)


main()
