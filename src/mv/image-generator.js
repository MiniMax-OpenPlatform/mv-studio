/**
 * 图片生成模块
 * 基于 MiniMax Gemini API (nano_banana) 生成图片
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * API 配置
 */
const API_CONFIG = {
    baseUrl: 'api.minimax.io',
    model: 'g3-pro-image-preview',
    endpoint: '/v1/gemini/v1beta/models/g3-pro-image-preview:generateContent'
};

/**
 * 调用 MiniMax Gemini API 生成图片 (带重试)
 * @param {string} prompt - 图片描述
 * @param {object} options - 配置选项
 * @param {number} retries - 重试次数
 * @returns {Promise<object>} 响应数据
 */
function callImageAPI(prompt, options = {}, retries = 3) {
    return new Promise((resolve, reject) => {
        const token = config.imageGeneration.nanoBanana.apiKey;
        if (!token) {
            reject(new Error('MiniMax API token not configured'));
            return;
        }

        const aspectRatio = options.aspectRatio || config.imageGeneration.aspectRatio || '16:9';
        const imageSize = options.imageSize || '1K';

        // 构建请求内容
        const contentParts = [];

        // 如果有参考图片，添加到请求中
        if (options.referenceImage) {
            contentParts.push({
                inlineData: {
                    mimeType: 'image/png',
                    data: options.referenceImage
                }
            });
            // 添加参考指令
            contentParts.push({
                text: `[Reference image above - maintain the same person's face, hairstyle, and appearance in the new image]\n\n${prompt}`
            });
        } else {
            contentParts.push({ text: prompt });
        }

        const requestBody = {
            contents: [
                {
                    parts: contentParts,
                    role: 'user'
                }
            ],
            generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
                imageConfig: {
                    aspectRatio: aspectRatio,
                    imageSize: imageSize
                }
            }
        };

        // 如果有 subject_reference 配置（角色一致性）
        if (options.subjectReference) {
            requestBody.generationConfig.subjectReference = options.subjectReference;
        }

        const payload = JSON.stringify(requestBody);

        // 使用参考图片时增加超时时间
        const timeoutMs = options.referenceImage ? 300000 : 180000; // 5分钟 vs 3分钟

        const requestOptions = {
            hostname: API_CONFIG.baseUrl,
            port: 443,
            path: API_CONFIG.endpoint,
            method: 'POST',
            headers: {
                'X-Biz-Id': 'op',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: timeoutMs
        };

        const req = https.request(requestOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                // 处理 504 Gateway Timeout 和其他可重试的错误
                if (res.statusCode === 504 || res.statusCode === 502 || res.statusCode === 503) {
                    if (retries > 0) {
                        console.log(`    ↻ 网关超时 (${res.statusCode})，${retries}次重试后继续...`);
                        setTimeout(() => {
                            callImageAPI(prompt, options, retries - 1).then(resolve).catch(reject);
                        }, 5000); // 5秒后重试
                        return;
                    }
                }

                if (res.statusCode !== 200) {
                    console.error(`API HTTP Error ${res.statusCode}:`);
                    console.error(data.substring(0, 500));
                    reject(new Error(`API request failed with status ${res.statusCode}: ${data.substring(0, 300)}`));
                    return;
                }

                try {
                    const result = JSON.parse(data);
                    if (result.error) {
                        console.error('API Error Response:', JSON.stringify(result.error, null, 2));
                        reject(new Error(`API error: ${JSON.stringify(result.error)}`));
                        return;
                    }
                    // 成功响应的调试日志（只打印结构，不打印图片数据）
                    if (result.candidates && result.candidates.length > 0) {
                        const candidate = result.candidates[0];
                        console.log(`    ✓ API响应: finishReason=${candidate.finishReason}, parts=${candidate.content?.parts?.length || 0}`);
                    }
                    resolve(result);
                } catch (e) {
                    console.error('JSON Parse Error, raw data:', data.substring(0, 200));
                    reject(new Error(`JSON parse error: ${e.message}`));
                }
            });
        });

        req.on('error', (err) => {
            if (retries > 0 && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.message.includes('socket hang up'))) {
                console.log(`    ↻ 连接错误: ${err.message}，${retries}次重试后继续...`);
                setTimeout(() => {
                    callImageAPI(prompt, options, retries - 1).then(resolve).catch(reject);
                }, 5000);
            } else {
                reject(err);
            }
        });

        req.on('timeout', () => {
            req.destroy();
            if (retries > 0) {
                console.log(`    ↻ 请求超时，${retries}次重试后继续...`);
                setTimeout(() => {
                    callImageAPI(prompt, options, retries - 1).then(resolve).catch(reject);
                }, 5000);
            } else {
                reject(new Error('Request timeout after retries'));
            }
        });

        req.write(payload);
        req.end();
    });
}

/**
 * 从 API 响应中提取图片 Base64 数据
 * @param {object} response - API 响应
 * @returns {string|null} Base64 图片数据
 */
function extractImageData(response) {
    if (!response || typeof response !== 'object') {
        console.error('Invalid response format');
        return null;
    }

    if (response.error) {
        console.error('API returned error:', JSON.stringify(response.error, null, 2));
        return null;
    }

    // 打印响应结构用于调试
    if (response.promptFeedback) {
        console.error('Prompt feedback:', JSON.stringify(response.promptFeedback, null, 2));
    }

    const candidates = response.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
        // 打印完整响应以便诊断
        console.error('No candidates in response');
        console.error('Full response:', JSON.stringify(response, null, 2).substring(0, 1000));
        return null;
    }

    // 检查是否有 finishReason 表明问题
    const finishReason = candidates[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
        console.error(`Generation stopped: ${finishReason}`);
        if (candidates[0]?.safetyRatings) {
            console.error('Safety ratings:', JSON.stringify(candidates[0].safetyRatings, null, 2));
        }
    }

    const content = candidates[0]?.content;
    if (!content || !content.parts) {
        console.error('No content parts in response');
        console.error('Candidate:', JSON.stringify(candidates[0], null, 2).substring(0, 500));
        return null;
    }

    for (const part of content.parts) {
        if (part.inlineData && part.inlineData.data) {
            return part.inlineData.data;
        }
    }

    console.error('No image data found in response parts');
    console.error('Parts:', JSON.stringify(content.parts, null, 2).substring(0, 500));
    return null;
}

/**
 * 将 Base64 图片数据保存为文件
 * @param {string} base64Data - Base64 编码的图片数据
 * @param {string} outputPath - 输出文件路径
 * @returns {boolean} 是否成功
 */
function saveBase64Image(base64Data, outputPath) {
    try {
        // 移除可能的 data URI 前缀
        let data = base64Data;
        if (data.includes(',') && data.startsWith('data:')) {
            data = data.split(',')[1];
        }

        const buffer = Buffer.from(data, 'base64');

        // 确保目录存在
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(outputPath, buffer);
        return true;
    } catch (e) {
        console.error('Failed to save image:', e.message);
        return false;
    }
}

/**
 * 生成单张图片
 * @param {string} prompt - 图片描述
 * @param {string} outputPath - 输出路径
 * @param {object} options - 配置选项
 * @returns {Promise<object>} 生成结果
 */
async function generateImage(prompt, outputPath, options = {}) {
    console.log(`Generating image: ${prompt.substring(0, 50)}...`);

    try {
        const response = await callImageAPI(prompt, options);
        const imageData = extractImageData(response);

        if (!imageData) {
            throw new Error('Failed to extract image data from response');
        }

        const saved = saveBase64Image(imageData, outputPath);
        if (!saved) {
            throw new Error('Failed to save image file');
        }

        return {
            success: true,
            path: outputPath,
            prompt: prompt
        };
    } catch (error) {
        console.error(`Image generation failed: ${error.message}`);
        return {
            success: false,
            error: error.message,
            prompt: prompt
        };
    }
}

/**
 * 批量生成图片
 * @param {array} segments - 分段数据数组
 * @param {string} outputDir - 输出目录
 * @param {object} options - 配置选项
 * @param {function} onProgress - 进度回调
 * @returns {Promise<array>} 生成结果数组
 */
async function generateImages(segments, outputDir, options = {}, onProgress = null) {
    const results = [];
    const total = segments.length;
    const concurrency = options.concurrency || 2; // 并发数
    const delayMs = options.delayMs || 2000; // 请求间隔

    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // 添加全局风格后缀
    const globalStyleSuffix = options.globalStyleSuffix || '';
    const ethnicity = options.ethnicity || '';

    // 分批处理
    for (let i = 0; i < total; i += concurrency) {
        const batch = segments.slice(i, Math.min(i + concurrency, total));

        const batchPromises = batch.map(async (segment, batchIndex) => {
            const index = i + batchIndex;
            const paddedIndex = String(segment.index).padStart(3, '0');
            const outputPath = path.join(outputDir, `image_${paddedIndex}.png`);

            // 构建完整 prompt
            let fullPrompt = segment.prompt;

            // 如果有人物且未包含人种描述，添加人种描述
            if (segment.hasCharacter && ethnicity) {
                if (!fullPrompt.toLowerCase().includes(ethnicity.split(',')[0].toLowerCase())) {
                    fullPrompt = `${ethnicity}, ${fullPrompt}`;
                }
            }

            // 添加全局风格后缀
            if (globalStyleSuffix && !fullPrompt.includes(globalStyleSuffix)) {
                fullPrompt = `${fullPrompt}, ${globalStyleSuffix}`;
            }

            const result = await generateImage(fullPrompt, outputPath, options);
            result.index = segment.index;
            result.lyric = segment.lyric;

            return result;
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // 进度回调
        if (onProgress) {
            const progress = Math.min(i + concurrency, total);
            onProgress({
                completed: progress,
                total: total,
                percentage: Math.round((progress / total) * 100),
                lastResults: batchResults
            });
        }

        // 请求间隔（避免 API 频率限制）
        if (i + concurrency < total) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    return results;
}

/**
 * 清理空镜 prompt 中的人物相关描述
 * @param {string} prompt - 原始 prompt
 * @returns {string} 清理后的 prompt
 */
function cleanPromptForLandscape(prompt) {
    // 人物相关的词汇和短语（需要从空镜 prompt 中移除）
    const personPatterns = [
        // 人物名词
        /\b(woman|man|girl|boy|person|people|couple|lover|lovers|figure|figures|character|characters)\b/gi,
        /\b(she|he|her|his|their|them|they)\b/gi,
        /\b(face|faces|eyes|eye|lips|hair|hand|hands|arm|arms|body|skin)\b/gi,
        // 人物描述
        /\b(young|old|beautiful|handsome|elegant|gentle|slender|tall|short)\s+(woman|man|girl|boy|person|lady|gentleman)\b/gi,
        // 中国/亚洲面孔描述
        /chinese asian[^,]*/gi,
        /east asian[^,]*/gi,
        /asian (face|features|woman|man|girl|boy)[^,]*/gi,
        // 角色一致性标记
        /same character[^,]*/gi,
        /consistent appearance[^,]*/gi,
        // 服装相关（可能暗示人物）
        /wearing[^,]*/gi,
        /dressed in[^,]*/gi,
        // 人物动作
        /\b(standing|sitting|walking|running|looking|gazing|smiling|crying|holding|embracing|hugging)\b/gi,
        // 清理多余逗号
        /,\s*,/g,
        /^\s*,\s*/,
        /\s*,\s*$/,
    ];

    let cleaned = prompt;

    for (const pattern of personPatterns) {
        cleaned = cleaned.replace(pattern, '');
    }

    // 清理多余空格和逗号
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/,\s*,/g, ',');
    cleaned = cleaned.replace(/^\s*,\s*/, '');
    cleaned = cleaned.replace(/\s*,\s*$/, '');

    return cleaned;
}

/**
 * 检查 prompt 是否包含人物描述
 * @param {string} prompt - prompt 文本
 * @returns {boolean} 是否包含人物
 */
function promptContainsPerson(prompt) {
    const personKeywords = [
        'woman', 'man', 'girl', 'boy', 'person', 'people', 'couple', 'lover',
        'figure', 'character', 'face', 'asian face', 'chinese', 'standing',
        'sitting', 'walking', 'looking', 'gazing', 'smiling', 'embracing',
        'holding hands', 'together', 'her ', 'his ', 'she ', 'he '
    ];

    const lowerPrompt = prompt.toLowerCase();
    return personKeywords.some(keyword => lowerPrompt.includes(keyword));
}

/**
 * 生成带角色一致性的图片
 * 使用第一张包含人物的图片作为后续人物图片的参考
 * @param {array} segments - 分段数据
 * @param {string} outputDir - 输出目录
 * @param {object} storyboardData - 分镜数据（包含角色描述等）
 * @param {object} options - 配置选项
 * @param {function} onProgress - 进度回调
 */
async function generateImagesWithCharacter(segments, outputDir, storyboardData, options = {}, onProgress = null) {
    const { globalStyle, characterDescription, ethnicity } = storyboardData;

    // 构建全局风格后缀
    const styleParts = [];
    if (globalStyle) {
        if (globalStyle.quality) styleParts.push(globalStyle.quality);
        if (globalStyle.colorTone) styleParts.push(globalStyle.colorTone);
        if (globalStyle.aesthetic) styleParts.push(globalStyle.aesthetic);
    }
    const globalStyleSuffix = styleParts.join(', ');

    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const results = [];
    const total = segments.length;
    let referenceImageBase64 = null; // 存储第一张人物图片作为参考
    let firstCharacterImagePath = null;

    console.log(`开始生成 ${total} 张图片，使用角色参考功能...`);

    // 逐个生成图片，确保人物一致性
    for (let i = 0; i < total; i++) {
        const segment = segments[i];
        const paddedIndex = String(segment.index).padStart(3, '0');
        const outputPath = path.join(outputDir, `image_${paddedIndex}.png`);

        // 构建完整 prompt
        let fullPrompt = segment.prompt;

        // 判断场景类型
        const isCharacterScene = segment.hasCharacter === true;

        if (isCharacterScene) {
            // 人物场景：添加角色描述和一致性标记
            if (characterDescription && !fullPrompt.toLowerCase().includes(characterDescription.substring(0, 30).toLowerCase())) {
                fullPrompt = `${characterDescription}, same character, consistent appearance, ${fullPrompt}`;
            }

            // 添加人种描述
            if (ethnicity && !fullPrompt.toLowerCase().includes(ethnicity.split(',')[0].toLowerCase())) {
                fullPrompt = `${ethnicity}, ${fullPrompt}`;
            }
        } else {
            // 空镜场景：清理可能存在的人物描述
            if (promptContainsPerson(fullPrompt)) {
                const originalPrompt = fullPrompt;
                fullPrompt = cleanPromptForLandscape(fullPrompt);
                console.log(`  ⚠️ 清理空镜prompt中的人物描述`);
            }

            // 为空镜添加明确的无人物指示
            fullPrompt = `${fullPrompt}, no people, no person, no human figure, empty scene, landscape only`;
        }

        // 添加全局风格后缀
        if (globalStyleSuffix && !fullPrompt.includes(globalStyleSuffix.substring(0, 20))) {
            fullPrompt = `${fullPrompt}, ${globalStyleSuffix}`;
        }

        const sceneTypeLabel = isCharacterScene ? '👤 人物' : '🏞️ 空镜';

        console.log(`[${i + 1}/${total}] ${sceneTypeLabel} | ${segment.lyric.substring(0, 25)}...`);

        if (isCharacterScene && referenceImageBase64) {
            console.log(`  → 使用参考图片保持角色一致性`);
        } else if (!isCharacterScene) {
            console.log(`  → 环境/空镜场景，不使用人物参考`);
        }

        try {
            // 生成图片，如果是人物场景且有参考图片，则使用参考
            const generateOptions = { ...options };
            let useReference = segment.hasCharacter && referenceImageBase64;

            if (useReference) {
                generateOptions.referenceImage = referenceImageBase64;
            }

            let response;
            let imageData;

            try {
                response = await callImageAPI(fullPrompt, generateOptions);
                imageData = extractImageData(response);
            } catch (refError) {
                // 如果使用参考图片失败，尝试不使用参考图片重新生成
                if (useReference) {
                    console.log(`    ↻ 使用参考图片失败，尝试不使用参考图片...`);
                    delete generateOptions.referenceImage;
                    response = await callImageAPI(fullPrompt, generateOptions);
                    imageData = extractImageData(response);
                    useReference = false;
                } else {
                    throw refError;
                }
            }

            if (!imageData) {
                throw new Error('Failed to extract image data from response');
            }

            const saved = saveBase64Image(imageData, outputPath);
            if (!saved) {
                throw new Error('Failed to save image file');
            }

            // 如果这是第一张人物图片，保存为参考
            if (segment.hasCharacter && !referenceImageBase64) {
                referenceImageBase64 = imageData;
                firstCharacterImagePath = outputPath;
                console.log(`  ✓ 已保存为角色参考图片`);
            }

            results.push({
                success: true,
                index: segment.index,
                path: outputPath,
                prompt: fullPrompt,
                lyric: segment.lyric,
                hasCharacter: segment.hasCharacter,
                usedReference: useReference && firstCharacterImagePath !== outputPath
            });

        } catch (error) {
            console.error(`  ✗ 生成失败: ${error.message}`);
            results.push({
                success: false,
                index: segment.index,
                error: error.message,
                prompt: fullPrompt,
                lyric: segment.lyric
            });
        }

        // 进度回调
        if (onProgress) {
            onProgress({
                completed: i + 1,
                total: total,
                percentage: Math.round(((i + 1) / total) * 100),
                lastResult: results[results.length - 1],
                hasReference: !!referenceImageBase64
            });
        }

        // 请求间隔（避免 API 频率限制）
        if (i < total - 1) {
            await new Promise(resolve => setTimeout(resolve, options.delayMs || 2000));
        }
    }

    console.log(`图片生成完成: ${results.filter(r => r.success).length}/${total} 成功`);
    if (firstCharacterImagePath) {
        console.log(`角色参考图片: ${firstCharacterImagePath}`);
    }

    return results;
}

/**
 * 检查 API 连接
 * @returns {Promise<boolean>} 是否可用
 */
async function checkAPIConnection() {
    try {
        // 使用简单的测试 prompt
        const response = await callImageAPI('A simple blue square, minimal, test image', {
            aspectRatio: '1:1',
            imageSize: '1K'
        });
        return !!extractImageData(response);
    } catch (e) {
        console.error('API connection check failed:', e.message);
        return false;
    }
}

module.exports = {
    generateImage,
    generateImages,
    generateImagesWithCharacter,
    checkAPIConnection,
    extractImageData,
    saveBase64Image
};
