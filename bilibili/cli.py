"""
B站 弹幕+评论(+回复)+字幕 爬取工具 - CLI 实现（包内）

用法:
  bili BV1cmofByENF -dc --all --replies --save json
  bili BV1cmofByENF -d --cloud                 # 弹幕 + 热词
  bili BV1cmofByENF -d -c -s --ai --ai-key sk-xxx   # 抓取 + AI 分析
  python cli.py BV1cmofByENF -c --all --browser-cookie edge
"""

import argparse
import asyncio
import io
import json
import logging
import sys
from pathlib import Path

from bilibili import config
from bilibili.analysis import (
    AIConfig,
    analyze_comments,
    analyze_danmaku,
    danmaku_word_cloud,
    summarize_subtitle,
)
from bilibili.browser_cookie import get_browser_cookie
from bilibili.client import BiliClient
from bilibili.config import LOG_LEVEL
from bilibili.formatters import (
    COMMENT_FORMATS,
    DANMAKU_FORMATS,
    normalize_fmt,
    save_analysis,
)
from bilibili.utils import extract_bvid
from bilibili.auth import parse_cookie
from bilibili.danmaku import get_danmaku
from bilibili.comments import get_all_comments, get_comments
from bilibili.subtitle import get_subtitle

# 非字幕格式 → 字幕保存时的兜底格式
_SUBTITLE_FMT_MAP = {"txt": "srt", "csv": "srt"}


def _ensure_utf8_stream(stream):
    """仅当流编码非 UTF-8 时包装，避免中文乱码（pytest 等环境已是 UTF-8 时不误替换）"""
    try:
        enc = getattr(stream, "encoding", None)
        if (enc is None or "utf" not in enc.lower()) and hasattr(stream, "buffer"):
            return io.TextIOWrapper(stream.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass
    return stream


sys.stdout = _ensure_utf8_stream(sys.stdout)
sys.stderr = _ensure_utf8_stream(sys.stderr)


def _subtitle_fmt(save_fmt: str) -> str:
    """字幕格式映射：txt/csv 对字幕不适用，兜底为 srt"""
    return _SUBTITLE_FMT_MAP.get(save_fmt, save_fmt) if save_fmt else "srt"


def _danmaku_fmt(save_fmt) -> str | None:
    """弹幕格式归一化：srt/ass/lrc 等对弹幕不适用，兜底为 txt"""
    return normalize_fmt(save_fmt, DANMAKU_FORMATS) if save_fmt else None


def _comment_fmt(save_fmt) -> str | None:
    """评论格式归一化：srt/ass/lrc 等对评论不适用，兜底为 txt"""
    return normalize_fmt(save_fmt, COMMENT_FORMATS) if save_fmt else None


def parse_args():
    p = argparse.ArgumentParser(
        description="B站 弹幕+评论(+回复)+字幕 爬取工具（v2: WBI签名/seg.so全量/三级降级）",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog="""示例:
  python cli.py BV1cmofByENF -dc --all --replies --save json
  python cli.py BV1cmofByENF -d --cloud                 # 弹幕 + 热词
  python cli.py BV1cmofByENF -c --all --browser-cookie edge
  python cli.py BV1cmofByENF -d -c -s --ai --ai-key sk-xxx
  python cli.py BV1cmofByENF --save txt
  python cli.py BV1cmofByENF -s --sub-lan en --save srt
                        """,
    )
    p.add_argument("bvid", help="视频BV号 / 完整B站URL / b23.tv短链")
    p.add_argument("-d", "--danmaku", action="store_true", help="获取弹幕")
    p.add_argument("-c", "--comments", action="store_true", help="获取评论")
    p.add_argument("-dc", action="store_true", dest="both", help="弹幕+评论")
    p.add_argument("-s", "--subtitle", action="store_true", dest="subtitle", help="获取字幕")
    p.add_argument("--sub-lan", default="", help="字幕语言代码 (如 ai-zh, en, ja; 默认自动选择)")
    p.add_argument("--all", action="store_true", dest="all_pages", help="全量翻页评论")
    p.add_argument("--replies", action="store_true", help="同时提取评论的回复(楼中楼)")
    p.add_argument("--page", type=int, default=1, help="评论起始页码 (默认1)")
    p.add_argument("--max-pages", type=int, default=0, help="目标页数, 0=全部 (默认0)")
    p.add_argument("--max-comments", type=int, default=0,
                   help="评论条数上限(滑动窗口), 达到立即停止, 0=不限 (默认0)")
    p.add_argument("--cloud", action="store_true", help="统计弹幕热词并保存 cloud_<bvid>.json")
    p.add_argument("--ai", action="store_true",
                   help="AI 分析已抓取数据（需 --ai-key 或环境变量 BILI_AI_KEY）")
    p.add_argument("--ai-key", default="", help="AI API Key（默认读 BILI_AI_KEY）")
    p.add_argument("--ai-base", default="", help="AI 接口地址（默认读 BILI_AI_BASE_URL）")
    p.add_argument("--ai-model", default="", help="AI 模型（默认读 BILI_AI_MODEL）")
    p.add_argument("--ai-max-tokens", type=int, default=0, help="AI 单次回复 token 上限")
    p.add_argument("--no-ai-stream", action="store_true", help="AI 非流式输出")
    p.add_argument("--max-age", type=int, default=30, help="缓存有效期秒, 0=禁用 (默认30)")
    p.add_argument(
        "--save",
        choices=["txt", "json", "csv", "srt", "ass", "lrc"],
        default=None,
        help="保存到文件 (字幕支持 srt/ass/lrc/json)",
    )
    cookie_group = p.add_mutually_exclusive_group()
    cookie_group.add_argument("--cookie", default="", help="手动传入 Cookie (含SESSDATA)")
    cookie_group.add_argument("--browser-cookie", dest="browser_cookie",
                              type=str.lower, choices=("chrome", "edge", "firefox"),
                              default=None,
                              help="自动从本机浏览器提取 B 站 Cookie (chrome/edge/firefox)")
    p.add_argument("--output-dir", default="", help="输出目录 (默认: 项目根目录)")
    p.add_argument("--no-cache", action="store_true", help="禁用缓存 (等价 --max-age 0)")
    return p.parse_args()


async def _run_ai_tasks(args, bvid: str, client: BiliClient, dms, sub, comments) -> None:
    """AI 分析已抓取数据（弹幕/字幕/评论），结果保存为 .md"""
    import os

    key = args.ai_key or os.environ.get("BILI_AI_KEY", "")
    if not key:
        logging.error("[AI] 未配置 API Key（--ai-key 或环境变量 BILI_AI_KEY）")
        return
    ai_cfg = AIConfig(
        base_url=args.ai_base or os.environ.get("BILI_AI_BASE_URL", "https://api.deepseek.com"),
        api_key=key,
        model=args.ai_model or os.environ.get("BILI_AI_MODEL", "deepseek-chat"),
        max_tokens=args.ai_max_tokens or int(os.environ.get("BILI_AI_MAX_TOKENS", "4000")),
        stream=not args.no_ai_stream,
    )

    def on_chunk(kind: str):
        def _cb(chunk, full):
            logging.info("\r🤖 [%s] %s", kind, full[-120:].replace("\n", " "))

        return _cb

    if dms is not None:
        logging.info("[AI] 正在分析弹幕 (%d 条)...", len(dms))
        result = await analyze_danmaku(dms, cfg=ai_cfg, on_chunk=on_chunk("弹幕"))
        save_analysis(result["content"], bvid, "analysis", "md")
        logging.info("[AI] 弹幕分析完成")
    if sub is not None:
        logging.info("[AI] 正在总结字幕 (%d 条)...", len(sub.lines))
        result = await summarize_subtitle(sub, cfg=ai_cfg, on_chunk=on_chunk("字幕"))
        save_analysis(result["content"], bvid, "summary", "md")
        logging.info("[AI] 字幕总结完成")
    if comments is not None:
        logging.info("[AI] 正在分析评论 (%d 条)...", len(comments))
        result = await analyze_comments(comments, cfg=ai_cfg, on_chunk=on_chunk("评论"))
        save_analysis(result["content"], bvid, "analysis_comments", "md")
        logging.info("[AI] 评论分析完成")


async def main() -> int:
    args = parse_args()
    try:
        bvid = extract_bvid(args.bvid)
    except ValueError as e:
        logging.error("%s", e)
        return 2

    credential = None
    if args.browser_cookie:
        try:
            credential = parse_cookie(get_browser_cookie(args.browser_cookie))
        except Exception as e:
            logging.error("[Cookie] 从 %s 提取失败: %s", args.browser_cookie, e)
            return 2
    else:
        credential = parse_cookie(args.cookie)
    max_age = 0 if args.no_cache else args.max_age

    if args.output_dir:
        config.OUTPUT_DIR = Path(args.output_dir).expanduser().resolve()
    config.ensure_dirs()

    # 判断要执行的操作
    do_danmaku = args.danmaku or args.both
    do_comments = args.comments or args.both
    do_subtitle = args.subtitle

    # 如果没有指定任何操作，默认全部执行
    if not (do_danmaku or do_comments or do_subtitle or args.all_pages):
        do_danmaku = True
        do_comments = True
        do_subtitle = True

    failed = False
    dms = sub = comments = None  # AI 分析输入

    # 全程复用同一个 HTTP 客户端（会话复用 + 一次服务器时间校准）
    async with BiliClient(credential=credential) as client:
        if do_danmaku:
            try:
                dms = await get_danmaku(
                    bvid, max_age=max_age, credential=credential,
                    save_fmt=_danmaku_fmt(args.save), client=client,
                )
                if args.cloud and dms:
                    words = danmaku_word_cloud(dms)
                    save_analysis(
                        json.dumps(words, ensure_ascii=False, indent=2),
                        bvid, "cloud", "json",
                    )
                    logging.info("[热词] %d 个: %s",
                                 len(words), ", ".join(f"{w['word']}({w['count']})" for w in words[:10]))
            except Exception as e:
                logging.error("[弹幕] 失败: %s", e)
                failed = True

        if do_subtitle:
            try:
                sub = await get_subtitle(
                    bvid,
                    page_index=0,
                    credential=credential,
                    lan_code=args.sub_lan,
                    save_fmt=_subtitle_fmt(args.save),
                    client=client,
                )
            except Exception as e:
                logging.error("[字幕] 失败: %s（部分视频字幕需要登录 Cookie，请加 --cookie）", e)
                failed = True

        if do_comments or args.all_pages:
            try:
                if args.all_pages or args.max_pages or args.max_comments:
                    comments = await get_all_comments(
                        bvid,
                        max_age=max_age,
                        credential=credential,
                        save_fmt=_comment_fmt(args.save),
                        with_replies=args.replies,
                        max_pages=args.max_pages,
                        max_comments=args.max_comments,
                        client=client,
                    )
                else:
                    comments = await get_comments(
                        bvid,
                        page=args.page,
                        max_age=max_age,
                        credential=credential,
                        save_fmt=_comment_fmt(args.save),
                        with_replies=args.replies,
                        client=client,
                    )
            except Exception as e:
                logging.error("[评论] 失败: %s", e)
                failed = True

        if args.ai:
            await _run_ai_tasks(args, bvid, client, dms, sub, comments)

    logging.info("[完成] 输出目录: %s", config.OUTPUT_DIR)
    if max_age > 0:
        logging.info("[缓存] %s", config.CACHE_DIR)
    return 1 if failed else 0


def run() -> int:
    """console script 入口（pyproject: bili = "cli:run"）"""
    logging.basicConfig(
        level=getattr(logging, LOG_LEVEL, logging.INFO),
        format="%(message)s",
    )
    try:
        return asyncio.run(main())
    except KeyboardInterrupt:
        logging.error("[中断] 用户取消")
        return 130


if __name__ == "__main__":
    sys.exit(run())
