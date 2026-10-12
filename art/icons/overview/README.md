# 缩略图模式图标素材

2026-10-10：用户最新选择为 **A「均衡四宫格」**，已用于 V0.4.3 正式缩略图按钮；B、C 及原图标完整保留为可复用素材。

| 文件 | 方案 | 状态 |
| --- | --- | --- |
| [a-grid.svg](a-grid.svg) | A · 均衡四宫格 | 正式采用 |
| [b-album-columns.svg](b-album-columns.svg) | B · 专辑列 | 备选 |
| [c-stacked-cards.svg](c-stacked-cards.svg) | C · 叠放卡片 | 备选 |
| [original-grid.svg](original-grid.svg) | 原四格图标 | 历史素材 |

全部为独立 SVG：`viewBox="0 0 24 24"`、描边 `1.5`、无填充，使用 `currentColor` 随主题着色；正式按钮显示尺寸为 16×16 CSS px。可任意缩放，无字体、外部图片或网络依赖。内联到 HTML 时继承文字颜色；作为独立图片使用时默认黑色，可按用途指定描边颜色。

A/B/C 与原图标 SVG 素材继续保留；旧对照页和图片留在 V0.4.3，不随新版本复制。正式按钮使用相同 SVG 几何内联于 `src/music-app.ts`，沿用现有尺寸、位置、快捷键与无障碍名称。
