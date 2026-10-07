#!/usr/bin/env bash
#
# manus-codex-bridge (standalone) —— 在任意一台电脑上安装
#
# 用法：
#   ./install.sh                 安装到 ~/manus-codex-bridge
#   ./install.sh /opt/mcb        安装到指定目录
#
# 安装完会提示你运行 OAuth 授权。每台电脑都需要各自授权一次。

set -euo pipefail

DEST="${1:-$HOME/manus-codex-bridge}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "manus-codex-bridge (standalone) 安装程序"
echo "----------------------------------------"

# 1) 检查 Node
if ! command -v node >/dev/null 2>&1; then
  echo "✖ 找不到 node。请先安装 Node.js 18 或更高版本：https://nodejs.org"
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✖ Node 版本过低：$(node -v)。需要 18 或更高。"
  exit 1
fi
echo "✔ Node $(node -v)"

# 2) 安装文件
mkdir -p "$DEST"
for f in chatgpt-oauth-login.mjs codex-relay.mjs gpt.mjs; do
  if [ ! -f "$HERE/$f" ]; then
    echo "✖ 缺少文件 $f（请从解压后的目录运行本脚本）"
    exit 1
  fi
  cp "$HERE/$f" "$DEST/$f"
done
echo "✔ 已安装到 $DEST"

# 3) 检查可选的可视化依赖
if ! command -v open >/dev/null 2>&1 && ! command -v xdg-open >/dev/null 2>&1; then
  echo "ℹ 未检测到 open / xdg-open：授权时浏览器不会自动打开，"
  echo "  脚本会打印授权链接，手动复制到浏览器即可。"
fi

cat <<EOF

----------------------------------------
安装完成。下一步：

  cd "$DEST"
  node chatgpt-oauth-login.mjs

这会打开浏览器完成官方授权。授权成功后中继会自动启动，
并自动弹出选模型页面（http://127.0.0.1:8787/）。

之后日常使用：

  node gpt.mjs --list                       列出模型
  node gpt.mjs -m gpt-6-astra "你的问题"      指定模型提问
  node gpt.mjs "你的问题"                     用页面选定的默认模型

注意：每台电脑都需要各自授权一次，不要从别的电脑拷贝凭证文件。
详见同目录的 README.md。
EOF
