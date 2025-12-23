# MV Studio

一站式 AI 音乐视频制作平台 - 整合歌词识别和 MV 自动生成

## 功能特性

- **歌词识别** - 基于腾讯云 ASR 自动识别音频中的歌词和时间戳
- **智能分镜** - 使用 AI 大模型根据歌词内容生成分镜脚本
- **图片生成** - AI 生成符合歌词意境的配图
- **视频合成** - 自动将图片、音频合成为完整 MV

## 技术栈

- **后端**: Node.js
- **语音识别**: 腾讯云 ASR
- **LLM**: MiniMax / OpenAI / Gemini (可选)
- **图片生成**: MiniMax Image API
- **视频生成**: MiniMax Video API

## 快速开始

### 环境要求

- Node.js >= 16.0.0
- FFmpeg (用于音视频处理)

### 安装

```bash
# 克隆项目
git clone https://github.com/MiniMax-OpenPlatform/mv-studio.git
cd mv-studio

# 安装依赖
npm install
```

### 配置

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 编辑 `.env` 文件，填入你的 API 密钥：

```bash
# 腾讯云 ASR (歌词识别)
TENCENT_SECRET_ID=your_tencent_secret_id
TENCENT_SECRET_KEY=your_tencent_secret_key

# LLM (分镜生成) - 选择一个
LLM_PROVIDER=minimax
MINIMAX_LLM_API_KEY=your_minimax_llm_api_key

# 图片生成
NANO_BANANA_API_KEY=your_nano_banana_api_key

# 视频生成
MINIMAX_API_KEY=your_minimax_api_key
```

### 启动服务

```bash
npm start
```

然后访问 http://localhost:3000

## API 密钥获取

| 服务 | 获取地址 |
|------|----------|
| 腾讯云 ASR | https://console.cloud.tencent.com/cam/capi |
| MiniMax | https://www.minimaxi.com/ |
| OpenAI | https://platform.openai.com/api-keys |
| Gemini | https://aistudio.google.com/app/apikey |

## 项目结构

```
mv-studio/
├── server.js              # 主服务入口
├── public/                # 前端静态文件
├── src/
│   ├── config/           # 配置管理
│   ├── lyrics/           # 歌词识别模块
│   │   ├── asr-service.js
│   │   ├── audio-converter.js
│   │   └── lyrics-slicer.js
│   └── mv/               # MV 生成模块
│       ├── storyboard-generator.js
│       ├── image-generator.js
│       ├── video-generator.js
│       └── mv-composer.js
├── .env.example          # 环境变量模板
└── package.json
```

## License

MIT
