"""缓存读写测试"""

import time

from bilibili import config
from bilibili.cache import cache_clear, cache_get, cache_key, cache_set

config.CACHE_DIR = config.PROJECT_ROOT / ".bili_cache_test"


def _key() -> str:
    return cache_key("TEST", "unit", 0)


class TestCache:
    def setup_method(self):
        cache_clear(0)

    def teardown_method(self):
        cache_clear(0)

    def test_set_get(self):
        cache_set(_key(), {"a": 1}, max_age=60)
        assert cache_get(_key(), 60) == {"a": 1}

    def test_expired(self):
        cache_set(_key(), {"a": 1}, max_age=-1)  # max_age<=0 不写入
        assert cache_get(_key(), 60) is None

    def test_age_expiry(self):
        cache_set(_key(), {"a": 1}, max_age=60)
        # 手动把缓存时间改旧
        path = config.CACHE_DIR / f"{_key()}.json"
        import json

        data = json.loads(path.read_text(encoding="utf-8"))
        data["_cached_at"] = time.time() - 120
        path.write_text(json.dumps(data), encoding="utf-8")
        assert cache_get(_key(), 60) is None

    def test_disabled_when_max_age_zero(self):
        # max_age=0：读不到也不写入
        cache_set(_key(), {"a": 1}, max_age=0)
        assert not (config.CACHE_DIR / f"{_key()}.json").exists()
        assert cache_get(_key(), 0) is None

    def test_corrupt_file(self):
        path = config.CACHE_DIR / f"{_key()}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")
        assert cache_get(_key(), 60) is None
        assert not path.exists()

    def test_key_deterministic(self):
        assert cache_key("BV1cmofByENF", "danmaku", 0) == cache_key("BV1cmofByENF", "danmaku", 0)
