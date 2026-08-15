"""
B站工具箱 CLI 入口（兼容薄壳）

实现位于 bilibili/cli.py；本文件仅为保留以下兼容性:
- `python cli.py <bvid>` 直接运行
- `bili` console script（pyproject: bili = "cli:run"）
- 旧测试对 `_danmaku_fmt/_comment_fmt/_subtitle_fmt` 的引用
"""

import sys

from bilibili.cli import (  # noqa: F401  (re-export)
    _comment_fmt,
    _danmaku_fmt,
    _subtitle_fmt,
    main,
    parse_args,
    run,
)

__all__ = ["main", "run", "parse_args", "_danmaku_fmt", "_comment_fmt", "_subtitle_fmt"]

if __name__ == "__main__":
    sys.exit(run())
