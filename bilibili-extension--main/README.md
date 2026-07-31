# B站数据爬取工具 - 浏览器扩展（主包）

一键获取 B站 视频的**弹幕、评论、字幕**。Manifest V3、纯 JavaScript、零依赖。

## 安装（Edge / Chrome）

1. 打开 `edge://extensions/`（Chrome 为 `chrome://extensions/`）→ 开启"开发人员模式"
2. 点"加载解压缩的扩展"→ 选择本项目 `bilibili-extension--main/` 目录
3. 在 B站 视频页点击扩展图标即可使用

## 功能

- 弹幕 / 评论（翻页+楼中楼）/ 字幕抓取，多格式导出（TXT/JSON/CSV/SRT/ASS/LRC）
- 自动识别当前页面 BV 号、自动读取浏览器 Cookie
- 字幕语言选择（所选语言优先匹配，无则回退中文）
- **后台运行**：关闭弹窗任务不中断，下载自动存入浏览器下载目录
- **右键菜单**：B站视频页右键直接抓取（弹幕+字幕 / 评论），完成或失败有桌面通知
- 请求 15 秒超时 + 随时取消（AbortController）
- 设置页可配置默认勾选、默认格式、默认语言、TXT 时间格式等

## 文件结构

```
background.js  核心引擎（调API、WBI签名、分页、生成文件）
popup.html/js  弹窗界面（输入、任务控制、日志、下载）
options.html/js 设置页
utils.js       工具库（MD5、WBI、格式转换）
icons/         扩展图标
```

## 技术要点

- **WBI 签名**：64 元素查找表混排算法，并做服务器时间校准（wts）
- **API 降级**：字幕 Player API → 视频信息 → 重拉；评论 cursor → WBI → page 版
- **大文件下载**：blob URL 方式，规避 data URL 大小限制

> Python 版（SDK/CLI/Web）见仓库根目录 README.md。
