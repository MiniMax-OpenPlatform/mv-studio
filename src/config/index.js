/**
 * MV Studio 统一配置文件
 * 整合歌词识别和 MV 生成两个服务的配置
 */

const fs = require('fs');
const path = require('path');

// 加载 .env 文件
const envPath = path.join(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const [key, ...valueParts] = trimmed.split('=');
            const value = valueParts.join('=');
            if (key && value) {
                process.env[key.trim()] = value.trim();
            }
        }
    });
}

module.exports = {
    // 服务器配置
    server: {
        port: process.env.PORT || 3000
    },

    // 临时文件目录
    paths: {
        temp: 'temp',
        images: 'temp/images',
        videos: 'temp/videos',
        output: 'temp/output'
    },

    // 腾讯云 ASR 配置 (歌词识别)
    tencent: {
        secretId: process.env.TENCENT_SECRET_ID || '',
        secretKey: process.env.TENCENT_SECRET_KEY || '',
        region: 'ap-shanghai'
    },

    // LLM 配置（分镜生成）
    llm: {
        provider: process.env.LLM_PROVIDER || 'minimax', // openai | gemini | minimax
        openai: {
            apiKey: process.env.OPENAI_API_KEY || '',
            model: 'gpt-4o',
            baseUrl: 'https://api.openai.com/v1'
        },
        gemini: {
            apiKey: process.env.GEMINI_API_KEY || '',
            model: 'gemini-2.0-flash'
        },
        minimax: {
            apiKey: process.env.MINIMAX_LLM_API_KEY || '',
            model: 'MiniMax-Text-01',
            baseUrl: 'https://api.minimax.chat/v1'
        }
    },

    // 图片生成配置
    imageGeneration: {
        provider: 'nano_banana',
        aspectRatio: '16:9',
        nanoBanana: {
            apiKey: process.env.NANO_BANANA_API_KEY || ''
        }
    },

    // 视频生成配置
    videoGeneration: {
        provider: 'minimax',
        minimax: {
            apiKey: process.env.MINIMAX_API_KEY || '',
            model: 'MiniMax-Hailuo-2.3-Fast',
            defaultDuration: 10,
            resolution: '768P'
        }
    },

    // MV 合成配置
    mvComposition: {
        defaultResolution: '1920x1080',
        defaultFps: 30,
        transitionDuration: 0.5,
        defaultTransition: 'crossfade'
    },

    // 智能分级阈值
    segmentation: {
        minVideoThreshold: 4,     // 时长 >= 4秒 使用视频
        minAnimationThreshold: 2, // 时长 >= 2秒 使用动画
    },

    // 语言-人种映射
    ethnicityMapping: {
        'chinese': 'Chinese Asian face, East Asian features, black hair',
        'japanese': 'Japanese face, East Asian features',
        'korean': 'Korean face, East Asian features, Korean features',
        'english': 'diverse ethnicity',
        'spanish': 'Latino Hispanic face, Hispanic features'
    },

    // 项目状态定义
    projectStatus: {
        CREATED: 'created',
        RECOGNIZING_LYRICS: 'recognizing_lyrics',
        LYRICS_READY: 'lyrics_ready',
        GENERATING_STORYBOARD: 'generating_storyboard',
        GENERATING_IMAGES: 'generating_images',
        AWAITING_IMAGE_CONFIRM: 'awaiting_image_confirm',
        GENERATING_VIDEOS: 'generating_videos',
        ANIMATING_IMAGES: 'animating_images',
        COMPOSING_MV: 'composing_mv',
        COMPLETED: 'completed',
        FAILED: 'failed'
    }
};
