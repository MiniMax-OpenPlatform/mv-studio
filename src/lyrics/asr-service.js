/**
 * 腾讯云 ASR 语音识别服务
 * 用于识别歌曲中的歌词和时间戳
 */

const https = require('https');
const crypto = require('crypto');
const config = require('../config');

/**
 * 生成腾讯云 TC3 签名
 */
function generateSignature(secretId, secretKey, host, service, payload, timestamp, action) {
    const date = new Date(timestamp * 1000).toISOString().split('T')[0];

    const httpRequestMethod = 'POST';
    const canonicalUri = '/';
    const canonicalQueryString = '';
    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const hashedRequestPayload = crypto.createHash('sha256').update(payload).digest('hex');
    const canonicalRequest = `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;

    const algorithm = 'TC3-HMAC-SHA256';
    const credentialScope = `${date}/${service}/tc3_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

    const secretDate = crypto.createHmac('sha256', 'TC3' + secretKey).update(date).digest();
    const secretService = crypto.createHmac('sha256', secretDate).update(service).digest();
    const secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request').digest();
    const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');

    const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return authorization;
}

/**
 * 调用腾讯云 ASR API
 */
function callTencentAPI(action, payload) {
    return new Promise((resolve, reject) => {
        const secretId = config.tencent.secretId;
        const secretKey = config.tencent.secretKey;

        if (!secretId || !secretKey) {
            reject(new Error('腾讯云 API 密钥未配置'));
            return;
        }

        const host = 'asr.tencentcloudapi.com';
        const service = 'asr';
        const timestamp = Math.floor(Date.now() / 1000);
        const payloadStr = JSON.stringify(payload);

        const authorization = generateSignature(
            secretId,
            secretKey,
            host,
            service,
            payloadStr,
            timestamp,
            action
        );

        const options = {
            hostname: host,
            port: 443,
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Host': host,
                'X-TC-Action': action,
                'X-TC-Version': '2019-06-14',
                'X-TC-Timestamp': timestamp.toString(),
                'X-TC-Region': config.tencent.region,
                'Authorization': authorization
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Invalid JSON response'));
                }
            });
        });

        req.on('error', reject);
        req.write(payloadStr);
        req.end();
    });
}

/**
 * 创建语音识别任务
 * @param {string} audioBase64 - Base64 编码的音频数据
 * @returns {Promise<object>} 包含 taskId 的结果
 */
async function createRecognizeTask(audioBase64) {
    const result = await callTencentAPI('CreateRecTask', {
        EngineModelType: '16k_zh',
        ChannelNum: 1,
        ResTextFormat: 3, // 返回词级别时间戳
        SourceType: 1,
        Data: audioBase64
    });

    if (result.Response && result.Response.Error) {
        throw new Error(result.Response.Error.Message);
    }

    const taskId = result.Response?.Data?.TaskId;
    if (!taskId) {
        throw new Error('创建识别任务失败');
    }

    return { taskId };
}

/**
 * 查询识别任务状态
 * @param {number} taskId - 任务 ID
 * @returns {Promise<object>} 任务状态和结果
 */
async function getTaskResult(taskId) {
    const result = await callTencentAPI('DescribeTaskStatus', {
        TaskId: taskId
    });

    return result;
}

/**
 * 解析 ASR 结果为歌词格式
 * @param {object} asrResult - ASR 返回的结果
 * @param {number} audioDuration - 音频总时长（秒）
 * @returns {array} 歌词数组
 */
function parseASRResult(asrResult, audioDuration = 180) {
    const data = asrResult.Response?.Data;
    if (!data) {
        console.log('ASR 结果为空');
        return [];
    }

    const lyrics = [];

    // 优先使用 ResultDetail（包含时间戳的句子列表）
    if (data.ResultDetail && data.ResultDetail.length > 0) {
        console.log('使用 ResultDetail 解析，共', data.ResultDetail.length, '句');

        for (const sentence of data.ResultDetail) {
            // 获取真实开始时间（使用第一个词的偏移）
            let startTime = sentence.StartMs / 1000;
            let endTime = sentence.EndMs / 1000;

            if (sentence.Words && sentence.Words.length > 0) {
                const firstWord = sentence.Words[0];
                const lastWord = sentence.Words[sentence.Words.length - 1];

                if (firstWord.OffsetStartMs !== undefined) {
                    startTime = (sentence.StartMs + firstWord.OffsetStartMs) / 1000;
                }
                if (lastWord.OffsetEndMs !== undefined) {
                    endTime = (sentence.StartMs + lastWord.OffsetEndMs) / 1000;
                }
            }

            const text = sentence.FinalSentence || sentence.Text || '';

            if (text.trim()) {
                lyrics.push({
                    startTime,
                    endTime,
                    duration: endTime - startTime,
                    text: text.trim()
                });
            }
        }

        return lyrics;
    }

    // 回退：使用纯文本 Result（无时间戳，需要估算）
    if (data.Result) {
        console.log('使用 Result 纯文本解析（时间为估算值）');

        // 按标点符号分句
        const textContent = data.Result;
        const sentences = textContent.split(/(?<=[。！？!?，,；;])/);
        const validSentences = sentences.filter(s => s.trim());

        if (validSentences.length === 0) {
            return [];
        }

        // 均匀分配时间
        const avgDuration = audioDuration / validSentences.length;
        let currentTime = 0;

        for (const sentence of validSentences) {
            const text = sentence.trim();
            if (text) {
                lyrics.push({
                    startTime: currentTime,
                    endTime: currentTime + avgDuration,
                    duration: avgDuration,
                    text: text
                });
                currentTime += avgDuration;
            }
        }

        return lyrics;
    }

    console.log('ASR 结果中无有效数据');
    return [];
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
    createRecognizeTask,
    getTaskResult,
    parseASRResult,
    toLRC
};
