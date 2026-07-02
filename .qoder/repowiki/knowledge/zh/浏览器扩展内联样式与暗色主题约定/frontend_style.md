本仓库的前端仅存在于 `bilibili-extension--main/` 下的 Manifest V3 Chrome 扩展中，不包含任何独立 CSS 文件、SCSS/Less 或组件库。所有视觉样式均以 `<style>` 标签内联在 HTML 页面中，并遵循统一的暗色主题约定。

**采用的样式体系**
- 无外部样式框架：未使用 Tailwind、Bootstrap、CSS Modules、styled-components 等，纯原生 CSS + 内联 style 属性。
- 统一暗色主题：背景 `#0f0f1a` / 卡片 `#1a1a2e` / 输入框 `#0a0a14`，强调色为 B站蓝 `#00c8ff`，成功/错误分别用 `#4caf50` / `#f44336`。
- 字体栈：`-apple-system, 'Segoe UI', system-ui, sans-serif`，日志区使用等宽字体 `Cascadia Code, Consolas`。
- 布局：以 Flexbox 为主（`.row { display: flex; gap: 12px; }`），无栅格系统；弹窗固定宽度 520px，设置页最大宽度 600px 居中。
- 交互态：通过 `:focus` 边框高亮、`:hover` 透明度变化、渐变按钮 `linear-gradient(135deg, #00c8ff, #0088cc)` 提供反馈。

**关键文件**
- `popup.html`：插件主界面，包含爬取参数、运行日志、下载区域的全部样式。
- `options.html`：设置页，采用 `.card` 分块组织 Cookie、默认勾选项、默认参数、开发者模式等配置。
- `manifest.json`：声明 MV3 结构，`action.default_popup` 指向 `popup.html`，`options_ui.page` 指向 `options.html`。

**开发者应遵循的约定**
1. 新增 UI 元素直接在对应 HTML 的 `<style>` 中追加规则，保持颜色、圆角（`border-radius: 6~8px`）、字号层级与现有风格一致。
2. 复用已有类名语义：`.section`、`.row`、`.btn-start`/`.btn-cancel`、`.log-box`、`.badge-*`、`.hint`、`.card` 等，避免重复定义。
3. 主题色集中维护：强调色 `#00c8ff`、成功 `#4caf50`、错误 `#f44336`、背景 `#0f0f1a` 应在整个扩展中保持一致，不要随意引入新色值。
4. 响应式策略：当前为固定宽度桌面弹窗，如需适配移动端，优先使用 `@media` 而非引入第三方库。
5. 不引入外部 CSS 资源：扩展需离线可用，所有样式必须内联或本地化。