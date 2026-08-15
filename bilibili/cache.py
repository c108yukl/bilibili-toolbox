"""
缓存模块 - 基于文件的 JSON 缓存

特性:
- 原子写入（临时文件 + 改名），并发安全
- max_age=0 时完全禁用（不读也不写）
- 过期文件按目录清理
- 目录位置动态读取 bilibili.config.CACHE_DIR（便于运行时/测试覆盖）
"""

import hashlib
import json
import logging
import time
import uuid
from pathlib import Path

from bilibili import config

logger = logging.getLogger(__name__)

_CACHE_SUFFIX = ".json"


def cache_key(bvid: str, dtype: str, page: int = 0) -> str:
    """生成缓存键 (MD5 哈希)"""
    return hashlib.md5(f"{bvid}:{dtype}:{page}".encode()).hexdigest()


def _path(key: str) -> Path:
    return config.CACHE_DIR / f"{key}{_CACHE_SUFFIX}"


def cache_get(key: str, max_age: int):
    """读取缓存；过期或缺失返回 None。max_age<=0 表示禁用"""
    if max_age <= 0:
        return None
    path = _path(key)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        logger.warning("缓存文件损坏，删除 %s", path.name)
        path.unlink(missing_ok=True)
        return None
    if time.time() - data.get("_cached_at", 0) > max_age:
        path.unlink(missing_ok=True)
        return None
    return data.get("payload")


def cache_set(key: str, payload, max_age: int) -> None:
    """写入缓存。max_age<=0 时跳过写入"""
    if max_age <= 0:
        return
    config.ensure_dirs()
    path = _path(key)
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    body = json.dumps(
        {"_cached_at": time.time(), "max_age": max_age, "payload": payload},
        ensure_ascii=False,
    )
    try:
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(path)  # 原子替换，避免读到半截文件
    finally:
        tmp.unlink(missing_ok=True)


def cache_clear(max_age: int = 0) -> int:
    """
    清理过期缓存文件；max_age 为 0 时清理全部缓存

    Returns:
        删除的文件数
    """
    if not config.CACHE_DIR.exists():
        return 0
    now = time.time()
    removed = 0
    for f in config.CACHE_DIR.glob(f"*{_CACHE_SUFFIX}"):
        if max_age <= 0:
            f.unlink(missing_ok=True)
            removed += 1
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            f.unlink(missing_ok=True)
            removed += 1
            continue
        if now - data.get("_cached_at", 0) > max_age:
            f.unlink(missing_ok=True)
            removed += 1
    return removed
