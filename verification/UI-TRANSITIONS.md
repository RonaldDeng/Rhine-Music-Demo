# 详情与弹窗过渡验证

> 历史开发记录：以下范围、参数与验证结论对应文中所述阶段，不代表 V0.1.0 本次已复验；发布版差异见 [验证记录说明](README.md)。

2026-09-09 在真实 Vite 应用中验证。分支 `codex/boot-motion-polish` 已通过合并提交 `09162a0` 进入 `main`，同时保留工作区内的音频和画质改动。

## 本次覆盖

- `reference/ui-transition-check.html`：20 项通过。覆盖弹窗退出保留节点和输入隔离、重复 Esc、开场中断时的透明度连续性、检索结果的关闭后导航、正文可读后焦点、收藏保留 DOM 与滚动位置、快速页签切换、详情退出反向接续、镜头遮罩归位，以及减少动态效果。
- `reference/viewer-motion-check.html`：合并后的 14 项全部通过，包括帧率一致性、复位短路径与中断、键盘与滚轮平滑跟随、边界以及再次进入。
- `reference/micro-transition-review.html`：原有标题快切与查看器进出 13 项全部通过。
- `node scripts/check-motion.mjs` 与 `node scripts/check-loop.mjs`：通过。基线正负波谷、抽取运动和 20,000 次循环导航继续满足原有检查。
- `npm run build`：通过 TypeScript 与生产打包。仍存在原有的大体积 JavaScript chunk 提示。

详情稳定画面经浏览器截图检查，页签下划线、正文、收藏按钮与既有构图一致。功能与数值连续性检查不等同于原片逐像素认证。

新增检查页只在本地开发入口使用，自动恢复开始前的收藏与设置存储。参考页面不包含在产品构建入口中。
