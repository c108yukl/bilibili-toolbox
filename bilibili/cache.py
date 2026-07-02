"""
缓存模块 - 基于文件的 JSON 缓存
"""

import json
import time
import hashlib
from pathlib import Path

CACHE_DIR = Path(__file__).resolve().parent.parent / ".bili_cache"
CACHE_DIR.mkdir(exist_ok=True)


def cache_key(bvid: str, dtype: str, page: int = 0) -> str:
    """生成缓存键 (MD5 哈希)"""
    return hashlib.md5(f"{bvid}:{dtype}:{page}".encode()).hexdigest()


def cache_get(key: str, max_age: int):
    """读取缓存，过期则删除并返回 None"""
    path = CACHE_DIR / f"{key}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if time.time() - data.get("_cached_at", 0) > max_age:
        path.unlink()
        return None
    return data.get("payload")


def cache_set(key: str, payload, max_age: int):
    """写入缓存"""
    path = CACHE_DIR / f"{key}.json"
    path.write_text(
        json.dumps(
            {"_cached_at": time.time(), "max_age": max_age, "payload": payload},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
