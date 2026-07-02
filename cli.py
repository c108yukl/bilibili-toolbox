"""
B站 弹幕+评论(+回复)+字幕 爬取工具 - CLI 入口

用法:
  python cli.py BV1cmofByENF -dc --all --replies --save json
  python cli.py BV1cmofByENF -c --all --replies --cookie "SESSDATA=xxx"
  python cli.py BV1cmofByENF -d --save csv
  python cli.py BV1cmofByENF -s --sub-lan en --save srt
"""

import sys
import io
import asyncio
import argparse

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from bilibili import (
    extract_bvid,
    parse_cookie,
    get_danmaku,
    get_comments,
    get_all_comments,
    get_subtitle,
)
from bilibili.cache import CACHE_DIR


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
    p.add_argument("bvid", help="视频BV号 / 完整B站URL")
    p.add_argument("-d", "--danmaku", action="store_true", help="获取弹幕")
    p.add_argument("-c", "--comments", action="store_true", help="获取评论")
    p.add_argument("-dc", action="store_true", dest="both", help="弹幕+评论")
    p.add_argument("-s", "--subtitle", action="store_true", dest="subtitle", help="获取字幕")
    p.add_argument("--sub-lan", default="", help="字幕语言代码 (如 ai-zh, en, ja; 默认自动选择)")
    p.add_argument("--all", action="store_true", dest="all_pages", help="全量翻页评论")
    p.add_argument("--replies", action="store_true", help="同时提取评论的回复(楼中楼)")
    p.add_argument("--page", type=int, default=1, help="评论起始页码 (默认1)")
    p.add_argument("--max-pages", type=int, default=0, help="目标页数, 0=全部 (默认0)")
    p.add_argument("--max-age", type=int, default=30, help="缓存有效期秒, 0=禁用 (默认30)")
    p.add_argument(
        "--save",
        choices=["txt", "json", "csv", "srt", "ass", "lrc"],
        default=None,
        help="保存到文件 (字幕支持 srt/ass/lrc/json)",
    )
    p.add_argument("--cookie", default="", help="Cookie (含SESSDATA)")
    return p.parse_args()


async def main():
    args = parse_args()
    bvid = extract_bvid(args.bvid)
    credential = parse_cookie(args.cookie)
    max_age = args.max_age if args.max_age > 0 else 0

    # 判断要执行的操作
    do_danmaku = args.danmaku or args.both
    do_comments = args.comments or args.both
    do_subtitle = args.subtitle

    # 如果没有指定任何操作，默认全部执行
    if not (do_danmaku or do_comments or do_subtitle or args.all_pages):
        do_danmaku = True
        do_comments = True
        do_subtitle = True

    if do_danmaku:
        await get_danmaku(bvid, max_age=max_age, credential=credential, save_fmt=args.save)

    if do_subtitle:
        await get_subtitle(
            bvid,
            page_index=0,
            credential=credential,
            lan_code=args.sub_lan,
            save_fmt=args.save or "srt",
        )

    if do_comments or args.all_pages:
        if args.all_pages or args.max_pages:
            await get_all_comments(
                bvid,
                max_age=max_age,
                credential=credential,
                save_fmt=args.save,
                with_replies=args.replies,
                max_pages=args.max_pages,
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

    if max_age > 0:
        print(f"\n[缓存] {CACHE_DIR}")


if __name__ == "__main__":
    asyncio.run(main())
