本仓库未引入集中式配置文件（如 .env、yaml、toml）或环境变量注入框架，而是采用「入口层参数 + 本地 JSON 缓存」的极简运行时配置模式。所有可配置项通过 CLI 参数、Streamlit UI 控件或函数默认值传入，运行期状态以 .bili_cache 目录下的 JSON 文件持久化。

1. 使用方式与工具
- 无外部配置库：项目不依赖 pydantic-settings、python-dotenv、configparser 等配置框架。
- 配置来源：
  - CLI：argparse 解析 --cookie、--max-age、--save、--sub-lan、--page、--max-pages、--replies 等；
  - Streamlit Web：侧边栏控件直接映射为运行时参数；
  - 浏览器扩展：通过 Manifest V3 background.js/options.html 暴露用户输入界面，参数在扩展进程内传递。
- 认证凭据：Cookie 字符串由用户输入后在 parse_cookie 中解析为 bilibili-api 的 Credential 对象，不落地到磁盘。

2. 关键文件与位置
- 配置入口
  - cli.py：CLI 参数定义与分发；
  - app.py：Streamlit 页面配置与参数绑定；
  - bilibili_demo.py：独立 demo 的 argparse 入口（含完整参数集）。
- 认证
  - bilibili/auth.py：parse_cookie 将 Cookie 字符串转为 Credential；
  - bilibili_demo.py 中也存在同名函数，两者逻辑一致。
- 缓存（唯一带状态的「配置」）
  - bilibili/cache.py：统一提供 CACHE_DIR、cache_key、cache_get、cache_set；
  - .bili_cache/：按 MD5 键名存储的 JSON 缓存文件，包含 _cached_at、max_age、payload 字段。

3. 架构与约定
- 分层清晰：入口层（cli/app/demo）只负责把用户输入转换为函数参数；业务逻辑集中在 bilibili/*.py 模块中。
- 默认值就近声明：各抓取函数自带合理默认值（如 max_age=30、save_fmt=None），仅在需要覆盖时从上层传入。
- 缓存即配置：max_age 控制缓存有效期，0 表示禁用；disable_cache 开关在 UI 层映射为 max_age=0。
- 输出格式白名单：--save 限定为 txt/json/csv/srt/ass/lrc，避免非法后缀。
- 语言选择：字幕语言通过 SUBTITLE_LAN_MAP 与动态 API 返回双向匹配，支持 ai-zh/zh-Hans/zh-Hant/en/ja/ko。

4. 开发者应遵循的规则
- 新增可配置项优先走 CLI/UI 入口层，再透传到对应抓取函数，不要在 SDK 内部硬编码全局变量。
- 敏感信息（Cookie）仅存在于内存中的 Credential 对象，禁止写入文件或日志。
- 如需新增持久化配置，建议复用 bilibili/cache.py 的 JSON 结构约定（_cached_at/max_age/payload），并更新 CACHE_DIR 路径。
- 保持默认值向后兼容：新增参数必须提供安全默认值，避免破坏现有调用方。