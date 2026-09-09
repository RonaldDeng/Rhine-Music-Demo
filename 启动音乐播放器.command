#!/bin/bash
# Finder does not load the user's interactive shell configuration.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  printf '\n没有找到 Node.js。请先安装 Node.js 22.12 或更新的 LTS 版本，再双击此文件。\n下载地址：https://nodejs.org/\n'
  read -r -p '按回车关闭…'
  exit 1
fi

node scripts/launch-music.mjs
launcher_status=$?
if [ "$launcher_status" -ne 0 ]; then
  printf '\n启动未完成。请保留上面的错误信息。\n'
  read -r -p '按回车关闭…'
fi
exit "$launcher_status"
