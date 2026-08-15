"""seg.so protobuf 最小解析器测试"""

import pytest

from bilibili.proto import parse_dm_seg


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _field_varint(field: int, value: int) -> bytes:
    return _varint((field << 3) | 0) + _varint(value)


def _field_bytes(field: int, data: bytes) -> bytes:
    return _varint((field << 3) | 2) + _varint(len(data)) + data


def _dm_elem(progress_ms, text, mode=1, font_size=25, color=16777215, mid="", ctime=1710000000):
    body = (
        _field_varint(2, progress_ms)   # progress（毫秒）
        + _field_varint(3, mode)
        + _field_varint(4, font_size)
        + _field_varint(5, color)
        + _field_bytes(6, mid.encode())
        + _field_bytes(7, text.encode())
        + _field_varint(8, ctime)
    )
    return _field_bytes(1, body)


class TestParseDmSeg:
    def test_empty(self):
        assert parse_dm_seg(b"") == []

    def test_single(self):
        buf = _dm_elem(1500, "你好", mid="10086")
        dms = parse_dm_seg(buf)
        assert len(dms) == 1
        dm = dms[0]
        assert dm.dm_time == 1.5          # 毫秒 → 秒
        assert dm.text == "你好"
        assert dm.mode == 1
        assert dm.font_size == 25
        assert dm.color == 16777215
        assert dm.uid == "10086"
        assert dm.ctime == 1710000000

    def test_multiple_ordered(self):
        buf = _dm_elem(1000, "a") + _dm_elem(2000, "b") + _dm_elem(3000, "c")
        dms = parse_dm_seg(buf)
        assert [d.text for d in dms] == ["a", "b", "c"]
        assert [d.dm_time for d in dms] == [1.0, 2.0, 3.0]

    def test_empty_text_skipped(self):
        buf = _dm_elem(1000, "")
        assert parse_dm_seg(buf) == []

    def test_unknown_wire_type_skips(self):
        # 带一个未知 wire type=3（group）的字段，解析应跳过不崩溃
        buf = _dm_elem(1000, "ok") + _varint((9 << 3) | 3)
        dms = parse_dm_seg(buf)
        assert len(dms) == 1
        assert dms[0].text == "ok"

    def test_truncated_does_not_crash(self):
        buf = _dm_elem(1000, "abc")[:5]
        # 截断数据不应抛异常（容忍坏数据）
        parse_dm_seg(buf)
