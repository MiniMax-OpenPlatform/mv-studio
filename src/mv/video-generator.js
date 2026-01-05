/**
 * 视频生成模块
 * 基于 MiniMax Hailuo API 生成视频
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../config');

/**
 * 超长片段阈值 (秒)
 * 超过这个时长的片段将生成多个视频拼接
 */
const LONG_SEGMENT_THRESHOLD = 15;

/**
 * API 配置
 */
const API_CONFIG = {
    baseUrl: 'api.minimax.chat',
    createPath: '/v1/video_generation',
    queryPath: '/v1/query/video_generation'
};

/**
 * 调用 MiniMax 视频生成 API - 创建任务 (带重试)
 * @param {object} params - 生成参数
 * @param {number} retries - 重试次数
 * @returns {Promise<object>} 响应数据
 */
function createVideoTask(params, retries = 3) {
    return new Promise((resolve, reject) => {
        const apiKey = config.videoGeneration.minimax.apiKey;
        if (!apiKey) {
            reject(new Error('MiniMax API key not configured'));
            return;
        }

        // MiniMax Hailuo 支持 6 秒或 10 秒视频
        // 根据片段时长智能选择：如果 segment.duration <= 6，选 6 秒；否则选 10 秒
        const videoDuration = params.duration || config.videoGeneration.minimax.defaultDuration || 6;

        const payload = JSON.stringify({
            model: params.model || config.videoGeneration.minimax.model,
            first_frame_image: params.firstFrameImage, // Base64 图片
            prompt: params.prompt || '',
            prompt_optimizer: params.promptOptimizer !== false,
            duration: videoDuration, // 6 或 10 秒
            aigc_watermark: params.aigcWatermark !== false // 默认添加水印
        });

        const requestOptions = {
            hostname: API_CONFIG.baseUrl,
            port: 443,
            path: API_CONFIG.createPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 60000 // 60秒超时
        };

        const req = https.request(requestOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(result);
                } catch (e) {
                    reject(new Error(`JSON parse error: ${e.message}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            if (retries > 0) {
                console.log(`Request timeout, retrying... (${retries} left)`);
                setTimeout(() => {
                    createVideoTask(params, retries - 1).then(resolve).catch(reject);
                }, 2000);
            } else {
                reject(new Error('Request timeout after retries'));
            }
        });

        req.on('error', (err) => {
            if (retries > 0 && (err.code === 'ECONNRESET' || err.message.includes('socket hang up'))) {
                console.log(`Connection error: ${err.message}, retrying... (${retries} left)`);
                setTimeout(() => {
                    createVideoTask(params, retries - 1).then(resolve).catch(reject);
                }, 3000);
            } else {
                reject(err);
            }
        });

        req.write(payload);
        req.end();
    });
}

/**
 * 查询视频生成任务状态 (带重试)
 * @param {string} taskId - 任务 ID
 * @param {number} retries - 重试次数
 * @returns {Promise<object>} 响应数据
 */
function queryVideoTask(taskId, retries = 3) {
    return new Promise((resolve, reject) => {
        const apiKey = config.videoGeneration.minimax.apiKey;
        if (!apiKey) {
            reject(new Error('MiniMax API key not configured'));
            return;
        }

        const requestOptions = {
            hostname: API_CONFIG.baseUrl,
            port: 443,
            path: `${API_CONFIG.queryPath}?task_id=${taskId}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`
            },
            timeout: 30000
        };

        const req = https.request(requestOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(result);
                } catch (e) {
                    reject(new Error(`JSON parse error: ${e.message}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            if (retries > 0) {
                setTimeout(() => {
                    queryVideoTask(taskId, retries - 1).then(resolve).catch(reject);
                }, 2000);
            } else {
                reject(new Error('Query timeout after retries'));
            }
        });

        req.on('error', (err) => {
            if (retries > 0 && (err.code === 'ECONNRESET' || err.message.includes('socket hang up'))) {
                setTimeout(() => {
                    queryVideoTask(taskId, retries - 1).then(resolve).catch(reject);
                }, 2000);
            } else {
                reject(err);
            }
        });

        req.end();
    });
}

/**
 * 下载视频文件 (带重试)
 * @param {string} url - 视频 URL
 * @param {string} outputPath - 输出路径
 * @param {number} retries - 重试次数
 * @returns {Promise<boolean>} 是否成功
 */
function downloadVideo(url, outputPath, retries = 3) {
    return new Promise((resolve, reject) => {
        // 验证 URL
        if (!url || typeof url !== 'string' || !url.startsWith('http')) {
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }

        // 确保目录存在
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const file = fs.createWriteStream(outputPath);

        // 处理 http 和 https
        const protocol = url.startsWith('https') ? https : require('http');

        const request = protocol.get(url, { timeout: 120000 }, (response) => {
            // 处理重定向
            if (response.statusCode === 301 || response.statusCode === 302) {
                const redirectUrl = response.headers.location;
                file.close();
                downloadVideo(redirectUrl, outputPath, retries).then(resolve).catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlink(outputPath, () => {});
                reject(new Error(`Download failed with status ${response.statusCode}`));
                return;
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                resolve(true);
            });
        });

        request.on('timeout', () => {
            request.destroy();
            file.close();
            fs.unlink(outputPath, () => {});
            if (retries > 0) {
                console.log(`Download timeout, retrying... (${retries} left)`);
                setTimeout(() => {
                    downloadVideo(url, outputPath, retries - 1).then(resolve).catch(reject);
                }, 3000);
            } else {
                reject(new Error('Download timeout after retries'));
            }
        });

        request.on('error', (err) => {
            file.close();
            fs.unlink(outputPath, () => {});
            if (retries > 0 && (err.code === 'ECONNRESET' || err.message.includes('socket hang up'))) {
                console.log(`Download error: ${err.message}, retrying... (${retries} left)`);
                setTimeout(() => {
                    downloadVideo(url, outputPath, retries - 1).then(resolve).catch(reject);
                }, 3000);
            } else {
                reject(err);
            }
        });

        file.on('error', (err) => {
            fs.unlink(outputPath, () => {});
            reject(err);
        });
    });
}

/**
 * 根据 file_id 获取视频下载 URL
 * @param {string} fileId - 文件 ID
 * @param {number} retries - 重试次数
 * @returns {Promise<string>} 下载 URL
 */
function getVideoDownloadUrl(fileId, retries = 3) {
    return new Promise((resolve, reject) => {
        const apiKey = config.videoGeneration.minimax.apiKey;
        if (!apiKey) {
            reject(new Error('MiniMax API key not configured'));
            return;
        }

        const requestOptions = {
            hostname: API_CONFIG.baseUrl,
            port: 443,
            path: `/v1/files/retrieve?file_id=${fileId}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`
            },
            timeout: 30000
        };

        const req = https.request(requestOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    console.log('File retrieve response:', JSON.stringify(result).substring(0, 500));

                    if (result.base_resp && result.base_resp.status_code !== 0) {
                        reject(new Error(`Get file failed: ${result.base_resp.status_msg}`));
                        return;
                    }

                    // 尝试从响应中获取下载 URL
                    const downloadUrl = result.file?.download_url || result.download_url || result.url;
                    if (downloadUrl) {
                        resolve(downloadUrl);
                    } else {
                        reject(new Error('No download URL in file response'));
                    }
                } catch (e) {
                    reject(new Error(`JSON parse error: ${e.message}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            if (retries > 0) {
                setTimeout(() => {
                    getVideoDownloadUrl(fileId, retries - 1).then(resolve).catch(reject);
                }, 2000);
            } else {
                reject(new Error('Get file timeout after retries'));
            }
        });

        req.on('error', (err) => {
            if (retries > 0) {
                setTimeout(() => {
                    getVideoDownloadUrl(fileId, retries - 1).then(resolve).catch(reject);
                }, 2000);
            } else {
                reject(err);
            }
        });

        req.end();
    });
}

/**
 * 将图片文件转为 Base64
 * @param {string} imagePath - 图片路径
 * @returns {string} Base64 字符串
 */
function imageToBase64(imagePath) {
    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
}

/**
 * 等待视频生成完成
 * @param {string} taskId - 任务 ID
 * @param {number} maxWaitMs - 最大等待时间（毫秒）
 * @param {number} pollIntervalMs - 轮询间隔（毫秒）
 * @returns {Promise<object>} 完成的任务结果
 */
async function waitForVideoCompletion(taskId, maxWaitMs = 600000, pollIntervalMs = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
        const result = await queryVideoTask(taskId);

        if (result.base_resp && result.base_resp.status_code !== 0) {
            throw new Error(`Query failed: ${result.base_resp.status_msg}`);
        }

        const status = result.status;

        if (status === 'Success') {
            return result;
        } else if (status === 'Fail') {
            throw new Error(`Video generation failed: ${result.base_resp?.status_msg || 'Unknown error'}`);
        }

        // Processing 或 Queueing 状态，继续等待
        console.log(`Video task ${taskId} status: ${status}`);
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error('Video generation timeout');
}

/**
 * 生成单个 AI 视频片段 (内部函数)
 * @param {string} firstFrameImage - base64 首帧图片
 * @param {string} prompt - 视频描述
 * @param {string} outputPath - 视频输出路径
 * @param {number} duration - API 视频时长 (6 或 10)
 * @param {object} options - 配置选项
 * @returns {Promise<object>} 生成结果
 */
async function generateSingleVideoClip(firstFrameImage, prompt, outputPath, duration, options = {}) {
    // 创建视频生成任务
    const createResult = await createVideoTask({
        model: options.model || config.videoGeneration.minimax.model,
        firstFrameImage: firstFrameImage,
        prompt: prompt,
        promptOptimizer: options.promptOptimizer !== false,
        duration: duration,
        aigcWatermark: options.aigcWatermark !== false // 默认添加水印
    });

    if (createResult.base_resp && createResult.base_resp.status_code !== 0) {
        throw new Error(`Create task failed: ${createResult.base_resp.status_msg}`);
    }

    const taskId = createResult.task_id;
    if (!taskId) {
        throw new Error('No task_id in response');
    }

    console.log(`  Video task created: ${taskId}`);

    // 等待视频生成完成
    const completedResult = await waitForVideoCompletion(taskId, options.maxWaitMs);

    // 获取视频下载 URL
    let videoUrl = null;
    if (completedResult.file && completedResult.file.download_url) {
        videoUrl = completedResult.file.download_url;
    } else if (completedResult.video && completedResult.video.download_url) {
        videoUrl = completedResult.video.download_url;
    } else if (completedResult.download_url) {
        videoUrl = completedResult.download_url;
    } else if (completedResult.file_id) {
        console.log(`  Getting download URL for file_id: ${completedResult.file_id}`);
        videoUrl = await getVideoDownloadUrl(completedResult.file_id);
    }

    if (!videoUrl) {
        throw new Error('No video URL in completed result');
    }

    console.log(`  Downloading video from: ${videoUrl.substring(0, 60)}...`);
    await downloadVideo(videoUrl, outputPath);

    return { success: true, path: outputPath, taskId };
}

/**
 * 从视频中提取最后一帧作为图片
 * @param {string} videoPath - 视频文件路径
 * @param {string} outputImagePath - 输出图片路径
 * @returns {Promise<string>} 输出图片路径
 */
async function extractLastFrame(videoPath, outputImagePath) {
    return new Promise((resolve, reject) => {
        const command = `ffmpeg -y -sseof -0.1 -i "${videoPath}" -update 1 -q:v 2 "${outputImagePath}"`;
        require('child_process').exec(command, { maxBuffer: 50 * 1024 * 1024 }, (error) => {
            if (error) {
                reject(new Error(`Failed to extract last frame: ${error.message}`));
                return;
            }
            resolve(outputImagePath);
        });
    });
}

/**
 * 拼接多个视频文件
 * @param {string[]} videoPaths - 视频文件路径列表
 * @param {string} outputPath - 输出路径
 * @returns {Promise<void>}
 */
async function concatVideos(videoPaths, outputPath) {
    const tempDir = path.dirname(outputPath);
    const concatListPath = path.join(tempDir, `concat_list_${Date.now()}.txt`);

    // 创建 FFmpeg concat 列表 - 使用绝对路径
    const concatContent = videoPaths.map(p => `file '${path.resolve(p)}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent);

    try {
        execSync(`ffmpeg -y -f concat -safe 0 -i "${path.resolve(concatListPath)}" -c:v libx264 -preset fast -crf 23 "${path.resolve(outputPath)}"`, {
            maxBuffer: 100 * 1024 * 1024
        });
    } finally {
        // 清理 concat 列表文件
        try { fs.unlinkSync(concatListPath); } catch(e) {}
    }
}

/**
 * 生成单个视频 (支持超长片段多视频拼接)
 * @param {object} segment - 分段数据
 * @param {string} imagePath - 首帧图片路径
 * @param {string} outputPath - 视频输出路径
 * @param {object} options - 配置选项
 * @returns {Promise<object>} 生成结果
 */
async function generateVideo(segment, imagePath, outputPath, options = {}) {
    console.log(`Generating video for segment ${segment.index}: ${segment.lyric.substring(0, 30)}...`);

    try {
        // 读取首帧图片
        if (!fs.existsSync(imagePath)) {
            throw new Error(`First frame image not found: ${imagePath}`);
        }
        const firstFrameImage = imageToBase64(imagePath);
        const segmentDuration = segment.duration || segment.videoDuration || 6;

        // 检查是否是超长片段 (需要多个视频拼接)
        if (segmentDuration > LONG_SEGMENT_THRESHOLD) {
            console.log(`  🎬 超长片段 (${segmentDuration.toFixed(2)}s > ${LONG_SEGMENT_THRESHOLD}s)，将生成多个视频拼接`);

            // 计算需要多少个 10 秒视频
            const numVideos = Math.ceil(segmentDuration / 10);
            console.log(`  → 需要生成 ${numVideos} 个视频片段（使用尾帧衔接）`);

            const tempDir = path.dirname(outputPath);
            const clipPaths = [];
            const tempFiles = [];

            // 当前使用的首帧图片（第一个视频使用原始首帧，后续使用前一个视频的尾帧）
            let currentFirstFrame = firstFrameImage;

            // 生成多个视频片段
            for (let i = 0; i < numVideos; i++) {
                const clipPath = path.join(tempDir, `temp_clip_${segment.index}_${i}_${Date.now()}.mp4`);
                tempFiles.push(clipPath);

                console.log(`  [${i + 1}/${numVideos}] 生成视频片段...`);

                try {
                    await generateSingleVideoClip(currentFirstFrame, segment.prompt, clipPath, 10, options);
                    clipPaths.push(clipPath);
                    console.log(`  [${i + 1}/${numVideos}] ✓ 完成`);

                    // 如果不是最后一个视频，提取尾帧作为下一个视频的首帧
                    if (i < numVideos - 1) {
                        const lastFramePath = path.join(tempDir, `temp_lastframe_${segment.index}_${i}_${Date.now()}.png`);
                        tempFiles.push(lastFramePath);

                        console.log(`  [${i + 1}/${numVideos}] 提取尾帧用于下一段...`);
                        await extractLastFrame(clipPath, lastFramePath);

                        // 将尾帧转为 base64 作为下一个视频的首帧
                        currentFirstFrame = imageToBase64(lastFramePath);

                        // 防止 API 限流，等待 3 秒
                        await new Promise(resolve => setTimeout(resolve, 3000));
                    }
                } catch (clipError) {
                    console.error(`  [${i + 1}/${numVideos}] ✗ 失败: ${clipError.message}`);
                    // 清理已生成的临时文件
                    for (const f of tempFiles) {
                        try { fs.unlinkSync(f); } catch(e) {}
                    }
                    throw clipError;
                }
            }

            // 拼接所有视频片段
            console.log(`  📦 拼接 ${clipPaths.length} 个视频片段...`);
            await concatVideos(clipPaths, outputPath);

            // 清理临时文件
            for (const f of tempFiles) {
                try { fs.unlinkSync(f); } catch(e) {}
            }

            // 获取最终视频时长
            let finalDuration = 0;
            try {
                const durationStr = execSync(
                    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`,
                    { encoding: 'utf-8' }
                ).trim();
                finalDuration = parseFloat(durationStr) || 0;
            } catch(e) {}

            console.log(`  ✓ 超长片段视频生成完成，时长: ${finalDuration.toFixed(2)}s`);

            return {
                success: true,
                index: segment.index,
                path: outputPath,
                duration: finalDuration,
                multiClip: true,
                clipCount: numVideos
            };
        }

        // 普通片段：单个视频生成
        const apiVideoDuration = segmentDuration <= 6 ? 6 : 10;
        console.log(`  片段时长: ${segmentDuration.toFixed(2)}s → API 请求: ${apiVideoDuration}s`);

        // 创建视频生成任务
        const createResult = await createVideoTask({
            model: options.model || config.videoGeneration.minimax.model,
            firstFrameImage: firstFrameImage,
            prompt: segment.prompt,
            promptOptimizer: options.promptOptimizer !== false,
            duration: apiVideoDuration,
            aigcWatermark: options.aigcWatermark !== false // 默认添加水印
        });

        if (createResult.base_resp && createResult.base_resp.status_code !== 0) {
            throw new Error(`Create task failed: ${createResult.base_resp.status_msg}`);
        }

        const taskId = createResult.task_id;
        if (!taskId) {
            throw new Error('No task_id in response');
        }

        console.log(`Video task created: ${taskId}`);

        // 等待视频生成完成
        const completedResult = await waitForVideoCompletion(taskId, options.maxWaitMs);

        // 获取视频下载 URL
        // API 返回 file_id，需要调用 files/retrieve 接口获取下载 URL
        let videoUrl = null;

        // 先检查响应中是否直接包含 download_url
        if (completedResult.file && completedResult.file.download_url) {
            videoUrl = completedResult.file.download_url;
        } else if (completedResult.video && completedResult.video.download_url) {
            videoUrl = completedResult.video.download_url;
        } else if (completedResult.download_url) {
            videoUrl = completedResult.download_url;
        } else if (completedResult.file_id) {
            // 使用 file_id 获取下载 URL
            console.log(`Getting download URL for file_id: ${completedResult.file_id}`);
            videoUrl = await getVideoDownloadUrl(completedResult.file_id);
        }

        if (!videoUrl) {
            console.error('Completed result structure:', JSON.stringify(completedResult, null, 2).substring(0, 1000));
            throw new Error('No video URL in completed result');
        }

        console.log(`Downloading video from: ${videoUrl.substring(0, 80)}...`);
        await downloadVideo(videoUrl, outputPath);

        return {
            success: true,
            index: segment.index,
            path: outputPath,
            taskId: taskId,
            duration: completedResult.duration || 10
        };

    } catch (error) {
        console.error(`Video generation failed for segment ${segment.index}:`, error.message);
        return {
            success: false,
            index: segment.index,
            error: error.message
        };
    }
}

/**
 * 批量生成视频（支持失败后自动生成动画备份）
 * @param {array} segments - 需要生成视频的分段数组
 * @param {string} imageDir - 图片目录
 * @param {string} videoDir - 视频输出目录
 * @param {object} options - 配置选项
 * @param {function} onProgress - 进度回调
 * @returns {Promise<array>} 生成结果数组
 */
async function generateVideos(segments, imageDir, videoDir, options = {}, onProgress = null) {
    const results = [];
    const total = segments.length;
    const failedSegments = []; // 记录失败的片段，用于后续生成动画备份

    // 并发配置：RPM 30 = 每2秒1个请求，设置并发3-5较安全
    const concurrency = options.concurrency || 3;
    const delayMs = options.delayMs || 3000; // 批次间延迟，确保不超过 RPM 限制

    console.log(`视频生成配置: 并发数=${concurrency}, 批次延迟=${delayMs}ms`);

    // 确保输出目录存在
    if (!fs.existsSync(videoDir)) {
        fs.mkdirSync(videoDir, { recursive: true });
    }

    // 批量并行处理视频生成
    for (let i = 0; i < total; i += concurrency) {
        const batch = segments.slice(i, Math.min(i + concurrency, total));
        const batchStartIndex = i;

        console.log(`\n处理批次 ${Math.floor(i / concurrency) + 1}/${Math.ceil(total / concurrency)}, 包含 ${batch.length} 个视频...`);

        // 并行生成当前批次的视频
        const batchPromises = batch.map(async (segment, batchIndex) => {
            const paddedIndex = String(segment.index).padStart(3, '0');
            const imagePath = path.join(imageDir, `image_${paddedIndex}.png`);
            const outputPath = path.join(videoDir, `video_${paddedIndex}.mp4`);

            // 检查视频是否已存在（支持断点续传）
            if (fs.existsSync(outputPath) && options.skipExisting !== false) {
                const stat = fs.statSync(outputPath);
                if (stat.size > 10000) {  // 文件大于 10KB 认为有效
                    console.log(`  ⏭️ 片段 ${paddedIndex} 视频已存在，跳过`);
                    return {
                        success: true,
                        index: segment.index,
                        path: outputPath,
                        lyric: segment.lyric,
                        skipped: true
                    };
                }
            }

            const result = await generateVideo(segment, imagePath, outputPath, options);
            result.lyric = segment.lyric;

            // 如果失败，记录以便后续生成动画备份
            if (!result.success) {
                failedSegments.push(segment);
                console.log(`  ⚠️ 片段 ${paddedIndex} 视频生成失败，将生成动画备份`);
            }

            return result;
        });

        // 等待当前批次完成
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // 进度回调
        if (onProgress) {
            const completed = Math.min(i + concurrency, total);
            onProgress({
                completed: completed,
                total: total,
                percentage: Math.round((completed / total) * 100),
                lastResults: batchResults,
                failedCount: failedSegments.length
            });
        }

        // 批次间延迟（避免 API 频率限制）
        if (i + concurrency < total) {
            console.log(`等待 ${delayMs}ms 后处理下一批次...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    // 为失败的片段生成动画备份
    if (failedSegments.length > 0 && options.generateFallbackAnimation !== false) {
        console.log(`\n生成 ${failedSegments.length} 个动画备份...`);
        const imageAnimator = require('./image-animator');

        for (const segment of failedSegments) {
            const paddedIndex = String(segment.index).padStart(3, '0');
            try {
                const animResult = await imageAnimator.animateImage(
                    path.join(imageDir, `image_${paddedIndex}.png`),
                    path.join(videoDir, `animated_${paddedIndex}.mp4`),
                    segment.duration,
                    {}
                );
                console.log(`  ✓ 动画备份 ${paddedIndex}: ${animResult.effect}`);
            } catch (animError) {
                console.error(`  ✗ 动画备份 ${paddedIndex} 失败: ${animError.message}`);
            }
        }
    }

    return results;
}

/**
 * 检查视频 API 连接状态
 * @returns {Promise<boolean>}
 */
async function checkAPIConnection() {
    try {
        const apiKey = config.videoGeneration.minimax.apiKey;
        if (!apiKey) {
            return false;
        }
        // 简单检查 API key 格式
        return apiKey.length > 10;
    } catch (e) {
        return false;
    }
}

/**
 * 重新生成单个视频（支持自定义 prompt）
 * @param {object} segment - 分段数据
 * @param {string} imagePath - 首帧图片路径
 * @param {string} outputPath - 视频输出路径
 * @param {string} customPrompt - 自定义视频动作描述（可选）
 * @param {object} options - 配置选项
 * @returns {Promise<object>} 生成结果
 */
async function regenerateVideo(segment, imagePath, outputPath, customPrompt = null, options = {}) {
    console.log(`Regenerating video for segment ${segment.index}: ${segment.lyric.substring(0, 30)}...`);

    // 使用自定义 prompt 或原始 prompt
    const videoPrompt = customPrompt || segment.videoPrompt || segment.prompt || '';

    try {
        // 读取首帧图片
        if (!fs.existsSync(imagePath)) {
            throw new Error(`First frame image not found: ${imagePath}`);
        }
        const firstFrameImage = imageToBase64(imagePath);
        const segmentDuration = segment.duration || segment.videoDuration || 6;

        // 检查是否是超长片段 (需要多个视频拼接)
        if (segmentDuration > LONG_SEGMENT_THRESHOLD) {
            console.log(`  Regenerating long segment (${segmentDuration.toFixed(2)}s > ${LONG_SEGMENT_THRESHOLD}s)`);

            const numVideos = Math.ceil(segmentDuration / 10);
            const tempDir = path.dirname(outputPath);
            const clipPaths = [];
            const tempFiles = [];

            let currentFirstFrame = firstFrameImage;

            for (let i = 0; i < numVideos; i++) {
                const clipPath = path.join(tempDir, `temp_regen_clip_${segment.index}_${i}_${Date.now()}.mp4`);
                tempFiles.push(clipPath);

                console.log(`  [${i + 1}/${numVideos}] Regenerating video clip...`);

                try {
                    await generateSingleVideoClip(currentFirstFrame, videoPrompt, clipPath, 10, options);
                    clipPaths.push(clipPath);

                    if (i < numVideos - 1) {
                        const lastFramePath = path.join(tempDir, `temp_regen_lastframe_${segment.index}_${i}_${Date.now()}.png`);
                        tempFiles.push(lastFramePath);
                        await extractLastFrame(clipPath, lastFramePath);
                        currentFirstFrame = imageToBase64(lastFramePath);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                    }
                } catch (clipError) {
                    for (const f of tempFiles) {
                        try { fs.unlinkSync(f); } catch(e) {}
                    }
                    throw clipError;
                }
            }

            await concatVideos(clipPaths, outputPath);

            for (const f of tempFiles) {
                try { fs.unlinkSync(f); } catch(e) {}
            }

            let finalDuration = 0;
            try {
                const durationStr = execSync(
                    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`,
                    { encoding: 'utf-8' }
                ).trim();
                finalDuration = parseFloat(durationStr) || 0;
            } catch(e) {}

            return {
                success: true,
                index: segment.index,
                path: outputPath,
                duration: finalDuration,
                videoPrompt: videoPrompt,
                multiClip: true,
                clipCount: numVideos
            };
        }

        // 普通片段：单个视频生成
        const apiVideoDuration = segmentDuration <= 6 ? 6 : 10;
        console.log(`  Segment duration: ${segmentDuration.toFixed(2)}s → API request: ${apiVideoDuration}s`);
        console.log(`  Video prompt: ${videoPrompt.substring(0, 80)}...`);

        const createResult = await createVideoTask({
            model: options.model || config.videoGeneration.minimax.model,
            firstFrameImage: firstFrameImage,
            prompt: videoPrompt,
            promptOptimizer: options.promptOptimizer !== false,
            duration: apiVideoDuration,
            aigcWatermark: options.aigcWatermark !== false
        });

        if (createResult.base_resp && createResult.base_resp.status_code !== 0) {
            throw new Error(`Create task failed: ${createResult.base_resp.status_msg}`);
        }

        const taskId = createResult.task_id;
        if (!taskId) {
            throw new Error('No task_id in response');
        }

        console.log(`  Video task created: ${taskId}`);

        const completedResult = await waitForVideoCompletion(taskId, options.maxWaitMs);

        let videoUrl = null;
        if (completedResult.file && completedResult.file.download_url) {
            videoUrl = completedResult.file.download_url;
        } else if (completedResult.video && completedResult.video.download_url) {
            videoUrl = completedResult.video.download_url;
        } else if (completedResult.download_url) {
            videoUrl = completedResult.download_url;
        } else if (completedResult.file_id) {
            videoUrl = await getVideoDownloadUrl(completedResult.file_id);
        }

        if (!videoUrl) {
            throw new Error('No video URL in completed result');
        }

        console.log(`  Downloading video...`);
        await downloadVideo(videoUrl, outputPath);

        return {
            success: true,
            index: segment.index,
            path: outputPath,
            taskId: taskId,
            duration: completedResult.duration || apiVideoDuration,
            videoPrompt: videoPrompt
        };

    } catch (error) {
        console.error(`Video regeneration failed for segment ${segment.index}:`, error.message);
        return {
            success: false,
            index: segment.index,
            error: error.message
        };
    }
}

module.exports = {
    generateVideo,
    generateVideos,
    regenerateVideo,
    createVideoTask,
    queryVideoTask,
    waitForVideoCompletion,
    downloadVideo,
    getVideoDownloadUrl,
    imageToBase64,
    checkAPIConnection
};
