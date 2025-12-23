/**
 * 图片动画化模块
 * 使用 FFmpeg 实现 Ken Burns 效果（缩放+平移动画）
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * 动画效果类型
 */
const AnimationEffect = {
    ZOOM_IN: 'zoom_in',           // 缓慢放大
    ZOOM_OUT: 'zoom_out',         // 缓慢缩小
    PAN_LEFT: 'pan_left',         // 向左平移
    PAN_RIGHT: 'pan_right',       // 向右平移
    PAN_UP: 'pan_up',             // 向上平移
    PAN_DOWN: 'pan_down',         // 向下平移
    ZOOM_IN_PAN_LEFT: 'zoom_in_pan_left',   // 放大+左移
    ZOOM_IN_PAN_RIGHT: 'zoom_in_pan_right', // 放大+右移
    ZOOM_OUT_PAN_LEFT: 'zoom_out_pan_left', // 缩小+左移
    ZOOM_OUT_PAN_RIGHT: 'zoom_out_pan_right' // 缩小+右移
};

/**
 * 检查 FFmpeg 是否可用
 * @returns {boolean}
 */
function checkFFmpeg() {
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * 获取图片尺寸
 * @param {string} imagePath - 图片路径
 * @returns {object} { width, height }
 */
function getImageSize(imagePath) {
    try {
        const result = execSync(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${imagePath}"`,
            { encoding: 'utf-8' }
        );
        const [width, height] = result.trim().split(',').map(Number);
        return { width, height };
    } catch (e) {
        // 默认 16:9 尺寸
        return { width: 1920, height: 1080 };
    }
}

/**
 * 生成 FFmpeg zoompan 滤镜表达式
 * @param {string} effect - 动画效果类型
 * @param {number} duration - 时长（秒）
 * @param {number} fps - 帧率
 * @param {number} outputWidth - 输出宽度
 * @param {number} outputHeight - 输出高度
 * @returns {string} zoompan 滤镜表达式
 */
function generateZoompanFilter(effect, duration, fps, outputWidth = 1920, outputHeight = 1080) {
    const totalFrames = Math.floor(duration * fps);

    // 缩放参数
    const zoomStart = 1.0;
    const zoomEnd = 1.2;
    const zoomDelta = (zoomEnd - zoomStart) / totalFrames;

    // 基础滤镜参数
    const baseParams = `d=${totalFrames}:s=${outputWidth}x${outputHeight}:fps=${fps}`;

    switch (effect) {
        case AnimationEffect.ZOOM_IN:
            // 从中心放大
            return `zoompan=z='min(zoom+${zoomDelta.toFixed(6)},${zoomEnd})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${baseParams}`;

        case AnimationEffect.ZOOM_OUT:
            // 从放大状态缩小到正常
            return `zoompan=z='if(lte(zoom,1.0),${zoomEnd},max(zoom-${zoomDelta.toFixed(6)},1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${baseParams}`;

        case AnimationEffect.PAN_LEFT:
            // 向左平移（图片向右移动）
            return `zoompan=z='1.1':x='iw/10*${totalFrames}/(${totalFrames}-on)':y='ih/2-(ih/zoom/2)':${baseParams}`;

        case AnimationEffect.PAN_RIGHT:
            // 向右平移
            return `zoompan=z='1.1':x='iw-iw/zoom-iw/10*${totalFrames}/(${totalFrames}-on)':y='ih/2-(ih/zoom/2)':${baseParams}`;

        case AnimationEffect.PAN_UP:
            // 向上平移
            return `zoompan=z='1.1':x='iw/2-(iw/zoom/2)':y='ih/10*${totalFrames}/(${totalFrames}-on)':${baseParams}`;

        case AnimationEffect.PAN_DOWN:
            // 向下平移
            return `zoompan=z='1.1':x='iw/2-(iw/zoom/2)':y='ih-ih/zoom-ih/10*${totalFrames}/(${totalFrames}-on)':${baseParams}`;

        case AnimationEffect.ZOOM_IN_PAN_LEFT:
            // 放大同时向左平移
            return `zoompan=z='min(zoom+${zoomDelta.toFixed(6)},${zoomEnd})':x='iw/zoom/10*on/${totalFrames}':y='ih/2-(ih/zoom/2)':${baseParams}`;

        case AnimationEffect.ZOOM_IN_PAN_RIGHT:
            // 放大同时向右平移
            return `zoompan=z='min(zoom+${zoomDelta.toFixed(6)},${zoomEnd})':x='iw-iw/zoom-iw/zoom/10*on/${totalFrames}':y='ih/2-(ih/zoom/2)':${baseParams}`;

        case AnimationEffect.ZOOM_OUT_PAN_LEFT:
            // 缩小同时向左平移
            return `zoompan=z='if(lte(zoom,1.0),${zoomEnd},max(zoom-${zoomDelta.toFixed(6)},1.0))':x='iw/zoom/10*on/${totalFrames}':y='ih/2-(ih/zoom/2)':${baseParams}`;

        case AnimationEffect.ZOOM_OUT_PAN_RIGHT:
            // 缩小同时向右平移
            return `zoompan=z='if(lte(zoom,1.0),${zoomEnd},max(zoom-${zoomDelta.toFixed(6)},1.0))':x='iw-iw/zoom-iw/zoom/10*on/${totalFrames}':y='ih/2-(ih/zoom/2)':${baseParams}`;

        default:
            // 默认缓慢放大
            return `zoompan=z='min(zoom+${zoomDelta.toFixed(6)},${zoomEnd})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${baseParams}`;
    }
}

/**
 * 随机选择动画效果
 * @param {number} index - 索引，用于确保相邻场景效果不同
 * @returns {string} 动画效果类型
 */
function getRandomEffect(index) {
    const effects = [
        AnimationEffect.ZOOM_IN,
        AnimationEffect.ZOOM_OUT,
        AnimationEffect.ZOOM_IN_PAN_LEFT,
        AnimationEffect.ZOOM_IN_PAN_RIGHT,
        AnimationEffect.ZOOM_OUT_PAN_LEFT,
        AnimationEffect.ZOOM_OUT_PAN_RIGHT
    ];

    // 基于索引选择，确保相邻不重复
    return effects[index % effects.length];
}

/**
 * 将单张图片转换为带动画效果的视频
 * @param {string} imagePath - 输入图片路径
 * @param {string} outputPath - 输出视频路径
 * @param {number} duration - 视频时长（秒）
 * @param {object} options - 配置选项
 * @returns {Promise<object>} 转换结果
 */
function animateImage(imagePath, outputPath, duration, options = {}) {
    return new Promise((resolve, reject) => {
        if (!checkFFmpeg()) {
            reject(new Error('FFmpeg is not installed'));
            return;
        }

        if (!fs.existsSync(imagePath)) {
            reject(new Error(`Image not found: ${imagePath}`));
            return;
        }

        const fps = options.fps || config.mvComposition.defaultFps || 30;
        const effect = options.effect || AnimationEffect.ZOOM_IN;
        const resolution = options.resolution || config.mvComposition.defaultResolution || '1920x1080';
        const [width, height] = resolution.split('x').map(Number);

        // 确保输出目录存在
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // 生成 zoompan 滤镜
        const zoompanFilter = generateZoompanFilter(effect, duration, fps, width, height);

        // FFmpeg 命令
        // 1. 首先将图片缩放到合适尺寸
        // 2. 应用 zoompan 效果
        // 3. 添加淡入淡出效果（可选）
        let filterComplex = `scale=${width * 2}:${height * 2},${zoompanFilter}`;

        // 添加淡入淡出效果
        if (options.fadeIn || options.fadeOut) {
            const fadeInDuration = options.fadeIn || 0;
            const fadeOutDuration = options.fadeOut || 0;
            const fadeOutStart = duration - fadeOutDuration;

            if (fadeInDuration > 0) {
                filterComplex += `,fade=t=in:st=0:d=${fadeInDuration}`;
            }
            if (fadeOutDuration > 0) {
                filterComplex += `,fade=t=out:st=${fadeOutStart}:d=${fadeOutDuration}`;
            }
        }

        const command = [
            'ffmpeg',
            '-y',                           // 覆盖输出文件
            '-loop', '1',                   // 循环输入图片
            '-i', `"${imagePath}"`,         // 输入图片
            '-filter_complex', `"${filterComplex}"`,
            '-t', duration.toString(),      // 输出时长
            '-c:v', 'libx264',              // 视频编码
            '-pix_fmt', 'yuv420p',          // 像素格式（兼容性）
            '-preset', 'medium',            // 编码速度/质量平衡
            '-crf', '23',                   // 质量（18-28，越小越好）
            `"${outputPath}"`
        ].join(' ');

        exec(command, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg error:', stderr);
                reject(new Error(`FFmpeg failed: ${error.message}`));
                return;
            }

            resolve({
                success: true,
                path: outputPath,
                duration: duration,
                effect: effect
            });
        });
    });
}

/**
 * 批量将图片转换为动画视频
 * @param {array} segments - 分段数据数组
 * @param {string} imageDir - 图片目录
 * @param {string} outputDir - 输出目录
 * @param {object} options - 配置选项
 * @param {function} onProgress - 进度回调
 * @returns {Promise<array>} 转换结果数组
 */
async function animateImages(segments, imageDir, outputDir, options = {}, onProgress = null) {
    const results = [];
    const total = segments.length;

    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    for (let i = 0; i < total; i++) {
        const segment = segments[i];
        const paddedIndex = String(segment.index).padStart(3, '0');

        const imagePath = path.join(imageDir, `image_${paddedIndex}.png`);
        const outputPath = path.join(outputDir, `animated_${paddedIndex}.mp4`);

        // 确定动画效果
        const effect = options.effect || getRandomEffect(i);

        // 使用歌词时长
        const duration = segment.duration || 5;

        try {
            const result = await animateImage(imagePath, outputPath, duration, {
                ...options,
                effect: effect,
                fadeIn: options.fadeIn || 0.3,
                fadeOut: options.fadeOut || 0.3
            });

            result.index = segment.index;
            result.lyric = segment.lyric;
            results.push(result);

        } catch (error) {
            results.push({
                success: false,
                index: segment.index,
                lyric: segment.lyric,
                error: error.message
            });
        }

        // 进度回调
        if (onProgress) {
            onProgress({
                completed: i + 1,
                total: total,
                percentage: Math.round(((i + 1) / total) * 100),
                lastResult: results[results.length - 1]
            });
        }
    }

    return results;
}

/**
 * 创建静态图片视频（无动画效果）
 * @param {string} imagePath - 图片路径
 * @param {string} outputPath - 输出路径
 * @param {number} duration - 时长
 * @returns {Promise<object>}
 */
function createStaticVideo(imagePath, outputPath, duration) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(imagePath)) {
            reject(new Error(`Image not found: ${imagePath}`));
            return;
        }

        const command = [
            'ffmpeg',
            '-y',
            '-loop', '1',
            '-i', `"${imagePath}"`,
            '-c:v', 'libx264',
            '-t', duration.toString(),
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
            `"${outputPath}"`
        ].join(' ');

        exec(command, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({
                success: true,
                path: outputPath,
                duration: duration
            });
        });
    });
}

module.exports = {
    AnimationEffect,
    checkFFmpeg,
    animateImage,
    animateImages,
    createStaticVideo,
    getRandomEffect,
    getImageSize
};
