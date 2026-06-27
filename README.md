
## 一、项目历程

### Phase 1：Python 原型（~1h）

**起点**：想抓 B站 视频的字幕和弹幕，发现现有工具要么要钱要么太复杂。

用 AI 辅助写了 `bilibili_demo.py`，基于 `bilibili-api-python` 库：
- 弹幕抓取（调用官方 API）
- 评论翻页 + 楼中楼回复（全量分页，限速保护）
- 字幕下载（多语言匹配，SRT/ASS/LRC/JSON 多格式）
- Cookie 登录态
- 本地文件缓存

同时用 Streamlit 搭了个网页界面 `app.py`，方便非命令行用户使用。

**这个阶段的核心收获**：理解了异步编程、API 调用、分页逻辑、数据格式化。

### Phase 2：Edge 扩展重写（~2h）

Python 版跑通了，但每次都要开终端/Python 环境，不够方便。决定改写成浏览器扩展。

**技术选型**：Manifest V3、纯 JavaScript、零依赖

**架构**：
```
popup.html  ← 用户界面（UI）
popup.js    ← 交互逻辑（发送任务、显示日志、下载文件）
background.js ← 核心引擎（调 B站 API、分页、生成文件）
utils.js    ← 工具库（MD5、WBI 签名、格式转换）
```

### Phase 3：踩坑 & 修复（~1h）

#### 坑 1：字幕 URL 为空
**症状**：API 返回了字幕语言列表，但 `subtitle_url` 是空的
**原因**：B站 2023年迁移了字幕接口，旧接口 `x/web-interface/view` 的 `subtitle.list` 已废弃
**修复**：改用 `x/player/wbi/v2`，配合 WBI 签名

#### 坑 2：WBI 签名算法过期
**症状**：评论接口全部被风控
**原因**：B站 2024年更新了 WBI 签名算法，从简单的 `sub[:4]+img[:4]` 改为 64 元素查找表混排
**修复**：实现正确的混排算法

#### 坑 3：一个模块崩溃阻塞全部
**症状**：字幕报错 → 评论也不跑了
**原因**：三个任务在同一个 try-catch 里
**修复**：改为独立 try-catch，互不影响

---

## 二、技术要点总结

### WBI 签名（B站接口鉴权）
```
1. 从 x/web-interface/nav 获取 img_key + sub_key
2. 64元素查找表混排 → 取前32位作为 mixin_key
3. 参数排序 → urlencode → 拼接 mixin_key → MD5 → w_rid
4. 请求附带 wts（时间戳）+ w_rid
```
这是 B站反爬的核心机制，理解后对其他平台的签名机制也能举一反三。

### API 降级策略
```
字幕： Player API（WBI签名）→ 视频信息API → 重新拉取
评论： cursor版API → WBI签名版 → page版API（最宽容）
```
每一层都是独立 try-catch，上一层失败自动降级。

### 扩展与 Python 的区别
| 维度 | Python 版 | 扩展版 |
|------|----------|--------|
| 安装 | pip install | Edge 加载即可 |
| 部署 | 需要 Python 环境 | 浏览器内置 |
| Cookie | 手动粘贴 | 自动从浏览器读取 |
| 使用成本 | 开终端敲命令 | 点图标 → 点按钮 |
| 反爬 | 依赖第三方库 | 手写 WBI 签名 |

---

## 三、未来方向

### 近期（已实现）
- [x] 弹幕 + 字幕双功能
- [x] 设置页面（默认勾选、自动Cookie、开发者模式）
- [x] 右键菜单（B站视频页右键直接抓取）
- [x] 复制到剪贴板
- [x] TXT 字幕时间格式切换

### 中期（值得投入）
- [ ] **AI 字幕总结**：接入 DeepSeek/通义千问，抓完字幕自动总结要点
- [ ] **评论翻页修复**：WBI 签名已正确，后续可恢复评论功能
- [ ] **弹幕词云**：前端可视化
- [ ] **UP 主信息**：BV 号关联 UP 主数据

### 远期（看用户反馈）
- [ ] 多平台支持（YouTube/TikTok）
- [ ] 直播监控
- [ ] Anki 卡片导出
- [ ] 批量导入 BV 列表


## 四、特别感谢

- [bilibili-api-python](https://github.com/Nemo2011/bilibili-api) — Python 版的核心依赖
- [bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect) — B站 API 文档
- Claude — 本次 Coding 的全程 AI 搭档

---

> 写于 2026 年夏 | 高考后第 17 天

           个人势，无经验，只分享。 AI率97.8% ，py与web为技术验证，Edge插件为主包。
