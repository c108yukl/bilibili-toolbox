"""
B站 弹幕+评论+字幕 爬取工具 - Streamlit 本地网页版（包内实现）

入口: streamlit run app.py（根目录薄壳调用本模块 run）
"""

import asyncio
import logging

import streamlit as st

from bilibili import (
    extract_bvid,
    get_all_comments,
    get_comments,
    get_danmaku,
    get_subtitle,
    parse_cookie,
)
from bilibili.client import BiliClient
from bilibili.config import OUTPUT_DIR, ensure_dirs
from bilibili.formatters import (
    COMMENT_FORMATS,
    DANMAKU_FORMATS,
    normalize_fmt,
)

# 字幕格式映射：txt/csv 对字幕不适用，兜底 srt
_SUB_FMT_MAP = {"txt": "srt", "csv": "srt"}
_FILE_MIMES = {
    "json": "application/json",
    "csv": "text/csv",
    "srt": "text/plain",
    "ass": "text/plain",
    "lrc": "text/plain",
    "txt": "text/plain",
    "md": "text/markdown",
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


def _render_sidebar():
    """侧边栏参数 → (params, go)"""
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
    return {
        "bvid": bvid,
        "get_dm": get_dm,
        "get_cm": get_cm,
        "get_sub": get_sub,
        "max_pages": int(max_pages),
        "with_replies": with_replies,
        "sub_lan": sub_lan.split(" ")[0],
        "save_fmt": save_fmt,
        "cookie": cookie,
        "disable_cache": disable_cache,
    }, go


async def _run_tasks(params, real_bvid, credential, max_age, progress_text):
    """各任务独立隔离错误：单个任务失败不中断其余任务；复用同一 HTTP 客户端"""
    errors = []
    async with BiliClient(credential=credential) as client:
        if params["get_dm"]:
            progress_text.info("📺 正在获取弹幕...")
            try:
                await get_danmaku(
                    real_bvid, max_age=max_age, credential=credential,
                    save_fmt=normalize_fmt(params["save_fmt"], DANMAKU_FORMATS),
                    client=client,
                )
            except Exception as e:
                logging.error("[弹幕] 失败: %s", e)
                errors.append(("弹幕", str(e)))

        if params["get_sub"]:
            progress_text.info(f"📄 正在获取字幕 ({params['sub_lan']})...")
            try:
                await get_subtitle(
                    real_bvid,
                    credential=credential,
                    lan_code=params["sub_lan"],
                    save_fmt=_SUB_FMT_MAP.get(params["save_fmt"], params["save_fmt"]),
                    client=client,
                )
            except Exception as e:
                logging.error("[字幕] 失败: %s（部分视频字幕需要登录 Cookie）", e)
                errors.append(("字幕", str(e)))

        if params["get_cm"]:
            try:
                if params["max_pages"]:
                    progress_text.info(f"💬 正在获取评论 (目标 {params['max_pages']} 页)...")
                    await get_all_comments(
                        real_bvid,
                        max_age=max_age,
                        credential=credential,
                        save_fmt=normalize_fmt(params["save_fmt"], COMMENT_FORMATS),
                        with_replies=params["with_replies"],
                        max_pages=params["max_pages"],
                        client=client,
                    )
                else:
                    progress_text.info("💬 正在获取评论 (单页)...")
                    await get_comments(
                        real_bvid,
                        max_age=max_age,
                        credential=credential,
                        save_fmt=normalize_fmt(params["save_fmt"], COMMENT_FORMATS),
                        with_replies=params["with_replies"],
                        client=client,
                    )
            except Exception as e:
                logging.error("[评论] 失败: %s", e)
                errors.append(("评论", str(e)))
    return errors


def _show_downloads(real_bvid):
    """收集本次生成的输出文件，提供下载按钮"""
    patterns = [
        f"danmaku_{real_bvid}.*",
        f"comments_{real_bvid}.*",
        f"subtitle_{real_bvid}*",
        f"analysis_{real_bvid}*",
        f"summary_{real_bvid}*",
        f"cloud_{real_bvid}*",
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


def run():
    st.set_page_config(page_title="B站爬虫工具", page_icon="📥", layout="centered")
    st.title("📥 B站 弹幕 / 评论 / 字幕 爬取工具")

    params, go = _render_sidebar()

    if not go or not params["bvid"].strip():
        return

    try:
        real_bvid = extract_bvid(params["bvid"].strip())
    except ValueError as e:
        st.error(f"❌ {e}")
        return

    if not (params["get_dm"] or params["get_cm"] or params["get_sub"]):
        st.info("请至少勾选一种任务（弹幕 / 评论 / 字幕）")
        return

    credential = parse_cookie(params["cookie"]) if params["cookie"] else None
    max_age = 0 if params["disable_cache"] else 30

    ensure_dirs()
    log_area = st.empty()
    progress_text = st.empty()
    handler = _attach_log_handler(log_area)

    try:
        errors = asyncio.run(_run_tasks(params, real_bvid, credential, max_age, progress_text))
        if errors:
            detail = "；".join(f"{name}: {err}" for name, err in errors)
            progress_text.warning(f"⚠️ 部分任务失败（{len(errors)} 个）: {detail}")
        else:
            progress_text.success("✅ 爬取完成！")
        _show_downloads(real_bvid)
    except Exception as e:
        st.error(f"❌ 出错: {e}")
    finally:
        logging.getLogger().removeHandler(handler)
