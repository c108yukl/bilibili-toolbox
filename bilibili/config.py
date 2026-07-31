"""
配置模块 - 集中管理所有可调参数

所有配置项均可通过环境变量覆盖（前缀 BILI_）:
  BILI_OUTPUT_DIR  输出目录
  BILI_CACHE_DIR   缓存目录
  BILI_TIMEOUT     API 请求超时（秒）
  BILI_RATE_DELAY  分页请求间隔（秒）
  BILI_LOG_LEVEL   日志级别 (DEBUG/INFO/WARNING/ERROR)
"""

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _env(name: str, default: str) -> str:
    return os.environ.get(f"BILI_{name}", default)


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


# ─── 路径 ────────────────────────────────────────────────
OUTPUT_DIR = Path(_env("OUTPUT_DIR", str(PROJECT_ROOT))).expanduser().resolve()
CACHE_DIR = Path(_env("CACHE_DIR", str(PROJECT_ROOT / ".bili_cache"))).expanduser().resolve()

# ─── 网络 ────────────────────────────────────────────────
TIMEOUT = _env_int("TIMEOUT", 15)          # 单次请求超时（秒）
RATE_DELAY = _env_int("RATE_DELAY", 500)   # 评论分页间隔（毫秒）
REPLY_DELAY = _env_int("REPLY_DELAY", 300) # 楼中楼请求间隔（毫秒）

# ─── 限制 ────────────────────────────────────────────────
MAX_COMMENTS = 10000  # 全量评论安全上限
REPLY_PAGE_SIZE = 20  # 楼中楼单页条数

# ─── 缓存 ────────────────────────────────────────────────
DEFAULT_CACHE_AGE = 30  # 默认缓存有效期（秒）

# ─── 日志 ────────────────────────────────────────────────
LOG_LEVEL = _env("LOG_LEVEL", "INFO").upper()

# ─── 其他 ────────────────────────────────────────────────
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def ensure_dirs() -> None:
    """确保输出与缓存目录存在"""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
