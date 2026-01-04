/**
 * MV Studio - 统一服务入口
 * 整合歌词识别和 MV 生成的一站式服务
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./src/config');
const aliyunASR = require('./src/lyrics/aliyun-asr-service');
const audioConverter = require('./src/lyrics/audio-converter');
const lyricsSlicer = require('./src/lyrics/lyrics-slicer');
const { MVPipeline, ProjectStatus } = require('./src/mv/mv-pipeline');
const imageGenerator = require('./src/mv/image-generator');

const PORT = config.server.port;

// 存储活动项目
const activeProjects = new Map();

// MIME 类型映射
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav'
};

// 临时文件目录
const TEMP_DIR = path.join(__dirname, config.paths.temp);
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * 解析手动输入的歌词（支持 LRC 格式和纯文本）
 * @param {string} text - 歌词文本
 * @param {number} audioDuration - 音频时长（秒）
 * @returns {array} 歌词数组
 */
function parseLyricsInput(text, audioDuration = 180) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const lyrics = [];

    // 检测是否为 LRC 格式
    const lrcPattern = /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/;
    let hasLrcFormat = false;

    for (const line of lines) {
        const match = line.match(lrcPattern);
        if (match) {
            hasLrcFormat = true;
            const mins = parseInt(match[1]);
            const secs = parseInt(match[2]);
            const ms = match[3] ? parseInt(match[3].padEnd(3, '0')) / 1000 : 0;
            const startTime = mins * 60 + secs + ms;
            const text = match[4].trim();

            if (text) {
                lyrics.push({
                    startTime,
                    endTime: startTime + 5, // 临时值，后面会修正
                    duration: 5,
                    text
                });
            }
        }
    }

    // 如果是 LRC 格式，修正结束时间
    if (hasLrcFormat && lyrics.length > 0) {
        for (let i = 0; i < lyrics.length - 1; i++) {
            lyrics[i].endTime = lyrics[i + 1].startTime;
            lyrics[i].duration = lyrics[i].endTime - lyrics[i].startTime;
        }
        // 最后一句
        const last = lyrics[lyrics.length - 1];
        last.endTime = Math.min(last.startTime + 10, audioDuration);
        last.duration = last.endTime - last.startTime;

        return lyrics;
    }

    // 纯文本格式：均匀分配时间
    const textLines = lines.filter(l => !l.startsWith('['));
    if (textLines.length === 0) {
        return [];
    }

    const avgDuration = audioDuration / textLines.length;
    let currentTime = 0;

    for (const line of textLines) {
        if (line.trim()) {
            lyrics.push({
                startTime: currentTime,
                endTime: currentTime + avgDuration,
                duration: avgDuration,
                text: line.trim()
            });
            currentTime += avgDuration;
        }
    }

    return lyrics;
}

/**
 * 解析请求体
 */
function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const contentType = req.headers['content-type'] || '';

            if (contentType.includes('multipart/form-data')) {
                const boundary = contentType.split('boundary=')[1];
                if (boundary) {
                    resolve(parseMultipart(buffer, boundary));
                } else {
                    reject(new Error('No boundary found'));
                }
            } else if (contentType.includes('application/json')) {
                try {
                    resolve(JSON.parse(buffer.toString()));
                } catch (e) {
                    reject(new Error('Invalid JSON'));
                }
            } else {
                resolve({ raw: buffer });
            }
        });
        req.on('error', reject);
    });
}

/**
 * 解析 multipart 数据
 */
function parseMultipart(buffer, boundary) {
    const parts = [];
    const boundaryBuffer = Buffer.from('--' + boundary);

    let start = buffer.indexOf(boundaryBuffer);
    while (start !== -1) {
        const end = buffer.indexOf(boundaryBuffer, start + boundaryBuffer.length);
        if (end === -1) break;

        const part = buffer.slice(start + boundaryBuffer.length, end);
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
            const headers = part.slice(0, headerEnd).toString();
            const content = part.slice(headerEnd + 4, part.length - 2);

            const nameMatch = headers.match(/name="([^"]+)"/);
            const filenameMatch = headers.match(/filename="([^"]+)"/);

            if (nameMatch) {
                parts.push({
                    name: nameMatch[1],
                    filename: filenameMatch ? filenameMatch[1] : null,
                    data: content
                });
            }
        }

        start = end;
    }

    return { parts, isMultipart: true };
}

/**
 * 发送 JSON 响应
 */
function sendJSON(res, data, statusCode = 200) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/**
 * 发送错误响应
 */
function sendError(res, message, statusCode = 500) {
    sendJSON(res, { error: message }, statusCode);
}

/**
 * 创建服务器
 */
const server = http.createServer(async (req, res) => {
    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    try {
        // ==================== 歌词识别相关 API ====================

        // API: 上传音频并开始识别
        if (url.pathname === '/api/upload-audio' && req.method === 'POST') {
            const body = await parseBody(req);

            let audioData, filename = 'audio.mp3';

            if (body.isMultipart) {
                const audioPart = body.parts.find(p => p.name === 'audio');
                if (!audioPart) {
                    sendError(res, '未找到音频文件', 400);
                    return;
                }
                audioData = audioPart.data;
                filename = audioPart.filename || filename;
            } else {
                sendError(res, '请使用 multipart/form-data 上传', 400);
                return;
            }

            console.log(`收到音频文件: ${filename}, 大小: ${(audioData.length / 1024 / 1024).toFixed(2)} MB`);

            // 创建项目
            const pipeline = new MVPipeline();
            pipeline.initProjectDir();

            // 保存原始音频
            const originalAudioPath = path.join(pipeline.projectDir, filename);
            fs.writeFileSync(originalAudioPath, audioData);

            // 同时保存为 audio.mp3 供前端播放器使用
            const audioPlayerPath = path.join(pipeline.projectDir, 'audio.mp3');
            fs.writeFileSync(audioPlayerPath, audioData);

            // 转换音频格式（用于 ASR）
            const convertedAudioPath = path.join(pipeline.projectDir, 'audio_converted.wav');
            audioConverter.convertAudio(originalAudioPath, convertedAudioPath);

            // 获取音频时长
            const duration = audioConverter.getAudioDuration(originalAudioPath);

            // 存储项目
            activeProjects.set(pipeline.projectId, {
                pipeline,
                originalAudioPath,
                convertedAudioPath,
                duration
            });

            sendJSON(res, {
                projectId: pipeline.projectId,
                duration,
                message: '音频上传成功'
            });
            return;
        }

        // API: 开始 ASR 识别（阿里云 Qwen3-ASR-Flash 同步模式）
        if (url.pathname === '/api/recognize' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            project.pipeline.updateStatus(ProjectStatus.RECOGNIZING_LYRICS, 15);

            // 异步执行识别（不阻塞响应）
            (async () => {
                try {
                    console.log('开始阿里云 ASR 识别...');
                    const tempDir = path.dirname(project.originalAudioPath);
                    const result = await aliyunASR.recognizeAudio(project.originalAudioPath, tempDir);

                    // 智能切片
                    const slicedLyrics = lyricsSlicer.sliceLyrics(result.lyrics, project.duration);
                    project.rawLyrics = result.lyrics;
                    project.slicedLyrics = slicedLyrics;

                    // 生成 LRC
                    const lrcContent = lyricsSlicer.generateLRC(slicedLyrics);
                    project.lrcContent = lrcContent;
                    project.asrCompleted = true;

                    project.pipeline.updateStatus(ProjectStatus.LYRICS_READY, 25);
                    console.log(`ASR 识别完成，共 ${slicedLyrics.length} 句歌词`);
                } catch (error) {
                    console.error('ASR 识别失败:', error);
                    project.asrError = error.message;
                    project.asrCompleted = true;
                }
            })();

            sendJSON(res, {
                projectId,
                message: '识别已开始，请轮询获取结果',
                mode: 'async'
            });
            return;
        }

        // API: 获取识别结果
        if (url.pathname === '/api/get-result' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            // 检查识别是否完成
            if (project.asrError) {
                sendJSON(res, {
                    status: 'failed',
                    error: project.asrError
                });
                return;
            }

            if (project.asrCompleted && project.slicedLyrics) {
                sendJSON(res, {
                    status: 'completed',
                    lyrics: project.slicedLyrics,
                    lrcContent: project.lrcContent
                });
            } else {
                sendJSON(res, {
                    status: 'processing',
                    message: 'AI 正在识别歌词...'
                });
            }
            return;
        }

        // API: 更新歌词
        if (url.pathname === '/api/update-lyrics' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, lyrics, lrcContent } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            if (lyrics) {
                project.slicedLyrics = lyrics;
            }
            if (lrcContent) {
                project.lrcContent = lrcContent;
            }

            sendJSON(res, { success: true, message: '歌词已更新' });
            return;
        }

        // API: 更新单条歌词
        if (url.pathname === '/api/update-lyric' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, index, text } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            if (!project.slicedLyrics || index < 0 || index >= project.slicedLyrics.length) {
                sendError(res, '歌词索引无效', 400);
                return;
            }

            // 更新歌词文本
            project.slicedLyrics[index].text = text;

            // 重新生成 LRC
            project.lrcContent = lyricsSlicer.generateLRC(project.slicedLyrics);

            console.log(`歌词 #${index} 已更新: "${text}"`);

            sendJSON(res, {
                success: true,
                message: '歌词已更新',
                index,
                text
            });
            return;
        }

        // API: 添加歌词行
        if (url.pathname === '/api/add-lyric' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, afterIndex, lyric } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            if (!project.slicedLyrics) {
                project.slicedLyrics = [];
            }

            // 验证歌词数据
            if (!lyric || typeof lyric.text !== 'string') {
                sendError(res, '歌词数据无效', 400);
                return;
            }

            // 插入位置
            const insertIndex = afterIndex + 1;

            // 插入新歌词
            project.slicedLyrics.splice(insertIndex, 0, {
                startTime: lyric.startTime || 0,
                endTime: lyric.endTime || 5,
                duration: lyric.duration || 5,
                text: lyric.text
            });

            // 重新生成 LRC
            project.lrcContent = lyricsSlicer.generateLRC(project.slicedLyrics);

            console.log(`添加歌词 #${insertIndex}: "${lyric.text}"`);

            sendJSON(res, {
                success: true,
                message: '歌词已添加',
                insertedIndex: insertIndex,
                totalCount: project.slicedLyrics.length
            });
            return;
        }

        // API: 删除单条歌词
        if (url.pathname === '/api/delete-lyric' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, index } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            if (!project.slicedLyrics || index < 0 || index >= project.slicedLyrics.length) {
                sendError(res, '歌词索引无效', 400);
                return;
            }

            // 记录被删除的歌词
            const deletedLyric = project.slicedLyrics[index];
            console.log(`删除歌词 #${index}: "${deletedLyric.text}" (${deletedLyric.startTime}s - ${deletedLyric.endTime}s)`);

            // 从数组中移除
            project.slicedLyrics.splice(index, 1);

            // 重新生成 LRC
            project.lrcContent = lyricsSlicer.generateLRC(project.slicedLyrics);

            sendJSON(res, {
                success: true,
                message: '歌词已删除',
                deletedIndex: index,
                remainingCount: project.slicedLyrics.length
            });
            return;
        }

        // API: 更新歌词时间戳
        if (url.pathname === '/api/update-lyric-time' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, index, startTime, endTime } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            if (!project.slicedLyrics || index < 0 || index >= project.slicedLyrics.length) {
                sendError(res, '歌词索引无效', 400);
                return;
            }

            // 更新时间戳
            project.slicedLyrics[index].startTime = startTime;
            project.slicedLyrics[index].endTime = endTime;
            project.slicedLyrics[index].duration = endTime - startTime;

            // 重新生成 LRC
            project.lrcContent = lyricsSlicer.generateLRC(project.slicedLyrics);

            console.log(`时间戳 #${index} 已更新: ${startTime}s - ${endTime}s`);

            sendJSON(res, {
                success: true,
                message: '时间戳已更新',
                index,
                startTime,
                endTime
            });
            return;
        }

        // API: 导入歌词（手动输入）
        if (url.pathname === '/api/import-lyrics' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, lyricsText, audioDuration } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            if (!lyricsText || !lyricsText.trim()) {
                sendError(res, '歌词内容不能为空', 400);
                return;
            }

            const duration = audioDuration || project.duration || 180;

            // 解析歌词（支持 LRC 格式和纯文本）
            const lyrics = parseLyricsInput(lyricsText, duration);

            if (lyrics.length === 0) {
                sendError(res, '无法解析歌词内容', 400);
                return;
            }

            // 智能切片
            const slicedLyrics = lyricsSlicer.sliceLyrics(lyrics, duration);
            project.rawLyrics = lyrics;
            project.slicedLyrics = slicedLyrics;

            // 生成 LRC
            const lrcContent = lyricsSlicer.generateLRC(slicedLyrics);
            project.lrcContent = lrcContent;

            project.pipeline.updateStatus(ProjectStatus.LYRICS_READY, 25);

            console.log(`手动导入歌词: ${slicedLyrics.length} 句`);

            sendJSON(res, {
                success: true,
                lyrics: slicedLyrics,
                lrcContent: lrcContent
            });
            return;
        }

        // API: 导出 LRC
        if (url.pathname === '/api/export-lrc' && req.method === 'GET') {
            const projectId = url.searchParams.get('projectId');

            const project = activeProjects.get(projectId);
            if (!project || !project.lrcContent) {
                sendError(res, 'LRC 内容不存在', 404);
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': `attachment; filename="lyrics_${projectId}.lrc"`
            });
            res.end(project.lrcContent);
            return;
        }

        // ==================== MV 生成相关 API ====================

        // API: 开始 MV 生成（到图片确认环节）
        if (url.pathname === '/api/start-mv' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, options = {} } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            if (!project.lrcContent) {
                sendError(res, '请先完成歌词识别', 400);
                return;
            }

            // 异步启动生成流程（到图片确认环节）
            project.pipeline.runUntilImageConfirmation({
                lrcContent: project.lrcContent,
                audioPath: project.originalAudioPath,
                audioDuration: project.duration,
                storyboardOptions: options.storyboard || {},
                classifyOptions: options.classify || {},
                imageOptions: options.image || {}
            }).then(result => {
                console.log('图片生成完成，等待确认');
            }).catch(error => {
                console.error('生成失败:', error);
            });

            sendJSON(res, {
                projectId,
                message: 'MV 生成已开始'
            });
            return;
        }

        // API: 获取项目状态
        if (url.pathname === '/api/project-status' && req.method === 'GET') {
            const projectId = url.searchParams.get('projectId');

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            sendJSON(res, project.pipeline.getStatus());
            return;
        }

        // API: 获取图片列表（用于确认环节）
        if (url.pathname === '/api/get-images' && req.method === 'GET') {
            const projectId = url.searchParams.get('projectId');

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            const images = project.pipeline.getImagesForConfirmation();
            const confirmation = project.pipeline.data.imageConfirmation;

            sendJSON(res, {
                projectId,
                images,
                confirmation: {
                    confirmed: confirmation.confirmed.length,
                    pending: confirmation.pending.length,
                    regenerating: confirmation.regenerating.length,
                    total: images.length
                },
                globalStyle: project.pipeline.data.globalStyle,
                characterDescription: project.pipeline.data.characterDescription
            });
            return;
        }

        // API: 确认单张图片
        if (url.pathname === '/api/confirm-image' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, index } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            const result = project.pipeline.confirmImage(index);
            sendJSON(res, result);
            return;
        }

        // API: 确认所有图片
        if (url.pathname === '/api/confirm-all' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            const result = project.pipeline.confirmAllImages();
            sendJSON(res, result);
            return;
        }

        // API: 重新生成图片
        if (url.pathname === '/api/regenerate-image' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, index, newPrompt } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            try {
                const result = await project.pipeline.regenerateImage(index, newPrompt);
                sendJSON(res, result);
            } catch (error) {
                sendError(res, error.message);
            }
            return;
        }

        // API: 更新 Prompt
        if (url.pathname === '/api/update-prompt' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, index, newPrompt } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            const result = project.pipeline.updatePrompt(index, newPrompt);
            sendJSON(res, result);
            return;
        }

        // API: 继续生成 MV（图片确认后）- 生成视频
        if (url.pathname === '/api/continue-mv' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, options = {} } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            if (!project.pipeline.isAllImagesConfirmed()) {
                sendError(res, '请先确认所有图片', 400);
                return;
            }

            // 异步继续生成视频（会在视频生成后等待确认）
            project.pipeline.continueAfterImageConfirmation(
                project.originalAudioPath,
                {
                    videoOptions: {
                        allVideo: true,
                        ...(options.video || {})
                    }
                }
            ).then(result => {
                console.log('视频生成完成，等待确认:', result);
            }).catch(error => {
                console.error('视频生成失败:', error);
            });

            sendJSON(res, {
                projectId,
                message: '视频生成中，请等待'
            });
            return;
        }

        // API: 获取视频列表（用于确认）
        if (url.pathname === '/api/get-videos' && req.method === 'GET') {
            const projectId = url.searchParams.get('projectId');

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            const videos = project.pipeline.getVideosForConfirmation();
            const confirmation = project.pipeline.data.videoConfirmation || { confirmed: [], pending: [], regenerating: [] };

            sendJSON(res, {
                projectId,
                videos,
                confirmation: {
                    confirmed: confirmation.confirmed.length,
                    pending: confirmation.pending.length,
                    regenerating: confirmation.regenerating.length,
                    total: videos.length
                }
            });
            return;
        }

        // API: 确认单个视频
        if (url.pathname === '/api/confirm-video' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, index } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            const result = project.pipeline.confirmVideo(index);
            sendJSON(res, result);
            return;
        }

        // API: 确认所有视频
        if (url.pathname === '/api/confirm-all-videos' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            const result = project.pipeline.confirmAllVideos();
            sendJSON(res, result);
            return;
        }

        // API: 重新生成单个视频
        if (url.pathname === '/api/regenerate-video' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, index, videoPrompt } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            // 异步重新生成视频
            project.pipeline.regenerateVideo(index, videoPrompt)
                .then(result => {
                    console.log(`视频 ${index} 重新生成完成:`, result.success);
                })
                .catch(error => {
                    console.error(`视频 ${index} 重新生成失败:`, error);
                });

            sendJSON(res, {
                projectId,
                index,
                message: '视频重新生成中，请等待'
            });
            return;
        }

        // API: 更新视频 Prompt
        if (url.pathname === '/api/update-video-prompt' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, index, videoPrompt } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            const result = project.pipeline.updateVideoPrompt(index, videoPrompt);
            sendJSON(res, result);
            return;
        }

        // API: 视频确认后继续合成 MV
        if (url.pathname === '/api/continue-after-videos' && req.method === 'POST') {
            const body = await parseBody(req);
            const { projectId, options = {} } = body;

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            if (!project.pipeline.isAllVideosConfirmed()) {
                sendError(res, '请先确认所有视频', 400);
                return;
            }

            // 异步合成 MV
            project.pipeline.continueAfterVideoConfirmation(
                project.originalAudioPath,
                {
                    composeOptions: options.compose || {}
                }
            ).then(result => {
                console.log('MV 合成完成:', result);
            }).catch(error => {
                console.error('MV 合成失败:', error);
            });

            sendJSON(res, {
                projectId,
                message: 'MV 合成中，请等待'
            });
            return;
        }

        // API: 下载 MV
        if (url.pathname === '/api/download-mv' && req.method === 'GET') {
            const projectId = url.searchParams.get('projectId');

            const project = activeProjects.get(projectId);
            if (!project) {
                sendError(res, '项目不存在', 404);
                return;
            }

            const outputPath = project.pipeline.data.outputPath;
            if (!outputPath || !fs.existsSync(outputPath)) {
                sendError(res, 'MV 文件不存在', 404);
                return;
            }

            const stat = fs.statSync(outputPath);
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Length': stat.size,
                'Content-Disposition': `attachment; filename="mv_${projectId}.mp4"`
            });
            fs.createReadStream(outputPath).pipe(res);
            return;
        }

        // API: 健康检查
        if (url.pathname === '/api/health' && req.method === 'GET') {
            const imageAnimator = require('./src/mv/image-animator');

            sendJSON(res, {
                status: 'ok',
                ffmpeg: imageAnimator.checkFFmpeg(),
                timestamp: new Date().toISOString()
            });
            return;
        }

        // API: 测试图片生成 API
        if (url.pathname === '/api/test-image-api' && req.method === 'GET') {
            console.log('测试图片生成 API...');
            try {
                const result = await imageGenerator.checkAPIConnection();
                sendJSON(res, {
                    success: result,
                    message: result ? 'API 连接正常' : 'API 连接失败，请检查控制台日志'
                });
            } catch (error) {
                console.error('API 测试失败:', error);
                sendJSON(res, {
                    success: false,
                    error: error.message
                });
            }
            return;
        }

        // ==================== 静态文件服务 ====================

        // 项目文件（图片、视频预览）
        if (url.pathname.startsWith('/projects/')) {
            const relativePath = url.pathname.replace('/projects/', '');
            const filePath = path.join(TEMP_DIR, relativePath);

            if (fs.existsSync(filePath)) {
                const ext = path.extname(filePath);
                const contentType = MIME_TYPES[ext] || 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': contentType });
                fs.createReadStream(filePath).pipe(res);
                return;
            }

            res.writeHead(404);
            res.end('File not found');
            return;
        }

        // 前端静态文件
        let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
        filePath = path.join(__dirname, 'public', filePath);

        const ext = path.extname(filePath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });

    } catch (error) {
        console.error('Server error:', error);
        sendError(res, error.message);
    }
});

server.listen(PORT, () => {
    console.log(`
${'='.repeat(50)}
  MV Studio 服务已启动
  打开浏览器访问: http://localhost:${PORT}
${'='.repeat(50)}

工作流程:
  1. 上传音频 → 自动识别歌词
  2. 编辑确认歌词
  3. AI 生成分镜和图片
  4. 确认/重新生成图片
  5. 生成 MV 视频
  6. 下载完成的 MV
`);
});
