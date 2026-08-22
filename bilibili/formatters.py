"""
数据格式化与文件保存模块

特性:
- 输出目录由 bilibili.config.OUTPUT_DIR 控制（支持运行时动态覆盖）
- 文件重名自动加 _1/_2 后缀，不覆盖已有文件
- 弹幕入参统一为 dict 列表（与 bilibili.danmaku 返回结构一致）
"""

import csv
import json
import logging
from datetime import datetime
from pathlib import Path

from bilibili import config

logger = logging.getLogger(__name__)

# 各数据类型支持的保存格式；不支持时归一化为 fallback，避免
# 生成"扩展名与实际内容不符"的文件（如弹幕存成 .srt 实为纯文本）
DANMAKU_FORMATS = {"txt", "json", "csv"}
COMMENT_FORMATS = {"txt", "json", "csv"}
SUBTITLE_FORMATS = {"srt", "ass", "lrc", "json"}


def normalize_fmt(fmt: str, supported: set, fallback: str = "txt") -> str:
    """将用户选择的格式归一化为该数据类型实际支持的格式"""
    fmt = (fmt or "").strip().lower()
    return fmt if fmt in supported else fallback


def fmt_time(ts: int) -> str:
    """Unix 时间戳 → 可读时间字符串"""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def _unique_path(path: Path) -> Path:
    """重名时追加 _1/_2 后缀，返回不冲突的路径"""
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    for i in range(1, 1000):
        candidate = path.with_name(f"{stem}_{i}{suffix}")
        if not candidate.exists():
            return candidate
    return path


# ─── 评论格式化 ───────────────────────────────────────────

def format_comment(c: dict) -> dict:
    """将原始评论字典转为精简格式"""
    return {
        "like": c.get("like", 0),
        "uname": (c.get("member") or {}).get("uname", ""),
        "time": fmt_time(c.get("ctime", 0)),
        "text": (c.get("content") or {}).get("message", ""),
        "reply_count": c.get("rcount", 0),
        "rpid": c.get("rpid", 0),
    }


def format_reply(r: dict) -> dict:
    """将原始回复字典转为精简格式"""
    parent_uname = ""
    if r.get("parent") and r.get("members"):
        parent_uname = (r.get("members") or {}).get(r["parent"], {}).get("uname", "")
    return {
        "like": r.get("like", 0),
        "uname": (r.get("member") or {}).get("uname", ""),
        "time": fmt_time(r.get("ctime", 0)),
        "text": (r.get("content") or {}).get("message", ""),
        "reply_to": parent_uname,
        "rpid": r.get("rpid", 0),
    }


# ─── 评论保存 ─────────────────────────────────────────────

def save_comments(comments_with_replies: list, bvid: str, fmt: str = "txt") -> None:
    """
    保存评论到文件
    comments_with_replies: [{"comment": {...}, "replies": [...]}, ...]
    """
    config.ensure_dirs()
    fmt = normalize_fmt(fmt, COMMENT_FORMATS)
    title = f"comments_{bvid}"
    out = _unique_path(config.OUTPUT_DIR / f"{title}.{fmt}")

    if fmt == "json":
        rows = []
        for item in comments_with_replies:
            c = format_comment(item["comment"])
            c["replies"] = [format_reply(r) for r in item.get("replies", [])]
            rows.append(c)
        out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    elif fmt == "csv":
        rows = []
        for item in comments_with_replies:
            c = format_comment(item["comment"])
            rows.append({**c, "level": "comment", "reply_to": ""})
            for r in item.get("replies", []):
                rows.append(
                    {
                        **format_reply(r),
                        "level": "reply",
                        "reply_count": "",
                        "rpid": r.get("rpid", 0),
                    }
                )
        with out.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(
                f,
                fieldnames=[
                    "level", "like", "uname", "time", "text",
                    "reply_count", "reply_to", "rpid",
                ],
            )
            w.writeheader()
            w.writerows(rows)

    else:  # txt
        lines = []
        for item in comments_with_replies:
            c = item["comment"]
            lines.append(f"[+{c.get('like', 0)}] {(c.get('member') or {}).get('uname', '')}: "
                         f"{(c.get('content') or {}).get('message', '')}")
            for r in item.get("replies", []):
                runame = (r.get('member') or {}).get('uname', '')
                lines.append(f"  ↳[+{r.get('like', 0)}] {runame}: "
                             f"{(r.get('content') or {}).get('message', '')}")
        out.write_text("\n".join(lines), encoding="utf-8")

    total_c = len(comments_with_replies)
    total_r = sum(len(item.get("replies", [])) for item in comments_with_replies)
    logger.info("   -> 已保存 %s (评论%d, 回复%d)", out.name, total_c, total_r)


# ─── 弹幕保存 ─────────────────────────────────────────────

def save_danmaku(dms: list, bvid: str, fmt: str = "txt") -> None:
    """保存弹幕到文件。dms 为 dict 列表（见 bilibili.danmaku 返回结构）"""
    config.ensure_dirs()
    fmt = normalize_fmt(fmt, DANMAKU_FORMATS)
    title = f"danmaku_{bvid}"
    out = _unique_path(config.OUTPUT_DIR / f"{title}.{fmt}")

    if fmt == "json":
        rows = [
            {
                "time_s": round(d["time"], 1),
                "text": d["text"],
                "mode": d["mode"],
                "font_size": d["font_size"],
                "color": d["color"],
                "uid": d["uid"],
            }
            for d in dms
        ]
        out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    elif fmt == "csv":
        with out.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(
                f, fieldnames=["time_s", "text", "mode", "font_size", "color", "uid"]
            )
            w.writeheader()
            w.writerows(
                [
                    {
                        "time_s": round(d["time"], 1),
                        "text": d["text"],
                        "mode": d["mode"],
                        "font_size": d["font_size"],
                        "color": d["color"],
                        "uid": d["uid"],
                    }
                    for d in dms
                ]
            )

    else:  # txt
        out.write_text("\n".join(f"[{d['time']:7.1f}s] {d['text']}" for d in dms), encoding="utf-8")

    logger.info("   -> 已保存 %s (%d 条)", out.name, len(dms))


# ─── 字幕保存 ─────────────────────────────────────────────

def save_subtitle(sub_obj, bvid: str, lan_code: str, fmt: str = "srt") -> None:
    """保存字幕到文件（srt/ass/lrc/json）"""
    config.ensure_dirs()
    fmt = normalize_fmt(fmt, SUBTITLE_FORMATS, fallback="srt")
    title = f"subtitle_{bvid}_{lan_code}"
    out = _unique_path(config.OUTPUT_DIR / f"{title}.{fmt}")

    if fmt == "ass":
        text = sub_obj.to_ass()
    elif fmt == "lrc":
        text = sub_obj.to_lrc()
    elif fmt == "json":
        data = sub_obj.to_simple_json()
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info("   -> 已保存 %s (%d 条字幕)", out.name, len(data))
        return
    else:  # srt
        text = sub_obj.to_srt()

    out.write_text(text, encoding="utf-8")
    # SRT 块之间以空行分隔，最后一块后无空行，用 split 计数避免少 1
    count = len([b for b in text.strip().split("\n\n") if b.strip()])
    logger.info("   -> 已保存 %s (%d 条字幕)", out.name, count)


# ─── AI 分析保存 ──────────────────────────────────────────

def save_analysis(content: str, bvid: str, kind: str = "analysis", fmt: str = "md",
                  extra: dict | None = None) -> None:
    """
    保存 AI 分析结果（md/json）

    Args:
        content: 分析正文
        bvid: 视频BV号
        kind: 种类标识（analysis / summary / analysis_comments）
        fmt: md 或 json
        extra: json 模式下附加的元数据（标题/时间戳等）
    """
    import time as _time

    config.ensure_dirs()
    fmt = normalize_fmt(fmt, {"md", "json"}, fallback="md")
    out = _unique_path(config.OUTPUT_DIR / f"{kind}_{bvid}.{fmt}")
    if fmt == "json":
        payload = {"bvid": bvid, "generated_at": _time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                   "analysis": content, **(extra or {})}
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        out.write_text(content, encoding="utf-8")
    logger.info("   -> 已保存 %s", out.name)
