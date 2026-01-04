/**
 * 阿里云 DashScope Qwen3-ASR-Flash 语音识别服务
 * 用于识别歌曲中的歌词和时间戳
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../config');

/**
 * 调用阿里云 DashScope Qwen3-ASR API
 * @param {string} audioBase64 - Base64 编码的音频数据
 * @param {string} mimeType - 音频 MIME 类型
 * @returns {Promise<object>} API 响应
 */
function callDashScopeASR(audioBase64, mimeType = 'audio/mpeg') {
    return new Promise((resolve, reject) => {
        const apiKey = config.aliyun?.dashscopeApiKey;
        if (!apiKey) {
            reject(new Error('阿里云 DashScope API Key 未配置'));
            return;
        }

        // 构建 data URI
        const audioDataUri = `data:${mimeType};base64,${audioBase64}`;

        const payload = {
            model: 'qwen3-asr-flash',
            input: {
                messages: [
                    {
                        role: 'user',
                        content: [
                            { audio: audioDataUri }
                        ]
                    }
                ]
            },
            parameters: {
                result_format: 'message'
            }
        };

        const payloadStr = JSON.stringify(payload);

        const options = {
            hostname: 'dashscope.aliyuncs.com',
            port: 443,
            path: '/api/v1/services/aigc/multimodal-generation/generation',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(payloadStr)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(result);
                } catch (e) {
                    reject(new Error('Invalid JSON response: ' + data.substring(0, 200)));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(180000, () => {
            req.destroy();
            reject(new Error('ASR 请求超时'));
        });
        req.write(payloadStr);
        req.end();
    });
}

/**
 * 根据标点符号分句
 * @param {string} text - 原始文本
 * @param {number} startTime - 开始时间
 * @param {number} endTime - 结束时间
 * @returns {array} 分句结果
 */
function splitBySentence(text, startTime, endTime) {
    const sentences = [];
    // 根据句号、问号、感叹号分割
    const sentencePattern = /[^。.！!？?]+[。.！!？?]?/g;
    const matches = text.match(sentencePattern);

    if (!matches || matches.length === 0) {
        return [{ text: text.trim(), startTime, endTime }];
    }

    const totalDuration = endTime - startTime;
    const totalChars = text.length;
    let currentTime = startTime;

    for (const match of matches) {
        const trimmed = match.trim();
        if (!trimmed) continue;

        // 按字符数比例估算时间
        const charRatio = match.length / totalChars;
        const duration = totalDuration * charRatio;
        const sentenceEndTime = currentTime + duration;

        sentences.push({
            text: trimmed,
            startTime: currentTime,
            endTime: sentenceEndTime,
            duration: sentenceEndTime - currentTime
        });

        currentTime = sentenceEndTime;
    }

    return sentences;
}

/**
 * 解析 ASR 响应，提取带时间戳的歌词
 * @param {object} response - ASR API 响应
 * @param {number} offsetSeconds - 时间偏移（用于分片处理）
 * @param {number} totalDuration - 音频总时长
 * @returns {array} 歌词数组
 */
function parseASRResponse(response, offsetSeconds = 0, totalDuration = 60) {
    const sentences = [];

    try {
        if (response.output && response.output.choices && response.output.choices[0]) {
            const choice = response.output.choices[0];
            const message = choice.message;

            if (message && message.content) {
                for (const item of message.content) {
                    if (item.text && !item.transcription) {
                        // 纯文本结果，根据标点符号分句
                        // 估算：假设歌词内容占音频的80%，前10%是前奏，后10%是尾奏
                        const estimatedStart = offsetSeconds + totalDuration * 0.1;
                        const estimatedEnd = offsetSeconds + totalDuration * 0.9;
                        console.log(`纯文本模式 - 估算时间范围: ${estimatedStart.toFixed(2)}s - ${estimatedEnd.toFixed(2)}s`);
                        const splitSentences = splitBySentence(item.text, estimatedStart, estimatedEnd);
                        sentences.push(...splitSentences);
                    }
                    if (item.transcription) {
                        // 带时间戳的转写结果
                        const trans = item.transcription;
                        console.log('检测到 transcription 数据:', JSON.stringify(trans, null, 2).substring(0, 500));
                        if (trans.sentences) {
                            console.log(`transcription.sentences 模式 - 共 ${trans.sentences.length} 句`);
                            for (const sent of trans.sentences) {
                                const sentStartTime = (sent.begin_time || 0) / 1000 + offsetSeconds;
                                const sentEndTime = (sent.end_time || 0) / 1000 + offsetSeconds;
                                console.log(`  句子: "${sent.text.substring(0, 20)}..." 时间: ${sentStartTime.toFixed(2)}s - ${sentEndTime.toFixed(2)}s`);
                                const splitSentences = splitBySentence(sent.text, sentStartTime, sentEndTime);
                                sentences.push(...splitSentences);
                            }
                        } else if (trans.text) {
                            console.log('transcription.text 模式（无时间戳）');
                            const splitSentences = splitBySentence(trans.text, offsetSeconds, offsetSeconds + totalDuration);
                            sentences.push(...splitSentences);
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('解析 ASR 响应失败:', e.message);
    }

    return sentences;
}

/**
 * 转换音频为适合 ASR 的格式
 * @param {string} inputPath - 输入音频路径
 * @param {string} outputPath - 输出音频路径
 * @returns {boolean} 是否成功
 */
function convertAudioForASR(inputPath, outputPath) {
    try {
        // 转换为 16k 采样率，单声道，mp3 格式
        execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -b:a 64k "${outputPath}"`, { stdio: 'ignore' });

        const stats = fs.statSync(outputPath);
        const sizeMB = stats.size / (1024 * 1024);

        // 如果文件太大，进一步压缩
        if (sizeMB > 10) {
            console.log(`文件 ${sizeMB.toFixed(2)} MB 超过限制，进一步压缩...`);
            const tempPath = outputPath.replace('.mp3', '_temp.mp3');
            execSync(`ffmpeg -y -i "${outputPath}" -ar 16000 -ac 1 -b:a 32k "${tempPath}"`, { stdio: 'ignore' });
            fs.unlinkSync(outputPath);
            fs.renameSync(tempPath, outputPath);
        }

        return true;
    } catch (e) {
        console.error('音频转换失败:', e.message);
        return false;
    }
}

/**
 * 获取音频时长
 * @param {string} filePath - 音频文件路径
 * @returns {number} 时长（秒）
 */
function getAudioDuration(filePath) {
    try {
        const result = execSync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
            { encoding: 'utf-8' }
        );
        return parseFloat(result.trim()) || 0;
    } catch (e) {
        return 0;
    }
}

/**
 * 分割音频为多个片段
 * @param {string} inputPath - 输入音频路径
 * @param {string} outputDir - 输出目录
 * @param {number} segmentDuration - 每段时长（秒）
 * @returns {array} 片段信息数组
 */
function splitAudio(inputPath, outputDir, segmentDuration = 60) {
    const segments = [];
    try {
        const duration = getAudioDuration(inputPath);
        const segmentCount = Math.ceil(duration / segmentDuration);

        for (let i = 0; i < segmentCount; i++) {
            const startTime = i * segmentDuration;
            const outputPath = path.join(outputDir, `segment_${i}_${Date.now()}.mp3`);
            execSync(
                `ffmpeg -y -i "${inputPath}" -ss ${startTime} -t ${segmentDuration} -ar 16000 -ac 1 -b:a 64k "${outputPath}"`,
                { stdio: 'ignore' }
            );
            segments.push({
                path: outputPath,
                startTime: startTime
            });
        }
    } catch (e) {
        console.error('分割音频失败:', e.message);
    }
    return segments;
}

/**
 * 同步识别音频（主入口）
 * @param {string} audioPath - 音频文件路径
 * @param {string} tempDir - 临时目录
 * @returns {Promise<object>} 识别结果
 */
async function recognizeAudio(audioPath, tempDir) {
    console.log('使用阿里云 Qwen3-ASR-Flash 识别音频...');

    // 转换音频格式
    const convertedPath = path.join(tempDir, `converted_${Date.now()}.mp3`);
    const converted = convertAudioForASR(audioPath, convertedPath);

    if (!converted) {
        throw new Error('音频格式转换失败');
    }

    const duration = getAudioDuration(convertedPath);
    console.log(`音频时长: ${duration.toFixed(2)} 秒`);

    let allLyrics = [];

    // 如果音频超过 2.5 分钟，分片处理
    if (duration > 150) {
        console.log('音频较长，分片处理...');
        const segments = splitAudio(convertedPath, tempDir, 60);

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            console.log(`处理片段 ${i + 1}/${segments.length}...`);

            try {
                const segmentData = fs.readFileSync(segment.path);
                const base64Data = segmentData.toString('base64');

                const result = await callDashScopeASR(base64Data, 'audio/mpeg');

                if (result.code) {
                    console.error(`片段 ${i + 1} 识别失败:`, result.message);
                    continue;
                }

                const lyrics = parseASRResponse(result, segment.startTime, 60);
                allLyrics.push(...lyrics);
            } catch (e) {
                console.error(`片段 ${i + 1} 处理出错:`, e.message);
            }

            // 清理片段文件
            try { fs.unlinkSync(segment.path); } catch (e) {}
        }
    } else {
        // 直接处理整个文件
        const audioData = fs.readFileSync(convertedPath);
        const base64Data = audioData.toString('base64');

        console.log(`发送到 ASR 的数据大小: ${(audioData.length / 1024 / 1024).toFixed(2)} MB`);

        const result = await callDashScopeASR(base64Data, 'audio/mpeg');

        console.log('ASR 响应状态:', result.code ? 'Error: ' + result.message : 'Success');

        // 调试：输出 ASR 原始返回数据
        console.log('ASR 原始返回:', JSON.stringify(result, null, 2));

        if (result.code) {
            throw new Error(result.message || 'ASR 调用失败');
        }

        allLyrics = parseASRResponse(result, 0, duration);
    }

    // 清理临时文件
    try { fs.unlinkSync(convertedPath); } catch (e) {}

    console.log(`识别完成，共 ${allLyrics.length} 句`);

    return {
        lyrics: allLyrics,
        duration: duration
    };
}

/**
 * 将歌词数组转换为 LRC 格式
 * @param {array} lyrics - 歌词数组
 * @returns {string} LRC 格式字符串
 */
function toLRC(lyrics) {
    const lines = [];

    for (const lyric of lyrics) {
        const mins = Math.floor(lyric.startTime / 60);
        const secs = Math.floor(lyric.startTime % 60);
        const ms = Math.floor((lyric.startTime % 1) * 100);

        const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
        lines.push(`[${timeStr}]${lyric.text}`);
    }

    return lines.join('\n');
}

module.exports = {
    recognizeAudio,
    callDashScopeASR,
    parseASRResponse,
    toLRC
};
