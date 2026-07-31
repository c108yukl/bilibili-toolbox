"""文件保存格式与命名测试"""

import csv
import json

import pytest

from bilibili import config
from bilibili.formatters import save_comments, save_danmaku

config.OUTPUT_DIR = config.PROJECT_ROOT / ".bili_output_test"


class DummySubtitle:
    def to_srt(self):
        return "1\n00:00:00,000 --> 00:00:02,000\n你好\n\n"


@pytest.fixture(autouse=True)
def _clean_output(tmp_path):
    import shutil

    if config.OUTPUT_DIR.exists():
        shutil.rmtree(config.OUTPUT_DIR)
    config.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    yield
    if config.OUTPUT_DIR.exists():
        shutil.rmtree(config.OUTPUT_DIR)


def _comments():
    return [
        {
            "comment": {
                "like": 5,
                "member": {"uname": "用户A"},
                "ctime": 1700000000,
                "content": {"message": "第一条评论"},
                "rcount": 1,
                "rpid": 1001,
            },
            "replies": [
                {
                    "like": 2,
                    "member": {"uname": "用户B"},
                    "ctime": 1700000100,
                    "content": {"message": "回复A"},
                    "parent": 1001,
                    "members": {1001: {"uname": "用户A"}},
                    "rpid": 2001,
                }
            ],
        }
    ]


def _danmaku():
    return [
        {"time": 1.5, "text": "哈哈", "mode": 1, "font_size": 25, "color": 16777215, "uid": 123},
        {"time": 2.0, "text": "前排", "mode": 4, "font_size": 25, "color": 16711680, "uid": 456},
    ]


class TestSaveDanmaku:
    def test_txt(self):
        save_danmaku(_danmaku(), "BV1TESTTEST1", "txt")
        out = config.OUTPUT_DIR / "danmaku_BV1TESTTEST1.txt"
        content = out.read_text(encoding="utf-8")
        assert "1.5s" in content and "哈哈" in content
        assert "2.0s" in content and "前排" in content

    def test_json(self):
        save_danmaku(_danmaku(), "BV1TESTTEST1", "json")
        out = config.OUTPUT_DIR / "danmaku_BV1TESTTEST1.json"
        data = json.loads(out.read_text(encoding="utf-8"))
        assert data[0]["time_s"] == 1.5
        assert data[1]["text"] == "前排"

    def test_csv(self):
        save_danmaku(_danmaku(), "BV1TESTTEST1", "csv")
        out = config.OUTPUT_DIR / "danmaku_BV1TESTTEST1.csv"
        with out.open(encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        assert rows[0]["text"] == "哈哈"

    def test_duplicate_renamed(self):
        save_danmaku(_danmaku(), "BV1TESTTEST1", "txt")
        save_danmaku(_danmaku(), "BV1TESTTEST1", "txt")
        assert (config.OUTPUT_DIR / "danmaku_BV1TESTTEST1.txt").exists()
        assert (config.OUTPUT_DIR / "danmaku_BV1TESTTEST1_1.txt").exists()


class TestSaveComments:
    def test_json_contains_replies(self):
        save_comments(_comments(), "BV1TESTTEST1", "json")
        out = config.OUTPUT_DIR / "comments_BV1TESTTEST1.json"
        data = json.loads(out.read_text(encoding="utf-8"))
        assert data[0]["uname"] == "用户A"
        assert data[0]["replies"][0]["reply_to"] == "用户A"

    def test_txt(self):
        save_comments(_comments(), "BV1TESTTEST1", "txt")
        out = config.OUTPUT_DIR / "comments_BV1TESTTEST1.txt"
        content = out.read_text(encoding="utf-8")
        assert "第一条评论" in content
        assert "回复A" in content

    def test_csv_levels(self):
        save_comments(_comments(), "BV1TESTTEST1", "csv")
        out = config.OUTPUT_DIR / "comments_BV1TESTTEST1.csv"
        with out.open(encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        assert rows[0]["level"] == "comment"
        assert rows[1]["level"] == "reply"
