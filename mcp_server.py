#!/usr/bin/env python3
"""
B站爬虫扩展 - MCP 本地桥接服务 (v1.2.0)

架构:
    AI 客户端 (Claude Desktop / Cursor / DSH 等, MCP over HTTP)
        │  http://127.0.0.1:<port>/mcp  (Streamable HTTP)  或  /sse (旧式兼容)
        ▼
    本服务 mcp_server.py (aiohttp, 自定义端口)
        │  ws://127.0.0.1:<port>/ws  (WebSocket)
        ▼
    浏览器扩展 (background.js, 自动携带浏览器 Cookie)

能力: 扩展提供 6 个 MCP 工具，AI 可直接调用抓取 B 站视频数据，
      Cookie 由扩展从浏览器自动读取，无需手动提供。

用法:
    python mcp_server.py --port 8765            # 自定义端口（与扩展设置一致）
    python mcp_server.py --host 0.0.0.0 --port 9000  # 局域网（需扩展支持远程地址）

依赖: pip install aiohttp
"""

import argparse
import asyncio
import json
import logging
import uuid

import aiohttp
from aiohttp import web

logging.basicConfig(level=logging.INFO, format="[MCP] %(message)s")
log = logging.getLogger("mcp")

SERVER_VERSION = "1.2.0"
CALL_TIMEOUT = 300  # 工具调用超时（秒）

# ── MCP 工具定义（协议权威，扩展侧按名执行） ─────────────────
TOOLS = [
    {
        "name": "get_video_info",
        "description": "获取B站视频信息：标题、UP主、时长、弹幕数、评论数、播放量",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bvid": {"type": "string", "description": "BV号或完整B站链接"}
            },
            "required": ["bvid"],
        },
    },
    {
        "name": "fetch_danmaku",
        "description": "抓取视频全量弹幕（登录态自动走 seg.so 分段接口，与 list.so 对比取更全）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bvid": {"type": "string", "description": "BV号或完整B站链接"}
            },
            "required": ["bvid"],
        },
    },
    {
        "name": "fetch_comments",
        "description": "抓取视频评论（支持滑动窗口条数上限与楼中楼回复）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bvid": {"type": "string", "description": "BV号或完整B站链接"},
                "max_pages": {"type": "integer", "description": "最大翻页数，0=不限"},
                "max_comments": {
                    "type": "integer",
                    "description": "评论条数上限（滑动窗口），0=不限",
                },
                "with_replies": {"type": "boolean", "description": "是否获取楼中楼回复"},
                "rate_delay": {"type": "integer", "description": "翻页间隔毫秒，防风控（默认400）"},
            },
            "required": ["bvid"],
        },
    },
    {
        "name": "fetch_subtitle",
        "description": "抓取视频字幕（返回 SRT 文本与结构化行；无字幕时 found=false）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bvid": {"type": "string", "description": "BV号或完整B站链接"},
                "lan": {
                    "type": "string",
                    "description": "字幕语言代码（ai-zh/zh-Hans/zh-Hant/en/ja/ko），默认自动",
                },
            },
            "required": ["bvid"],
        },
    },
    {
        "name": "word_cloud",
        "description": "统计视频弹幕热词（中文二元组+拉丁词，停用词过滤），返回频率降序列表",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bvid": {"type": "string", "description": "BV号或完整B站链接"},
                "top_n": {"type": "integer", "description": "返回词数上限（默认30）"},
            },
            "required": ["bvid"],
        },
    },
    {
        "name": "get_cookie_status",
        "description": "查询扩展自动获取的B站登录状态（是否已登录，用于判断数据完整度）",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_live_info",
        "description": "获取B站直播间信息：标题、主播、分区、人气值、开播状态",
        "inputSchema": {
            "type": "object",
            "properties": {
                "room_id": {
                    "type": "integer",
                    "description": "直播间号（live.bilibili.com/ 后的数字）",
                }
            },
            "required": ["room_id"],
        },
    },
]


class Bridge:
    """扩展 WebSocket 连接管理与工具调用转发"""

    def __init__(self):
        self.ext_ws = None
        self.session = ""
        self.pending = {}  # req_id -> asyncio.Future

    async def call(self, tool: str, args: dict):
        if self.ext_ws is None or self.ext_ws.closed:
            raise RuntimeError(
                "浏览器扩展未连接：请打开浏览器，并在扩展设置页「服务」中启用 MCP 服务开关"
            )
        req_id = "req-" + uuid.uuid4().hex[:12]
        fut = asyncio.get_running_loop().create_future()
        self.pending[req_id] = fut
        await self.ext_ws.send_json({"type": "call", "id": req_id, "tool": tool, "args": args})
        try:
            result = await asyncio.wait_for(fut, timeout=CALL_TIMEOUT)
        except asyncio.TimeoutError:
            self.pending.pop(req_id, None)
            raise RuntimeError("扩展执行超时（请检查扩展是否在线）") from None
        if not result.get("ok"):
            raise RuntimeError(result.get("error", "扩展执行失败"))
        return result.get("data")


bridge = Bridge()


# ── WebSocket：扩展接入 ─────────────────────────────────────
async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=64 * 1024 * 1024)
    await ws.prepare(request)
    async for msg in ws:
        if msg.type == web.WSMsgType.TEXT:
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            mtype = data.get("type")
            if mtype == "hello":
                bridge.ext_ws = ws
                bridge.session = data.get("session", "")
                log.info("扩展已连接 session=%s version=%s",
                         bridge.session, data.get("version", "?"))
            elif mtype == "result":
                fut = bridge.pending.pop(data.get("id"), None)
                if fut is not None and not fut.done():
                    fut.set_result(data)
        elif msg.type == web.WSMsgType.ERROR:
            break
    if bridge.ext_ws is ws:
        bridge.ext_ws = None
        log.info("扩展已断开")
    return ws


# ── MCP JSON-RPC ────────────────────────────────────────────
def _rpc_ok(req_id, result):
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _rpc_err(req_id, message, code=-32000):
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


async def handle_rpc(body: dict):
    method = body.get("method")
    params = body.get("params") or {}
    req_id = body.get("id")

    if method == "initialize":
        return _rpc_ok(req_id, {
            "protocolVersion": params.get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "bilibili-toolbox-mcp", "version": SERVER_VERSION},
        })
    if method == "notifications/initialized":
        return None
    if method == "ping":
        return _rpc_ok(req_id, {})
    if method == "tools/list":
        return _rpc_ok(req_id, {"tools": TOOLS})
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if not any(t["name"] == name for t in TOOLS):
            return _rpc_err(req_id, f"未知工具: {name}", -32602)
        try:
            data = await bridge.call(name, args)
            return _rpc_ok(req_id, {
                "content": [
                    {"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=2)}
                ],
                "structuredContent": data,
                "isError": False,
            })
        except Exception as e:
            return _rpc_ok(req_id, {
                "content": [{"type": "text", "text": f"错误: {e}"}],
                "isError": True,
            })
    return _rpc_err(req_id, f"未知方法: {method}", -32601)


# ── HTTP 端点 ───────────────────────────────────────────────
async def mcp_post(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except (json.JSONDecodeError, aiohttp.ContentTypeError):
        return web.json_response(_rpc_err(None, "无效 JSON"), status=400)
    if not isinstance(body, dict):
        return web.json_response(_rpc_err(None, "JSON-RPC 请求必须是对象"), status=400)
    resp = await handle_rpc(body)
    if resp is None:  # 通知类消息
        return web.Response(status=202)
    return web.json_response(resp)


async def mcp_get(request: web.Request) -> web.StreamResponse:
    """Streamable HTTP：GET 建立 SSE 长连接（保持兼容，实际请求走 POST）"""
    resp = web.StreamResponse(
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        }
    )
    await resp.prepare(request)
    try:
        while True:
            await resp.write(b": keepalive\n\n")
            await asyncio.sleep(15)
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    return resp


async def sse_get(request: web.Request) -> web.StreamResponse:
    """旧式 SSE transport 兼容（Claude Desktop 早期配置）"""
    resp = web.StreamResponse(
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        }
    )
    await resp.prepare(request)
    await resp.write(b"event: endpoint\ndata: /mcp\n\n")
    try:
        while True:
            await resp.write(b": keepalive\n\n")
            await asyncio.sleep(15)
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    return resp


async def index_get(request: web.Request) -> web.Response:
    return web.json_response({
        "service": "bilibili-toolbox-mcp",
        "version": SERVER_VERSION,
        "mcp_endpoint": f"http://{request.host}/mcp",
        "sse_endpoint": f"http://{request.host}/sse",
        "tools": [t["name"] for t in TOOLS],
        "extension_connected": bridge.ext_ws is not None and not bridge.ext_ws.closed,
        "session": bridge.session,
    })


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/ws", ws_handler)
    app.router.add_post("/mcp", mcp_post)
    app.router.add_get("/mcp", mcp_get)
    app.router.add_get("/sse", sse_get)
    app.router.add_get("/", index_get)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="B站爬虫扩展 MCP 本地桥接服务")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认 127.0.0.1）")
    parser.add_argument(
        "--port", type=int, default=8765,
        help="监听端口（默认 8765，需与扩展设置一致）"
    )
    args = parser.parse_args()

    log.info("B站爬虫扩展 MCP 服务启动: http://%s:%s/mcp", args.host, args.port)
    log.info("AI 客户端 MCP 配置地址: http://127.0.0.1:%s/mcp", args.port)
    log.info("等待浏览器扩展连接 ws://127.0.0.1:%s/ws ...（请打开扩展设置→服务→启用）", args.port)
    web.run_app(build_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
