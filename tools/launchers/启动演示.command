#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
cd "$(dirname "$0")/../.." || exit 1
if ! command -v npm >/dev/null 2>&1; then
  printf '\n请先安装 Node.js 22.12 或更新版本（包含 npm）。\n'
  read -r -p '按回车关闭…'
  exit 1
fi
if [ ! -d node_modules/vite ]; then
  npm ci || exit 1
fi
npm run build || exit 1
printf '\n演示：只使用内置封面；没有可播放曲目。关闭此窗口停止演示服务。\n'
npm run preview -- --port 5312 --strictPort --open '/?demo=1'
