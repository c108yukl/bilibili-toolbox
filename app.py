"""
B站弹幕+评论 爬虫 - Streamlit 本地网页版
不修改原始脚本，直接复用其核心函数
"""
import asyncio
import io
import sys
import json
from contextlib import redirect_stdout
from pathlib import Path

import streamlit as st

_stdout_save = sys.stdout
import bilibili_demo as bd
# 将模块创建的 TextIOWrapper 保存在 bd 模块上（跨 Streamlit 重跑持久存在）
# 后续每次重跑从 bd 恢复，防止 TextIOWrapper 被 GC 关闭底层 buffer
if not hasattr(bd, '_saved_stdout'):
    bd._saved_stdout = sys.stdout
sys.stdout = bd._saved_stdout

st.set_page_config(page_title="B站爬虫工具", page_icon="📥", layout="centered")
st.title("📥 B站 弹幕 / 评论 / 字幕 爬取工具")

with st.sidebar:
    st.header("参数设置")
    bvid = st.text_input("视频 BV 号 / URL", placeholder="BV1cmofByENF",
                         help="支持 BV 号或完整 bilibili 链接")
    col1, col2 = st.columns(2)
    with col1:
        get_dm = st.checkbox("弹幕", value=True)
        get_cm = st.checkbox("评论")
        get_sub = st.checkbox("字幕")
    with col2:
        max_pages = st.number_input("目标页数 (0=全部)", min_value=0, value=0,
                                     help="0=爬取全部页面; 输入N则只爬前N页")
        with_replies = st.checkbox("楼中楼回复")
        sub_lan = st.selectbox("字幕语言",
            ["ai-zh (中文AI)", "zh-Hans (简体)", "zh-Hant (繁体)",
             "en (英语)", "ja (日语)", "ko (韩语)"], index=0)
    save_fmt = st.selectbox("保存格式",
        ["txt", "json", "csv", "srt", "ass", "lrc"], index=0)
    cookie = st.text_input("Cookie (含 SESSDATA)", type="password",
                           placeholder="SESSDATA=xxx")
    disable_cache = st.checkbox("禁用缓存", value=False)
    go = st.button("🚀 开始爬取", type="primary", use_container_width=True)


def main():
    if not go or not bvid.strip():
        return

    try:
        real_bvid = bd.extract_bvid(bvid.strip())
    except ValueError as e:
        st.error(f"❌ {e}")
        return

    credential = bd.parse_cookie(cookie) if cookie else None
    max_age = 0 if disable_cache else 30

    log_area = st.empty()
    progress_text = st.empty()
    status_text = st.empty()

    class CaptureIO(io.StringIO):
        def __init__(self):
            super().__init__()
            self.all = []

        def write(self, s):
            if s.strip():
                self.all.append(s.rstrip())
                log_area.code("\n".join(self.all[-50:]), language="")
            super().write(s)

    cap = CaptureIO()

    async def run():
        nonlocal cap
        with redirect_stdout(cap):
            if get_dm:
                progress_text.info("📺 正在获取弹幕...")
                await bd.get_danmaku(real_bvid, max_age=max_age,
                                     credential=credential, save_fmt=save_fmt)
            if get_sub:
                lan_code = sub_lan.split(" ")[0]
                progress_text.info(f"📄 正在获取字幕 ({lan_code})...")
                await bd.get_subtitle(real_bvid, credential=credential,
                                      lan_code=lan_code,
                                      save_fmt={"srt": "srt", "ass": "ass",
                                                "lrc": "lrc", "json": "json",
                                                "txt": "srt", "csv": "srt"
                                               }.get(save_fmt, "srt"))
            if get_cm:
                if max_pages:
                    label = f"💬 正在获取评论 (目标 {max_pages} 页)..."
                    progress_text.info(label)
                    await bd.get_all_comments(real_bvid, max_age=max_age,
                                              credential=credential,
                                              save_fmt=save_fmt,
                                              with_replies=with_replies,
                                              max_pages=max_pages)
                else:
                    progress_text.info("💬 正在获取评论 (单页)...")
                    await bd.get_comments(real_bvid, max_age=max_age,
                                          credential=credential,
                                          save_fmt=save_fmt,
                                          with_replies=with_replies)

    try:
        asyncio.run(run())
        progress_text.success("✅ 爬取完成！")
        cap.flush()
        if save_fmt:
            for suffix in [save_fmt, "txt", "json", "csv", "srt", "ass", "lrc"]:
                for pattern in [f"danmaku_{real_bvid}", f"comments_{real_bvid}",
                                f"subtitle_{real_bvid}"]:
                    for fp in Path(__file__).parent.glob(f"{pattern}.{suffix}"):
                        data = fp.read_text(encoding="utf-8")
                        st.download_button(
                            label=f"📎 下载 {fp.name}",
                            data=data,
                            file_name=fp.name,
                            mime={"json": "application/json",
                                  "csv": "text/csv",
                                  "srt": "text/plain",
                                  "ass": "text/plain",
                                  "lrc": "text/plain",
                                  "txt": "text/plain"}.get(suffix, "text/plain"),
                        )
        st.success(f"文件保存在: {Path(__file__).parent}")
    except Exception as e:
        status_text.error(f"❌ 出错: {e}")
        raise


main()
