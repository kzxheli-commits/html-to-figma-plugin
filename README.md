# HTML → Figma（插件版）

把网页**逐像素还原成可编辑的 Figma 图层**，并把页面里的交互读成**可点的原型连线**。

在真实浏览器里排版测量，不猜 CSS：读 `getBoundingClientRect()` 与 `getComputedStyle()`，
文本用 `Range.getClientRects()` 拿到每一个视觉行的精确盒子。整个包（`.zip`）先内联资源再逐页捕获。

## 安装

1. 下载或克隆本仓库；
2. 打开 Figma 桌面版 → **Plugins → Development → Import plugin from manifest…**；
3. 选择本目录下的 `plugin/manifest.json`；
4. 在 Figma 里右键画布 → **Plugins → Development → HTML → Figma**。

> `plugin/ui.html` 已经是构建好的自包含产物，**开箱可用**。改过 `core/` 之后才需要重新构建。

## 用法

**输入模式** —— 粘贴整段 HTML（含 `<style>`），或粘贴一个网址（走 CORS 代理抓取）。

**文件模式** —— 拖入或选择 `.html` 单页、`.zip` 整包，支持多选；文件进入队列后可单项移除、一键全部复刻。

导入整包时：

- 每页生成一个顶层画板，**横向并排**、按页序命名（如 `1. index.html`）；
- 页与页之间的跳转在**触发元素所在的图层**上写 `reactions`，进 Figma 直接就能点着走流程。

### 视口与裁剪

默认开启**自动识别**：按页面的 `<meta name="viewport">` 与媒体查询断点判断端型，自动给出视口与画板范围。

| 端型 | 视口 | 画板范围 |
| --- | --- | --- |
| 手机 | 412 × 915 | 一屏（底栏会落在画板底部） |
| 平板 | 834 × 1194 | 一屏 |
| 桌面 | 1440 × 900 | 贴合内容 |

也可以从**经典设备预设**里选：安卓（Pixel 7/8、Galaxy S、通用、大屏）、iOS 参考、网页（笔记本 / 桌面 / MacBook / 全高清）、平板。手动改动任一视口字段即关闭自动识别。

### 还原模式

- **仅样式** —— 只要视觉还原，不读交互、不建原型连线，也不为弹层与视图额外出稿，跑得更快；
- **样式 + 交互**（默认）—— 视觉还原之外，读页面代码得出跨页跳转、弹层与路由视图，写成可点的原型连线。

其余渲染细节（禁用动画、捕获伪元素、z-index 排序、弹层与视图单独成稿、:hover 状态稿、低保真线框、白色衬底等）收在「高级」折叠里。

## 交互是怎么复刻的

一句话：**读页面自己的代码得出交互**（谁按下 → 到哪个界面），把「页面切换」拆成多张画板，最后按 Figma 的原型模型逐条写反应。

| 来源 | 说明 |
| --- | --- |
| 标签上的 | `<a href>`、`popovertarget`、内联 `onclick`（会解析 `location.href` / `history.back`） |
| 脚本里的 | `addEventListener` 绑定的路由切换、`pushState`、`data-*` 属性驱动的目标 |
| 状态稿 | `:hover` 态、`:target` 弹层、SPA 路由视图 —— 一次加载看不到的，各出一张独立画板 |

写进 Figma 时踩过的几个点（都在代码里处理了）：

- `transition` 不能是 `null`，否则真机上静默失效、点不动；
- `documentAccess: "dynamic-page"` 下 `node.reactions` **不能直接赋值**，必须走 `setReactionsAsync` / `getReactionsAsync` 并读回校验；
- 同一条交互会写在**触发元素和它最近的容器**两处 —— 演示时命中判定取最上层元素，只写在小文字层上，用户点图标就没反应；
- 找不到重叠足够的图层时**宁可不连**，也不把反应写到别的元素上；
- 每个画板都设一个 prototype starting point，从任意视图都能直接进演示。

完整机制见 `plugin/` 与 `core/` 里的注释；诊断口径是一行汇总（`已连接 N 条，跳过 M 条`，并给出跳过原因）。

## 目录结构

```
plugin/            manifest.json · code.js（主线程）· ui.src.html（界面源码）· ui.html（构建产物）
core/              内核，两条产出路线共用
  engine.js        在真实浏览器里排版测量 → 快照
  session.js       流程编排、选项、自动识别、还原模式
  vfs.js           整包解析与资源内联（含本地 JS、字体）
  interactions.js  交互提取（标签 / 内联事件 / CSS 语义）
  code-interactions.js  从页面 JS 源码读出「控件 → 目标」
  route-probe.js   运行时路由探测（兜底）
  hover-states.js  :hover 状态稿
  overlay-states.js :target 弹层稿
  view-states.js   路由视图稿
  viewport.js      端型识别与设备预设
  lowfi.js / backdrop.js / svg.js / flow.js
build.js           把 ui.src.html + core 内联成自包含的 plugin/ui.html
```

## 开发

```bash
node build.js          # 改过 core/ 之后重建 plugin/ui.html
```

内核是**插件版与网页版共用的**：改 `core/` 时记得同步到网页版仓库，两个入口的行为才会一致。

## 已知限制

- 不支持 `conic-gradient`、`clip-path`、`mask`、跨域图片像素、`filter` 链；
- 页面跳转（`a[href]` / `onclick` / 表单）会被提取并写成原型连线；`:hover`、动画等只在状态稿里体现；
- `<iframe>`、跨域 `<canvas>` / `<video>` 取不到像素，会留占位；
- CJK 文本需要 Figma 里有对应字体（回退链首选 `Noto Sans SC`），否则会被 Figma 自己回退。

## 许可

MIT
