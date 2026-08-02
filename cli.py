"""
B站 弹幕+评论(+回复)+字幕 爬取工具 - CLI 入口

用法:
  python cli.py BV1cmofByENF -dc --all --replies --save json
  python cli.py BV1cmofByENF -c --all --replies --cookie "SESSDATA=xxx"
  python cli.py BV1cmofByENF -d --save csv
  python cli.py BV1cmofByENF -s --sub-lan en --save srt
  python cli.py BV1cmofByENF --output-dir ./output
"""

import argparse
import asyncio
import io
import logging
import sys


def _ensure_utf8_stream(stream):
    """仅当流编码非 UTF-8 时包装，避免中文乱码。

    加 encoding/hasattr 双保险，避免在 pytest 等环境（已是 UTF-8 包装）下误替换。
    """
    try:
        enc = getattr(stream, "encoding", None)
        if (enc is None or "utf" not in enc.lower()) and hasattr(stream, "buffer"):
            return io.TextIOWrapper(stream.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass
    return stream


sys.stdout = _ensure_utf8_stream(sys.stdout)
sys.stderr = _ensure_utf8_stream(sys.stderr)

from bilibili import (
    extract_bvid,
    get_all_comments,
    get_comments,
    get_danmaku,
    get_subtitle,
    parse_cookie,
)
from bilibili import config
from bilibili.config import LOG_LEVEL

# 非字幕格式 → 字幕保存时的兜底格式
_SUBTITLE_FMT_MAP = {"txt": "srt", "csv": "srt"}


def parse_args():
    p = argparse.ArgumentParser(
        description="B站 弹幕+评论(+回复)+字幕 爬取工具",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog="""示例:
  python cli.py BV1cmofByENF -dc --all --replies --save json
  python cli.py BV1cmofByENF -c --all --replies --cookie "SESSDATA=xxx"
  python cli.py BV1cmofByENF -d --save csv
  python cli.py BV1cmofByENF --save txt
  python cli.py BV1cmofByENF -s --sub-lan en --save srt
  python cli.py BV1cmofByENF -s --save ass
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
    p.add_argument("--max-age", type=int, default=30, help="缓存有效期秒, 0=禁用 (默认30)")
    p.add_argument(
        "--save",
        choices=["txt", "json", "csv", "srt", "ass", "lrc"],
        default=None,
        help="保存到文件 (字幕支持 srt/ass/lrc/json)",
    )
    p.add_argument("--cookie", default="", help="Cookie (含SESSDATA)")
    p.add_argument("--output-dir", default="", help="输出目录 (默认: 项目根目录)")
    p.add_argument("--no-cache", action="store_true", help="禁用缓存 (等价 --max-age 0)")
    return p.parse_args()


def _subtitle_fmt(save_fmt: str) -> str:
    """字幕格式映射：txt/csv 对字幕不适用，兜底为 srt"""
    return _SUBTITLE_FMT_MAP.get(save_fmt, save_fmt) if save_fmt else "srt"


async def main() -> int:
    args = parse_args()
    try:
        bvid = extract_bvid(args.bvid)
    except ValueError as e:
        logging.error("%s", e)
        return 2
    credential = parse_cookie(args.cookie)
    max_age = 0 if args.no_cache else args.max_age

    if args.output_dir:
        from pathlib import Path

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

    if do_danmaku:
        try:
            await get_danmaku(bvid, max_age=max_age, credential=credential, save_fmt=args.save)
        except Exception as e:
            logging.error("[弹幕] 失败: %s", e)
            failed = True

    if do_subtitle:
        try:
            await get_subtitle(
                bvid,
                page_index=0,
                credential=credential,
                lan_code=args.sub_lan,
                save_fmt=_subtitle_fmt(args.save),
            )
        except Exception as e:
            logging.error("[字幕] 失败: %s（部分视频字幕需要登录 Cookie，请加 --cookie）", e)
            failed = True

    if do_comments or args.all_pages:
        try:
            if args.all_pages or args.max_pages or args.max_comments:
                await get_all_comments(
                    bvid,
                    max_age=max_age,
                    credential=credential,
                    save_fmt=args.save,
                    with_replies=args.replies,
                    max_pages=args.max_pages,
                    max_comments=args.max_comments,
                )
            else:
                await get_comments(
                    bvid,
                    page=args.page,
                    max_age=max_age,
                    credential=credential,
                    save_fmt=args.save,
                    with_replies=args.replies,
                )
        except Exception as e:
            logging.error("[评论] 失败: %s", e)
            failed = True

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
