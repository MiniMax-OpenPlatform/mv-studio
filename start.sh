#!/bin/bash

# MV Studio 启动脚本

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "错误: 未找到 Node.js，请先安装 Node.js"
    exit 1
fi

# 检查 FFmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo "警告: 未找到 FFmpeg，部分功能可能受限"
    echo "请安装 FFmpeg: brew install ffmpeg (macOS) 或 apt install ffmpeg (Linux)"
fi

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "正在安装依赖..."
    npm install
fi

# 检查 .env 文件
if [ ! -f ".env" ]; then
    echo "警告: 未找到 .env 文件"
    echo "请复制 .env.example 为 .env 并填入 API 密钥"
    echo ""
    echo "cp .env.example .env"
    echo ""
fi

# 启动服务
echo "启动 MV Studio..."
node server.js
