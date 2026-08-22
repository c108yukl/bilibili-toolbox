"""
分析与 AI 模块 - 弹幕热词 + OpenAI 兼容 AI 分析（移植扩展能力）

热词:
    danmaku_word_cloud(dms, top_n) → [{"word": str, "count": int}, ...]
    中文二元组 + 拉丁词(≥2位) 抽取，停用词过滤，纯本地计算

AI 分析（OpenAI 兼容 chat/completions）:
    ai_chat(text, prompt, cfg, on_chunk=..., on_reasoning=...) → {"content", "reasoning"}
    - 流式输出（SSE），思考模型 reasoning_content 一并回传
    - {text} 占位符替换；text 截断 20000 字符
    - 便捷封装: analyze_danmaku / summarize_subtitle / analyze_comments

AI 配置（环境变量 BILI_AI_* 或显式 AIConfig）:
    BILI_AI_BASE_URL  默认 https://api.deepseek.com
    BILI_AI_KEY       API Key（无默认）
    BILI_AI_MODEL     默认 deepseek-chat
    BILI_AI_MAX_TOKENS 默认 4000
"""

import asyncio
import json
import logging
import os
import re
import unicodedata
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import aiohttp

from bilibili.config import TIMEOUT, USER_AGENT

logger = logging.getLogger(__name__)

# ─── 热词 ─────────────────────────────────────────────────

# 高频停用词（常见口语/虚词）
CLOUD_STOP_WORDS = frozenset({
    "我们", "你们", "他们", "她们", "这个", "那个", "什么", "怎么", "自己", "可以", "一个",
    "真的", "还是", "没有", "不是", "就是", "现在", "时候", "知道", "已经", "这样", "那样",
    "所以", "但是", "然后", "因为", "如果", "虽然", "而且", "或者", "于是", "不过", "还有",
    "大家", "不要", "不会", "不能", "可能", "应该", "东西", "为什么", "一下", "一会",
    "哈哈哈", "哈哈哈哈", "笑死", "无语", "awsl", "nb", "wc", "yyds",
})

_LATIN_RE = re.compile(r"[a-z0-9]{2,}")
_CJK_RUN_RE = re.compile(r"[\u4e00-\u9fff]{2,}")


def extract_tokens(text: str) -> list[str]:
    """提取文本 token：拉丁词(≥2位) + 中文二元组"""
    norm = unicodedata.normalize("NFKC", str(text or "")).lower()
    tokens: list[str] = []
    for m in _LATIN_RE.findall(norm):
        tokens.append(m)
    for run in _CJK_RUN_RE.findall(norm):
        for i in range(len(run) - 1):
            tokens.append(run[i:i + 2])
    return tokens


def danmaku_word_cloud(dms: list, top_n: int = 30, stop_words=frozenset(CLOUD_STOP_WORDS)) -> list:
    """
    弹幕 → 热词频率 [{"word", "count"}]，按频率降序

    Args:
        dms: 弹幕列表（dict（含 text 字段）或 Danmaku 对象）
        top_n: 返回词数上限
        stop_words: 停用词集合（可覆盖）
    """
    freq: dict = {}
    for d in dms or []:
        text = d.get("text", "") if isinstance(d, dict) else getattr(d, "text", "")
        for token in extract_tokens(text):
            if token in stop_words:
                continue
            if len(token) == 2 and token[0] == token[1]:
                continue  # 哈哈/喔喔 类叠词
            freq[token] = freq.get(token, 0) + 1
    ranked = sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))
    return [{"word": w, "count": c} for w, c in ranked[:top_n]]


# ─── AI 配置 ──────────────────────────────────────────────

@dataclass
class AIConfig:
    """AI 分析配置（缺省读环境变量）"""
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    max_tokens: int = 0
    stream: bool = True
    thinking: bool = True     # 思考模型（reasoner）需关闭 temperature
    temperature: float = 0.4
    timeout: float = 0

    @classmethod
    def from_env(cls) -> "AIConfig":
        return cls(
            base_url=os.environ.get("BILI_AI_BASE_URL", "https://api.deepseek.com"),
            api_key=os.environ.get("BILI_AI_KEY", ""),
            model=os.environ.get("BILI_AI_MODEL", "deepseek-chat"),
            max_tokens=int(os.environ.get("BILI_AI_MAX_TOKENS", "4000") or 4000),
            timeout=float(os.environ.get("BILI_TIMEOUT", str(TIMEOUT)) or TIMEOUT),
        )


def _merged_cfg(cfg: AIConfig | None) -> AIConfig:
    base = AIConfig.from_env()
    if cfg is None:
        return base
    for field_name in ("base_url", "api_key", "model", "max_tokens", "stream",
                       "thinking", "temperature", "timeout"):
        value = getattr(cfg, field_name)
        if value:  # 显式值覆盖环境变量（stream=False / temperature=0 需特判）
            setattr(base, field_name, value)
    if cfg.stream is False:
        base.stream = False
    if cfg.thinking is False:
        base.thinking = False
    return base


def _build_payload(text: str, prompt: str, cfg: AIConfig, *, stream: bool) -> dict:
    content = str(prompt or "").replace("{text}", text or "")
    body = {
        "model": cfg.model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": cfg.max_tokens or 4000,
    }
    if not cfg.thinking:  # 思考模型不支持 temperature
        body["temperature"] = cfg.temperature
    if stream:
        body["stream"] = True
    return body


# ─── AI 调用 ──────────────────────────────────────────────

OnChunk = Callable[[str, str], Awaitable[None] | None]
OnReasoning = Callable[[str, str], Awaitable[None] | None]


async def ai_chat(
    text: str,
    prompt: str,
    cfg: AIConfig | None = None,
    on_chunk: OnChunk | None = None,
    on_reasoning: OnReasoning | None = None,
) -> dict:
    """
    OpenAI 兼容 chat/completions 调用（默认流式，支持思考模型）

    Args:
        text: 待分析文本（替换提示词中的 {text}）
        prompt: 提示词模板
        cfg: AI 配置（None 时读 BILI_AI_* 环境变量）
        on_chunk: 流式正文回调 (chunk, full_text)
        on_reasoning: 流式思考回调 (chunk, full_reasoning)

    Returns:
        {"content": 正文, "reasoning": 思考过程}

    Raises:
        ValueError: 未配置 API Key / 接口错误
    """
    cfg = _merged_cfg(cfg)
    if not cfg.api_key:
        raise ValueError("未配置 AI API Key（设置环境变量 BILI_AI_KEY 或传入 AIConfig.api_key）")
    base = cfg.base_url.rstrip("/")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg.api_key}",
        "User-Agent": USER_AGENT,
    }
    timeout = aiohttp.ClientTimeout(total=cfg.timeout or TIMEOUT)
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        if not cfg.stream:
            body = _build_payload(text, prompt, cfg, stream=False)
            async with session.post(f"{base}/chat/completions", json=body) as resp:
                if resp.status != 200:
                    detail = ""
                    try:
                        detail = ((await resp.json()).get("error") or {}).get("message", "")
                    except Exception:
                        pass
                    raise ValueError(
                        f"AI 接口错误(HTTP {resp.status}){': ' + detail if detail else ''}"
                    )
                data = await resp.json()
            msg = ((data.get("choices") or [{}])[0].get("message")) or {}
            if not msg.get("content"):
                raise ValueError("AI 返回为空")
            return {
                "content": str(msg["content"]).strip(),
                "reasoning": str(msg.get("reasoning_content") or "").strip(),
            }

        # 流式 SSE
        body = _build_payload(text, prompt, cfg, stream=True)
        full = ""
        full_reasoning = ""
        async with session.post(f"{base}/chat/completions", json=body) as resp:
            if resp.status != 200:
                detail = ""
                try:
                    detail = ((await resp.json()).get("error") or {}).get("message", "")
                except Exception:
                    pass
                raise ValueError(
                    f"AI 接口错误(HTTP {resp.status}){': ' + detail if detail else ''}"
                )
            async for raw_line in resp.content:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                    delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
                    if delta.get("reasoning_content"):
                        full_reasoning += delta["reasoning_content"]
                        if on_reasoning:
                            result = on_reasoning(delta["reasoning_content"], full_reasoning)
                            if asyncio.iscoroutine(result):
                                await result
                    if delta.get("content"):
                        full += delta["content"]
                        if on_chunk:
                            result = on_chunk(delta["content"], full)
                            if asyncio.iscoroutine(result):
                                await result
                except (json.JSONDecodeError, KeyError, TypeError):
                    continue
        return {"content": full.strip(), "reasoning": full_reasoning.strip()}


# ─── 文本构建（与扩展一致）──────────────────────────────

def build_danmaku_text(dms: list, max_items: int = 500) -> str:
    """弹幕 → 文本（去重 + 条数上限 + 20000 字符截断）"""
    seen: set = set()
    out: list[str] = []
    for d in dms or []:
        text = d.get("text", "") if isinstance(d, dict) else getattr(d, "text", "")
        text = str(text).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
        if len(out) >= max_items:
            break
    return "\n".join(out)[:20000]


def build_subtitle_text(subs, max_items: int = 0, with_time: bool = False) -> str:
    """字幕 → 文本（条数上限可选；with_time 带时间戳）"""
    items = (subs or [])[:max_items] if max_items > 0 else (subs or [])
    text = "\n".join(
        (f"[{s.from_:.3f}] {s.content}" if with_time else s.content)
        for s in items
    )
    return text[:20000]


def build_comment_text(items: list, max_items: int = 300) -> str:
    """评论 → 文本（去重 + 条数上限 + 每评论最多 3 条回复 + 20000 字符截断）"""
    seen: set = set()
    lines: list[str] = []
    for item in items or []:
        c = (item or {}).get("comment") or {}
        text = str((c.get("content") or {}).get("message", "")).strip()
        if text and text not in seen:
            seen.add(text)
            uname = (c.get('member') or {}).get('uname', '匿名')
            lines.append(f"[赞{c.get('like', 0)}] {uname}: {text}")
        for r in ((item or {}).get("replies") or [])[:3]:
            rtext = str((r.get("content") or {}).get("message", "")).strip()
            if rtext and rtext not in seen:
                seen.add(rtext)
                lines.append(f"  ↳ {(r.get('member') or {}).get('uname', '')}: {rtext}")
        if len(lines) >= max_items:
            break
    return "\n".join(lines)[:20000]


# ─── 便捷封装 ────────────────────────────────────────────

async def analyze_danmaku(
    dms: list,
    prompt: str = "",
    cfg: AIConfig | None = None,
    max_items: int = 500,
    on_chunk: OnChunk | None = None,
    on_reasoning: OnReasoning | None = None,
) -> dict:
    """分析弹幕（默认提示词与扩展一致）"""
    default_prompt = (
        "你是B站弹幕分析助手。请分析以下弹幕（每行一条），用中文输出四部分：\n"
        "1. 弹幕情绪倾向（正面/负面/中立的大致占比）\n"
        "2. 热议话题（弹幕最关注的几个点）\n"
        "3. 名场面 / 高能时刻（被反复刷屏的梗或事件）\n"
        "4. 有趣弹幕精选（最多5条）\n\n弹幕内容：\n{text}"
    )
    text = build_danmaku_text(dms, max_items)
    return await ai_chat(text, prompt or default_prompt, cfg, on_chunk, on_reasoning)


async def summarize_subtitle(
    sub,
    prompt: str = "",
    cfg: AIConfig | None = None,
    max_items: int = 0,
    on_chunk: OnChunk | None = None,
    on_reasoning: OnReasoning | None = None,
) -> dict:
    """总结字幕（默认提示词与扩展一致）"""
    default_prompt = (
        "你是视频字幕分析助手。请用中文总结以下视频字幕，输出三部分：\n"
        "1. 主题概述（2-3句话）\n"
        "2. 核心要点（编号列表）\n"
        "3. 亮点金句（如有）\n\n字幕内容：\n{text}"
    )
    text = build_subtitle_text(getattr(sub, "lines", sub), max_items)
    return await ai_chat(text, prompt or default_prompt, cfg, on_chunk, on_reasoning)


async def analyze_comments(
    items: list,
    prompt: str = "",
    cfg: AIConfig | None = None,
    max_items: int = 300,
    on_chunk: OnChunk | None = None,
    on_reasoning: OnReasoning | None = None,
) -> dict:
    """分析评论（默认提示词与扩展一致）"""
    default_prompt = (
        "你是B站评论区分析助手。请分析以下评论（每条格式：用户名: 评论），用中文输出五部分：\n"
        "1. 总体情感倾向（正面/负面/中立的估算占比）\n"
        "2. 核心观点（评论区的主要共识或态度）\n"
        "3. 热议话题（讨论最集中的几个话题）\n"
        "4. 亮点评论精选（最多5条，附用户名）\n"
        "5. 争议点 / 建议（如有）\n\n评论内容：\n{text}"
    )
    text = build_comment_text(items, max_items)
    return await ai_chat(text, prompt or default_prompt, cfg, on_chunk, on_reasoning)
