# 直播弹幕功能 · 研究归档（2026-08-22）

> 功能状态：**暂停**。房间信息获取正常可用；实时弹幕监听因 B 站风控升级（-352）搁置。
> 本文档保存全部实验结论与重启路径，避免下次从零开始。

## 一、已验证可用的部分（保留在代码中）

| 能力 | 状态 | 入口 |
|---|---|---|
| 直播间信息（标题/主播/分区/人气/开播状态） | ✅ 可用 | 弹窗直播面板、MCP `get_live_info` |
| 弹幕协议实现（封包/解压/切帧/认证/心跳） | ✅ 代码正确（见实验 3） | `live-proto.js` |
| 连接诊断页（五步日志） | ✅ 可用 | `live-test.html`（扩展内打开） |
| MCP 诊断工具（token 长度/原始 token/wss 地址） | ✅ 可用 | `get_live_danmu_info` |

## 二、B 端点现状（2026-08-22 实测）

| 端点 | 结果 |
|---|---|
| `xlive/web-room/v1/index/getInfoByRoom?room_id=` | ✅ 正常（Cookie+buvid3 可过 -352） |
| `xlive/web-room/v1/danmu/getInfoByRoom`（旧弹幕端点） | ❌ **404 已下线** |
| `xlive/web-room/v1/danmu/getinfo`、`danmu/info` 等变体 | ❌ 404 |
| `room/v1/Danmu/getConf` | ⚠️ 存在但只返回刷新配置，无 token |
| `xlive/web-room/v1/index/getDanmuInfo?id=`（新弹幕端点） | ❌ **-352 风控**（匿名、伪造 buvid3、真实浏览器 Cookie+buvid3 均被拒） |

## 三、关键实验记录（Node 复现，可随时重跑）

1. **Origin 无关性**：无 Origin / `https://live.bilibili.com` / `chrome-extension://…` 三组对照，
   WS 握手全部成功、认证后全部被断（close 1006）——服务器不看 Origin。
2. **匿名连接已封禁**：空 token 认证包发出后 **33ms 被主动掐线**；纯挂机不发包可活 5s（空闲超时）。
   → 认证包格式正确（否则挂机也会被立刻断），是服务器**主动拒绝无效 token**。
   B 站已从"空 key 匿名可连"收紧为"必须有 getDanmuInfo 签发的 token"。
3. **协议栈正确性**：16 字节帧头封包、ver2 zlib 解压（`DecompressionStream('deflate')`）、
   解压后多帧切分、DANMU_MSG 解析——与公开协议实现一致，未发现格式错误。
4. `-352` 出现在 **HTTP 层（getDanmuInfo）**而非 WS 层：说明弹幕令牌签发已纳入
   gaia 风控体系（需要 `x-bili-aurora-eid` / `x-bili-web-req` 等浏览器指纹头）。

## 四、重启路径（按推荐顺序）

1. **主世界 WebSocket hook（最推荐）**：content script 以 `world: "MAIN"` 注入直播页，
   monkey-patch `window.WebSocket`，截获直播页**自己建立**的弹幕连接帧（页面自身已通过全部风控），
   转发给扩展。零额外风控暴露、不怕接口变动。改动点：manifest 注入声明 + 一个 20 行的 hook 脚本 +
   复用现有 `live-proto.js` 解析函数。
2. **gaia 头逆向**：给 getDanmuInfo 补 `x-bili-aurora-eid`、`x-bili-web-req` 等头
   （参考 blivedm / bilibili-live-ws 社区的最新进展）。猫鼠游戏，维护成本高。
3. 弃用自建连接，改用页面内已有数据的 DOM 观察（弹幕列表节点 MutationObserver）——
   最稳但只能拿"渲染出来的"弹幕，有丢失。

## 五、资产清单

- `bilibili-extension--main/live-proto.js` —— 协议模块（三端共用：background / live-test / Node）
- `bilibili-extension--main/live-test.html` + `live-test-boot.js` + `live-test-main.js` —— 诊断页
- `bilibili-extension--main/background.js` 的 `fetchDanmuInfo` / `liveStart` / `liveStop` 管线（已接好，只差 token）
- MCP 工具 `get_live_info`（可用）、`get_live_danmu_info`（诊断）
- `.zcode/live-node-test*.mjs`、`ws-origin-test.mjs`、`ws-timing-test.mjs` —— Node 复现脚本（本地未入库）

## 六、暂停时的处置

- 弹窗直播面板：保留房间信息展示；「监听弹幕」按钮隐藏（`popup-preview.js` 中 `LIVE_SUPPORTED = false`）
- README 已同步标注"实验性，暂停支持"
- 全部代码保留不删，重启时按第四节路径继续
