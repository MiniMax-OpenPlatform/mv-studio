/**
 * MV 合成模块
 * 使用 FFmpeg 进行视频拼接、字幕烧录、音频叠加
 */

const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * 转场效果类型
 */
const TransitionType = {
    NONE: 'none',
    CROSSFADE: 'crossfade',   // 交叉溶解
    FADE_BLACK: 'fade_black', // 淡入淡出（经过黑色）
    FADE_WHITE: 'fade_white', // 淡入淡出（经过白色）
    WIPE_LEFT: 'wipe_left',   // 左擦除
    WIPE_RIGHT: 'wipe_right'  // 右擦除
};

/**
 * 生成 ASS 字幕文件
 * @param {array} lyrics - 歌词数组
 * @param {string} outputPath - 输出路径
 * @param {object} style - 字幕样式
 */
function generateASSSubtitle(lyrics, outputPath, style = {}) {
    const fontName = style.fontName || 'PingFang SC';
    const fontSize = style.fontSize || 48;
    const primaryColor = style.primaryColor || '&H00FFFFFF'; // 白色
    const outlineColor = style.outlineColor || '&H00000000'; // 黑色描边
    const backColor = style.backColor || '&H80000000';       // 半透明黑色背景
    const outline = style.outline || 2;
    const shadow = style.shadow || 1;
    const alignment = style.alignment || 2; // 底部居中
    const marginV = style.marginV || 50;

    // ASS 文件头
    let assContent = `[Script Info]
Title: MV Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColor},&H000000FF,${outlineColor},${backColor},0,0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},10,10,${marginV},1
Style: Special,${fontName},${Math.floor(fontSize * 0.8)},&H0000FFFF,&H000000FF,${outlineColor},${backColor},0,1,0,0,100,100,0,0,1,${outline},${shadow},${alignment},10,10,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    // 添加每句歌词
    for (const lyric of lyrics) {
        const startTime = formatASSTime(lyric.startTime);
        const endTime = formatASSTime(lyric.endTime);
        const text = escapeASSText(lyric.text);

        // 特殊片段使用不同样式
        const styleName = lyric.specialType ? 'Special' : 'Default';

        // 添加淡入淡出效果
        const fadeEffect = `{\\fad(200,200)}`;

        assContent += `Dialogue: 0,${startTime},${endTime},${styleName},,0,0,0,,${fadeEffect}${text}\n`;
    }

    // 确保目录存在
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, assContent, 'utf-8');
    return outputPath;
}

/**
 * 格式化时间为 ASS 格式 (H:MM:SS.cc)
 * @param {number} seconds - 秒数
 * @returns {string}
 */
function formatASSTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds % 1) * 100);

    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
}

/**
 * 转义 ASS 特殊字符
 * @param {string} text - 原始文本
 * @returns {string}
 */
function escapeASSText(text) {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\n/g, '\\N');
}

/**
 * 生成视频拼接列表文件
 * @param {array} videoFiles - 视频文件路径数组
 * @param {string} listPath - 列表文件输出路径
 */
function generateConcatList(videoFiles, listPath) {
    const content = videoFiles
        .map(file => `file '${file.replace(/'/g, "'\\''")}'`)
        .join('\n');

    fs.writeFileSync(listPath, content, 'utf-8');
    return listPath;
}

/**
 * 拼接视频片段（无转场）
 * @param {array} videoFiles - 视频文件路径数组
 * @param {string} outputPath - 输出路径
 * @returns {Promise<object>}
 */
function concatVideos(videoFiles, outputPath) {
    return new Promise((resolve, reject) => {
        const listPath = outputPath.replace(/\.\w+$/, '_list.txt');
        generateConcatList(videoFiles, listPath);

        const command = [
            'ffmpeg',
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', `"${listPath}"`,
            '-c', 'copy',
            `"${outputPath}"`
        ].join(' ');

        exec(command, { maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
            // 保留临时文件用于调试
            console.log(`  拼接列表保存在: ${listPath}`);

            if (error) {
                reject(new Error(`Concat failed: ${stderr}`));
                return;
            }

            resolve({
                success: true,
                path: outputPath
            });
        });
    });
}

/**
 * 拼接视频并添加转场效果
 * @param {array} segments - 分段数据（包含视频路径和时长）
 * @param {string} outputPath - 输出路径
 * @param {object} options - 配置选项
 * @returns {Promise<object>}
 */
function concatVideosWithTransition(segments, outputPath, options = {}) {
    return new Promise((resolve, reject) => {
        const transitionDuration = options.transitionDuration || config.mvComposition.transitionDuration || 0.5;
        const transitionType = options.transitionType || TransitionType.CROSSFADE;

        if (segments.length === 0) {
            reject(new Error('No video segments provided'));
            return;
        }

        if (segments.length === 1) {
            // 单个视频直接复制
            fs.copyFileSync(segments[0].path, outputPath);
            resolve({ success: true, path: outputPath });
            return;
        }

        // 构建复杂滤镜
        let inputArgs = [];
        let filterComplex = [];
        let lastOutput = null;

        // 添加所有输入
        for (let i = 0; i < segments.length; i++) {
            inputArgs.push('-i', `"${segments[i].path}"`);
        }

        // 统一分辨率和格式
        for (let i = 0; i < segments.length; i++) {
            filterComplex.push(`[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`);
        }

        // 依次添加转场
        for (let i = 0; i < segments.length - 1; i++) {
            const inputA = i === 0 ? `[v${i}]` : lastOutput;
            const inputB = `[v${i + 1}]`;
            const outputLabel = `[vout${i}]`;

            // 计算偏移时间
            const offsetTime = segments[i].duration - transitionDuration;

            if (transitionType === TransitionType.CROSSFADE) {
                filterComplex.push(`${inputA}${inputB}xfade=transition=fade:duration=${transitionDuration}:offset=${offsetTime}${outputLabel}`);
            } else if (transitionType === TransitionType.WIPE_LEFT) {
                filterComplex.push(`${inputA}${inputB}xfade=transition=wipeleft:duration=${transitionDuration}:offset=${offsetTime}${outputLabel}`);
            } else if (transitionType === TransitionType.WIPE_RIGHT) {
                filterComplex.push(`${inputA}${inputB}xfade=transition=wiperight:duration=${transitionDuration}:offset=${offsetTime}${outputLabel}`);
            } else {
                // 默认淡入淡出
                filterComplex.push(`${inputA}${inputB}xfade=transition=fade:duration=${transitionDuration}:offset=${offsetTime}${outputLabel}`);
            }

            lastOutput = outputLabel;
        }

        const command = [
            'ffmpeg',
            '-y',
            ...inputArgs,
            '-filter_complex', `"${filterComplex.join(';')}"`,
            '-map', `"${lastOutput}"`,
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            `"${outputPath}"`
        ].join(' ');

        exec(command, { maxBuffer: 200 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg xfade error:', stderr);
                // 转场失败时回退到简单拼接
                console.log('Falling back to simple concat...');
                concatVideos(segments.map(s => s.path), outputPath)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            resolve({
                success: true,
                path: outputPath,
                transitionType: transitionType
            });
        });
    });
}

/**
 * 添加音频轨道
 * @param {string} videoPath - 视频路径
 * @param {string} audioPath - 音频路径
 * @param {string} outputPath - 输出路径
 * @param {object} options - 配置选项
 * @returns {Promise<object>}
 */
function addAudioTrack(videoPath, audioPath, outputPath, options = {}) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(videoPath)) {
            reject(new Error(`Video not found: ${videoPath}`));
            return;
        }

        if (!fs.existsSync(audioPath)) {
            reject(new Error(`Audio not found: ${audioPath}`));
            return;
        }

        const videoDuration = getMediaDuration(videoPath);
        const audioDuration = getMediaDuration(audioPath);

        console.log(`  视频时长: ${videoDuration.toFixed(2)}s, 音频时长: ${audioDuration.toFixed(2)}s`);

        // 以音频时长为准，这是 MV 的正确做法
        // 如果视频比音频短，需要先延长视频
        const targetDuration = options.useAudioDuration !== false ? audioDuration : videoDuration;

        let command;
        if (videoDuration < audioDuration - 0.5) {
            // 视频比音频短超过 0.5 秒，需要循环或延长视频
            console.log(`  警告: 视频比音频短 ${(audioDuration - videoDuration).toFixed(2)}s，将冻结最后一帧补齐`);

            // 使用 tpad 滤镜在视频末尾添加冻结帧
            const padDuration = audioDuration - videoDuration;
            command = [
                'ffmpeg',
                '-y',
                '-i', `"${videoPath}"`,
                '-i', `"${audioPath}"`,
                '-filter_complex', `"[0:v]tpad=stop_mode=clone:stop_duration=${padDuration.toFixed(2)}[v]"`,
                '-map', '"[v]"',
                '-map', '1:a:0',
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-crf', '23',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-t', audioDuration.toString(),
                `"${outputPath}"`
            ].join(' ');
        } else {
            // 视频时长足够或比音频长，正常处理
            command = [
                'ffmpeg',
                '-y',
                '-i', `"${videoPath}"`,
                '-i', `"${audioPath}"`,
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-t', targetDuration.toString(),
                '-map', '0:v:0',
                '-map', '1:a:0',
                `"${outputPath}"`
            ].join(' ');
        }

        exec(command, { maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                console.error('Add audio error:', stderr);
                reject(new Error(`Add audio failed: ${stderr}`));
                return;
            }

            const finalDuration = getMediaDuration(outputPath);
            console.log(`  最终 MV 时长: ${finalDuration.toFixed(2)}s`);

            resolve({
                success: true,
                path: outputPath,
                duration: finalDuration
            });
        });
    });
}

/**
 * 烧录字幕
 * @param {string} videoPath - 视频路径
 * @param {string} subtitlePath - 字幕路径
 * @param {string} outputPath - 输出路径
 * @returns {Promise<object>}
 */
function burnSubtitles(videoPath, subtitlePath, outputPath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(videoPath)) {
            reject(new Error(`Video not found: ${videoPath}`));
            return;
        }

        if (!fs.existsSync(subtitlePath)) {
            reject(new Error(`Subtitle not found: ${subtitlePath}`));
            return;
        }

        // 转义路径中的特殊字符
        const escapedSubPath = subtitlePath.replace(/:/g, '\\:').replace(/\\/g, '/');

        const command = [
            'ffmpeg',
            '-y',
            '-i', `"${videoPath}"`,
            '-vf', `"ass='${escapedSubPath}'"`,
            '-c:a', 'copy',
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '23',
            `"${outputPath}"`
        ].join(' ');

        exec(command, { maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`Burn subtitles failed: ${stderr}`));
                return;
            }

            resolve({
                success: true,
                path: outputPath
            });
        });
    });
}

/**
 * 获取媒体文件时长
 * @param {string} filePath - 文件路径
 * @returns {number} 时长（秒）
 */
function getMediaDuration(filePath) {
    try {
        const result = execSync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
            { encoding: 'utf-8' }
        );
        return parseFloat(result.trim()) || 0;
    } catch (e) {
        console.error('Failed to get duration:', e.message);
        return 0;
    }
}

/**
 * 调整视频时长以匹配目标时长
 * 如果视频比目标短，使用慢放+冻结最后一帧的方式延长
 * 如果视频比目标长，使用 -t 截断
 * @param {string} inputPath - 输入视频路径
 * @param {string} outputPath - 输出视频路径
 * @param {number} targetDuration - 目标时长（秒）
 * @returns {Promise<object>}
 */
function adjustVideoDuration(inputPath, outputPath, targetDuration) {
    return new Promise((resolve, reject) => {
        const actualDuration = getMediaDuration(inputPath);

        if (Math.abs(actualDuration - targetDuration) < 0.1) {
            // 时长差异小于 0.1 秒，直接复制
            fs.copyFileSync(inputPath, outputPath);
            resolve({ success: true, path: outputPath, adjusted: false });
            return;
        }

        if (actualDuration > targetDuration) {
            // 视频比目标长，截断
            const command = [
                'ffmpeg', '-y',
                '-i', `"${inputPath}"`,
                '-t', targetDuration.toString(),
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-crf', '23',
                `"${outputPath}"`
            ].join(' ');

            exec(command, { maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Trim video failed: ${stderr}`));
                    return;
                }
                resolve({ success: true, path: outputPath, adjusted: true, method: 'trim' });
            });
        } else {
            // 视频比目标短，需要延长
            // 策略：将视频速度放慢到刚好填满目标时长
            // 但如果放慢太多（>50%），则使用冻结最后一帧
            const ratio = targetDuration / actualDuration;

            if (ratio <= 1.5) {
                // 放慢不超过 50%，使用 setpts 慢放
                const ptsMultiplier = ratio.toFixed(4);
                const command = [
                    'ffmpeg', '-y',
                    '-i', `"${inputPath}"`,
                    '-filter_complex', `"[0:v]setpts=${ptsMultiplier}*PTS[v]"`,
                    '-map', '"[v]"',
                    '-t', targetDuration.toString(),
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '23',
                    `"${outputPath}"`
                ].join(' ');

                exec(command, { maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
                    if (error) {
                        console.error('Slowdown failed, trying freeze frame:', stderr);
                        // 回退到冻结最后帧方案
                        extendWithFreezeFrame(inputPath, outputPath, actualDuration, targetDuration)
                            .then(resolve)
                            .catch(reject);
                        return;
                    }
                    resolve({ success: true, path: outputPath, adjusted: true, method: 'slowdown', ratio: ratio });
                });
            } else {
                // 需要延长太多，使用冻结最后帧
                extendWithFreezeFrame(inputPath, outputPath, actualDuration, targetDuration)
                    .then(resolve)
                    .catch(reject);
            }
        }
    });
}

/**
 * 使用冻结最后帧方式延长视频
 */
function extendWithFreezeFrame(inputPath, outputPath, actualDuration, targetDuration) {
    return new Promise((resolve, reject) => {
        const freezeDuration = targetDuration - actualDuration;
        const tempDir = path.dirname(outputPath);
        const tempFrame = path.join(tempDir, `temp_lastframe_${Date.now()}.png`);
        const tempFreeze = path.join(tempDir, `temp_freeze_${Date.now()}.mp4`);
        const tempList = path.join(tempDir, `temp_concat_${Date.now()}.txt`);

        // 先获取原视频的帧率，确保冻结视频帧率匹配
        let inputFps = 24; // 默认 24fps
        try {
            const fpsResult = execSync(
                `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
                { encoding: 'utf-8' }
            ).trim();
            // 解析帧率 (可能是 "24/1" 或 "30000/1001" 格式)
            if (fpsResult.includes('/')) {
                const [num, den] = fpsResult.split('/').map(Number);
                inputFps = Math.round(num / den);
            } else {
                inputFps = parseInt(fpsResult) || 24;
            }
        } catch (e) {
            // 使用默认帧率
        }

        // 步骤1: 提取最后一帧
        const extractCmd = [
            'ffmpeg', '-y',
            '-sseof', '-0.1',
            '-i', `"${inputPath}"`,
            '-update', '1',
            '-q:v', '2',
            `"${tempFrame}"`
        ].join(' ');

        exec(extractCmd, { maxBuffer: 50 * 1024 * 1024 }, (err1) => {
            if (err1) {
                reject(new Error(`Extract last frame failed`));
                return;
            }

            // 步骤2: 从最后一帧生成冻结视频（使用与原视频相同的帧率）
            const freezeCmd = [
                'ffmpeg', '-y',
                '-loop', '1',
                '-i', `"${tempFrame}"`,
                '-t', freezeDuration.toFixed(2),
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-crf', '23',
                '-pix_fmt', 'yuv420p',
                '-r', inputFps.toString(), // 使用与原视频相同的帧率
                `"${tempFreeze}"`
            ].join(' ');

            exec(freezeCmd, { maxBuffer: 50 * 1024 * 1024 }, (err2) => {
                if (err2) {
                    try { fs.unlinkSync(tempFrame); } catch(e) {}
                    reject(new Error(`Generate freeze frame video failed`));
                    return;
                }

                // 步骤3: 拼接原视频 + 冻结视频
                fs.writeFileSync(tempList, `file '${inputPath}'\nfile '${tempFreeze}'`);

                const concatCmd = [
                    'ffmpeg', '-y',
                    '-f', 'concat',
                    '-safe', '0',
                    '-i', `"${tempList}"`,
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '23',
                    `"${outputPath}"`
                ].join(' ');

                exec(concatCmd, { maxBuffer: 100 * 1024 * 1024 }, (err3) => {
                    // 清理临时文件
                    try { fs.unlinkSync(tempFrame); } catch(e) {}
                    try { fs.unlinkSync(tempFreeze); } catch(e) {}
                    try { fs.unlinkSync(tempList); } catch(e) {}

                    if (err3) {
                        reject(new Error(`Concat freeze frame failed`));
                        return;
                    }
                    resolve({ success: true, path: outputPath, adjusted: true, method: 'freeze', freezeDuration: freezeDuration });
                });
            });
        });
    });
}

/**
 * 完整的 MV 合成流程
 * @param {object} params - 合成参数
 * @returns {Promise<object>}
 */
async function composeMV(params) {
    const {
        segments,          // 分段数据
        videoDir,          // 视频片段目录
        audioPath,         // 原始音频路径
        outputPath,        // 最终输出路径
        lyrics,            // 歌词数据（用于字幕）
        options = {}
    } = params;

    const tempDir = path.dirname(outputPath);
    const baseName = path.basename(outputPath, path.extname(outputPath));
    const adjustedDir = path.join(tempDir, 'adjusted');

    // 创建调整后视频的临时目录
    if (!fs.existsSync(adjustedDir)) {
        fs.mkdirSync(adjustedDir, { recursive: true });
    }

    console.log('=== MV 合成开始 ===');

    // 获取音频总时长作为参考
    const audioDuration = audioPath ? getMediaDuration(audioPath) : 0;
    console.log(`音频时长: ${audioDuration.toFixed(2)}s`);

    // 1. 收集所有视频片段并调整时长
    console.log('1. 收集并调整视频片段时长...');
    const videoSegments = [];
    let adjustedCount = 0;

    for (const segment of segments) {
        const paddedIndex = String(segment.index).padStart(3, '0');

        // 根据渲染类型查找对应的视频文件，支持回退到 animated
        let videoFile;
        const aiVideoPath = path.join(videoDir, `video_${paddedIndex}.mp4`);
        const animatedPath = path.join(videoDir, `animated_${paddedIndex}.mp4`);

        if (segment.renderType === 'video') {
            // 优先使用 AI 生成的视频，如果不存在则回退到动画
            if (fs.existsSync(aiVideoPath)) {
                videoFile = aiVideoPath;
            } else if (fs.existsSync(animatedPath)) {
                console.log(`  [${paddedIndex}] AI视频不存在，使用动画备份`);
                videoFile = animatedPath;
            } else {
                videoFile = aiVideoPath; // 让后面的检查报错
            }
        } else {
            // 动画类型，也支持回退
            if (fs.existsSync(animatedPath)) {
                videoFile = animatedPath;
            } else if (fs.existsSync(aiVideoPath)) {
                videoFile = aiVideoPath;
            } else {
                videoFile = animatedPath;
            }
        }

        if (fs.existsSync(videoFile)) {
            const actualDuration = getMediaDuration(videoFile);
            const targetDuration = segment.duration;
            const durationDiff = Math.abs(actualDuration - targetDuration);

            // 如果时长差异超过 0.2 秒，需要调整
            if (durationDiff > 0.2) {
                console.log(`  [${paddedIndex}] 需调整: ${actualDuration.toFixed(2)}s → ${targetDuration.toFixed(2)}s (差异: ${durationDiff.toFixed(2)}s)`);
                const adjustedPath = path.join(adjustedDir, `adjusted_${paddedIndex}.mp4`);

                try {
                    const result = await adjustVideoDuration(videoFile, adjustedPath, targetDuration);
                    console.log(`    ✓ 调整完成 (${result.method || 'copy'})`);
                    videoSegments.push({
                        index: segment.index,
                        path: adjustedPath,
                        duration: targetDuration,
                        adjusted: true
                    });
                    adjustedCount++;
                } catch (adjustError) {
                    console.warn(`    ✗ 调整失败，使用原文件: ${adjustError.message}`);
                    videoSegments.push({
                        index: segment.index,
                        path: videoFile,
                        duration: actualDuration,
                        adjusted: false
                    });
                }
            } else {
                // 时长差异可接受，直接使用
                videoSegments.push({
                    index: segment.index,
                    path: videoFile,
                    duration: actualDuration
                });
            }
        } else {
            console.warn(`Video not found: ${videoFile}`);
        }
    }

    if (videoSegments.length === 0) {
        throw new Error('No video segments found');
    }

    console.log(`Found ${videoSegments.length} video segments, adjusted ${adjustedCount} clips`);

    // 2. 拼接视频
    console.log('2. 拼接视频片段...');
    const concatOutput = path.join(tempDir, `${baseName}_concat.mp4`);

    if (options.useTransition) {
        await concatVideosWithTransition(videoSegments, concatOutput, options);
    } else {
        await concatVideos(videoSegments.map(s => s.path), concatOutput);
    }

    // 3. 生成字幕文件
    console.log('3. 生成字幕文件...');
    const subtitlePath = path.join(tempDir, `${baseName}.ass`);
    generateASSSubtitle(lyrics, subtitlePath, options.subtitleStyle);

    // 4. 烧录字幕
    console.log('4. 烧录字幕...');
    const subtitledOutput = path.join(tempDir, `${baseName}_subtitled.mp4`);
    await burnSubtitles(concatOutput, subtitlePath, subtitledOutput);

    // 5. 添加音频
    console.log('5. 添加音频轨道...');
    await addAudioTrack(subtitledOutput, audioPath, outputPath);

    // 6. 清理临时文件
    console.log('6. 清理临时文件...');
    try {
        fs.unlinkSync(concatOutput);
        fs.unlinkSync(subtitledOutput);
        // 保留字幕文件，可能有用
    } catch (e) {
        // 忽略清理错误
    }

    console.log('=== MV 合成完成 ===');
    console.log(`输出文件: ${outputPath}`);

    return {
        success: true,
        path: outputPath,
        duration: getMediaDuration(outputPath)
    };
}

module.exports = {
    TransitionType,
    generateASSSubtitle,
    generateConcatList,
    concatVideos,
    concatVideosWithTransition,
    addAudioTrack,
    burnSubtitles,
    getMediaDuration,
    adjustVideoDuration,
    extendWithFreezeFrame,
    composeMV
};
