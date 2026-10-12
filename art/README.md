# 模型源文件

此目录保留当前 Three.js 几何生成源以及历史 Blender 场景和建模脚本，用于维护与复现。正常运行播放器不需要安装 Blender；运行时资源位于 `public/assets/`。

- `build-music-case.mjs` / `music-case-v043.json`：V0.5.0 现用专辑盒的可复现 Three.js 几何源与结构清单（保留 `v043` 资源名称）。运行 `node art/build-music-case.mjs` 生成 `public/assets/music-case-v043.glb`，同步结构清单与 `src/music-cd-asset.ts` 的内容哈希入口。当前总宽 3.996，相比 V0.4.1 的 4.45 收窄约 10.2%；高 3.35、厚 0.14，侧条宽约 0.26907，玻璃主体约 3.72693 × 3.35，比正方形宽约 11.25%，封面由 V0.4.1 的 3.06 × 3.06、x=.17 调整为 2.98 × 2.98、x=.14。生成参数取自 `src/music-model.ts`，当前资源哈希为 `f27162cdb5a3`；音乐列中心距同文件定义为 4.746，净空 .75。使用原生几何脚本，不把旧 `.blend` 作为当前模型源。
- `music-cd.blend` / `build_music_cd.py`：保留的 V0.3.0 音乐模式玻璃 CD 盒历史源。它不是当前运行时模型；历史脚本只向 `.tools/music-cd-history/` 输出审阅 `.blend` 与 GLB，不覆盖保存的模型源、`public/assets/` 或当前 `src/music-cd-asset.ts`。当前专辑盒使用 `build-music-case.mjs` 重建。
- `rhine-archive.blend` / `build_archive.py`：保留的原版档案盒。
- `archive-assembly.blend` / `build_assembly.py`：原版拆解模型。
- 其余 `.py` 是共享结构、外壳和审阅场景脚本；生成的 `.blend1` 备份、`.cache/` 和审阅 PNG 不随发布分发。

## 发布前清理保存对话框元数据

Blender 场景可能保存文件选择器的本机目录。当前 `music-cd.blend` 已清空这类固定长度目录字段，并保存为正常的未压缩 `.blend`。V0.5.0 还清理了 9 个旧 JPEG 视图材质球引用及一个视图灯光名称末尾的无效残字；模型、材质、场景参数和文件结构均保持不变。

重新生成后，需再次检查源文件元数据。对于本项目已验证的 Blender 5.0.2 / `BLENDER17-01v0502` 文件，可运行：

```sh
python3 scripts/sanitize_blend_browser_metadata.py art/music-cd.blend art/music-cd.clean.blend
```

脚本默认仅修改 `FileSelectParams.dir` 数组。追加 `--view-matcaps` 可将旧 JPEG 视图材质球引用替换为 Blender 内置 `basic_1.exr`，并清除对应固定数组的残留字节；同时清除 `studio_light[256]` 首个 NUL 后的旧 JPEG 尾字节，保留有效灯光名。清理不影响模型材质、几何或场景参数。V0.5.0 共改变 483 字节，全部位于上述视图元数据字段；文件仍为 609,903 字节、1,405 个结构块，其他字节与块边界逐一核对未变，重复清理不再产生变化。脚本核对全部其余字节一致后写入新文件，不覆盖输入或已有输出。输入为 Zstandard 压缩文件时另需 `zstd` 命令；已解压文件只需 Python 标准库。其他 Blender 格式会明确拒绝，需要使用对应版本的 Blender 清理后复核，不能直接替换二进制字符串。

本目录非代码资源的许可边界见 [README](../README.md#开发与来源)，不要将代码许可自动扩展到所有模型素材。
