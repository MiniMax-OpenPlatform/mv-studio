/**
 * LLM 分镜 Prompt 生成模块
 * 将歌词转换为 AI 绘画 prompt
 */

const https = require('https');
const config = require('../config');

/**
 * 系统提示词
 */
const SYSTEM_PROMPT = `你是一个专业的MV分镜脚本师，擅长将歌词转化为视觉画面描述。你需要像真正的MV导演一样思考，合理安排人物镜头和空镜头的节奏。

## 你的任务
根据输入的歌词，为每一句生成对应的AI绘画prompt（分镜描述词）。

## 核心规则

### 1. 场景类型分配（最重要！⚠️）
MV不应该每个镜头都是人物特写！你需要像专业导演一样合理分配：

**人物镜头 (hasCharacter: true) - 约占 40-50%：**
- 歌词直接描述人物情感、动作、状态时使用
- 如"在我的怀里"、"你的眼里"、"两个人的篝火"
- 情感高潮、副歌部分可多用人物镜头

**空镜/环境镜头 (hasCharacter: false) - 约占 50-60%：**
- 歌词描述自然景观时：月光、湖面、春风、绿草、星空、雨水等
- 歌词描述抽象情感时：用意境画面代替，如"多少年以后如云般游走"用云朵飘动
- 歌词描述时间流逝时：用空镜表现，如落叶、日出日落、季节变换
- 特殊片段：[前奏]、[间奏]、[尾奏] 必须是空镜
- 连续人物镜头之间：插入空镜作为视觉缓冲

**分配示例：**
- "月光把爱恋洒满了湖面" → hasCharacter: false（重点是月光和湖面）
- "那里春风沉醉" → hasCharacter: false（描述春风和环境氛围）
- "那里绿草如茵" → hasCharacter: false（描述自然景色）
- "在你的眼里" → hasCharacter: true（直接涉及人物）
- "两个人的篝火照亮整个夜晚" → hasCharacter: true（人物互动场景）
- "多少年以后如云般游走" → hasCharacter: false（用云朵意境表达）
- "被吞没在月光如水的夜里" → hasCharacter: false（月光意境）

### 2. 角色一致性（仅限人物镜头）
当 hasCharacter: true 时，必须保证角色形象统一：

**定义详细的 characterDescription，包括：**
- 面部特征：脸型、眼睛、鼻子、嘴唇
- 发型发色：长度、颜色、造型
- 年龄气质：年龄段和整体感觉
- 服装风格：主要服装描述

**在人物场景的 prompt 中：**
- 开头引用 characterDescription 核心描述
- 加入 "same character, consistent appearance"

### 3. 人种与语言映射
- 中文歌词 → "Chinese Asian face, East Asian features, black hair, fair skin"
- 日文歌词 → "Japanese face, East Asian features"
- 韩文歌词 → "Korean face, East Asian features"

### 4. 空镜头描述要求
空镜头 (hasCharacter: false) 的 prompt 应该：
- 聚焦于环境、自然元素、意境表达
- 完全不提及任何人物、人、角色
- 可以有物品特写：手、信、花、月光下的湖面等
- 使用诗意的视觉语言描述氛围

### 5. 美学风格统一
所有分镜使用统一的：
- 画面风格（cinematic/realistic/dreamy）
- 色调倾向（warm/cool/moody）
- 画质描述（8K, cinematic lighting, film grain）

### 6. 场景连贯性
- 相邻场景有视觉过渡感
- 空镜与人物镜头交替出现
- 同一情绪段落使用相似的环境元素

## 输出格式
返回严格的JSON格式（不要markdown代码块）：
{
    "globalStyle": {
        "aesthetic": "整体美学风格",
        "colorTone": "色调描述",
        "quality": "画质描述"
    },
    "characterDescription": "详细角色描述（仅用于人物镜头）",
    "ethnicity": "人种描述",
    "storyboard": [
        {
            "index": 1,
            "lyric": "原歌词",
            "sceneType": "character/landscape/object/artistic",
            "prompt": "完整的生图prompt",
            "hasCharacter": true或false
        }
    ]
}`;

/**
 * 构建用户提示词
 */
function buildUserPrompt(lyrics, language, options = {}) {
    const ethnicityHint = config.ethnicityMapping[language] || 'diverse ethnicity';

    const lyricsData = lyrics.map((l, i) => ({
        index: i + 1,
        startTime: l.startTime.toFixed(2),
        endTime: l.endTime.toFixed(2),
        duration: l.duration.toFixed(2),
        text: l.text,
        specialType: l.specialType || null
    }));

    return `## 歌曲信息
- 歌曲语言：${language}
- 人物面孔要求：${ethnicityHint}
- 歌词数量：${lyrics.length} 句

## 歌词列表
${JSON.stringify(lyricsData, null, 2)}

${options.genre ? `## 歌曲风格\n${options.genre}` : ''}
${options.styleHint ? `## 期望画风\n${options.styleHint}` : ''}
${options.mood ? `## 情感基调\n${options.mood}` : ''}

## ⚠️ 最重要的要求：场景类型合理分配

### 1. 人物镜头 vs 空镜头比例
- 人物镜头 (hasCharacter: true)：约占 40-50%
- 空镜/环境镜头 (hasCharacter: false)：约占 50-60%

### 2. 判断标准
**设为空镜 (hasCharacter: false) 的情况：**
- 歌词描述自然景物：月光、湖面、春风、绿草、天空、星星、雨、雪等
- 歌词是抽象/比喻：如"如云般游走"用云的画面，"似水流年"用水流画面
- 特殊标记：[前奏]、[间奏]、[尾奏] 必须是空镜
- 需要视觉缓冲时：连续2个人物镜头后建议插入空镜

**设为人物镜头 (hasCharacter: true) 的情况：**
- 歌词明确涉及"我"、"你"、"他/她"、"两个人"等人称
- 歌词描述人物动作：拥抱、凝视、微笑、行走等
- 情感高潮、副歌核心部分

### 3. 角色一致性（仅人物镜头）
- characterDescription 要详细（面部、发型、服装）
- 人种特征：${ethnicityHint}
- 人物镜头的 prompt 开头加角色描述

### 4. 空镜头要求
- prompt 中不要出现任何人物描述
- 聚焦环境、自然、意境
- 可以有物品特写（手、信、花等）

5. 返回纯JSON，不要markdown代码块

请仔细分析每句歌词，合理判断是人物镜头还是空镜头，像真正的MV导演一样安排节奏！`;
}

/**
 * 调用 OpenAI API
 */
function callOpenAI(messages) {
    return new Promise((resolve, reject) => {
        const apiKey = config.llm.openai.apiKey;
        if (!apiKey) {
            reject(new Error('OpenAI API key not configured'));
            return;
        }

        const payload = JSON.stringify({
            model: config.llm.openai.model,
            messages,
            temperature: 0.7,
            max_tokens: 8000
        });

        const url = new URL(config.llm.openai.baseUrl + '/chat/completions');

        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.error) {
                        reject(new Error(result.error.message));
                    } else {
                        resolve(result.choices[0].message.content);
                    }
                } catch (e) {
                    reject(new Error('Invalid JSON response: ' + data.substring(0, 200)));
                }
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

/**
 * 调用 Gemini API
 */
function callGemini(messages) {
    return new Promise((resolve, reject) => {
        const apiKey = config.llm.gemini.apiKey;
        if (!apiKey) {
            reject(new Error('Gemini API key not configured'));
            return;
        }

        // 转换消息格式
        const contents = messages.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : msg.role,
            parts: [{ text: msg.content }]
        }));

        // Gemini 需要将 system 消息合并到第一个 user 消息
        if (contents[0].role === 'system') {
            const systemContent = contents.shift().parts[0].text;
            if (contents[0]) {
                contents[0].parts[0].text = systemContent + '\n\n' + contents[0].parts[0].text;
                contents[0].role = 'user';
            }
        }

        const payload = JSON.stringify({
            contents,
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 8000
            }
        });

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            port: 443,
            path: `/v1beta/models/${config.llm.gemini.model}:generateContent?key=${apiKey}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.error) {
                        let errorMsg = result.error.message || JSON.stringify(result.error);
                        console.error('Gemini API error:', errorMsg);
                        // 处理配额错误
                        if (res.statusCode === 429 || errorMsg.includes('quota')) {
                            errorMsg = 'Gemini API 配额已用完，请稍后重试或使用其他 LLM 服务';
                        }
                        reject(new Error(errorMsg));
                    } else {
                        const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (!text) {
                            console.error('Gemini response:', JSON.stringify(result).substring(0, 500));
                            reject(new Error('No content in Gemini response'));
                            return;
                        }
                        resolve(text);
                    }
                } catch (e) {
                    console.error('Gemini parse error:', data.substring(0, 500));
                    reject(new Error('Invalid JSON response: ' + e.message));
                }
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

/**
 * 调用 MiniMax LLM API (Text-01)
 */
function callMinimax(messages) {
    return new Promise((resolve, reject) => {
        const apiKey = config.llm.minimax.apiKey;
        if (!apiKey) {
            reject(new Error('MiniMax LLM API key not configured'));
            return;
        }

        const payload = JSON.stringify({
            model: config.llm.minimax.model,
            messages: messages.map(msg => ({
                role: msg.role === 'system' ? 'system' : (msg.role === 'assistant' ? 'assistant' : 'user'),
                content: msg.content
            })),
            temperature: 0.7,
            max_tokens: 8000
        });

        const options = {
            hostname: 'api.minimax.chat',
            port: 443,
            path: '/v1/text/chatcompletion_v2',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.base_resp && result.base_resp.status_code !== 0) {
                        const errorMsg = result.base_resp.status_msg || 'Unknown error';
                        console.error('MiniMax API error:', errorMsg);
                        reject(new Error(errorMsg));
                    } else if (result.choices && result.choices[0]) {
                        const text = result.choices[0].message?.content || '';
                        if (!text) {
                            console.error('MiniMax response:', JSON.stringify(result).substring(0, 500));
                            reject(new Error('No content in MiniMax response'));
                            return;
                        }
                        resolve(text);
                    } else {
                        console.error('MiniMax unexpected response:', JSON.stringify(result).substring(0, 500));
                        reject(new Error('Unexpected MiniMax response format'));
                    }
                } catch (e) {
                    console.error('MiniMax parse error:', data.substring(0, 500));
                    reject(new Error('Invalid JSON response: ' + e.message));
                }
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

/**
 * 解析 LLM 返回的 JSON
 */
function parseStoryboardResponse(response) {
    try {
        // 移除可能的 markdown 代码块标记
        let cleaned = response.trim();
        cleaned = cleaned.replace(/^```json?\s*/i, '');
        cleaned = cleaned.replace(/\s*```$/i, '');

        // 尝试提取 JSON 对象
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }

        return JSON.parse(cleaned);
    } catch (e) {
        console.error('解析分镜结果失败:', e.message);
        console.error('原始响应:', response.substring(0, 500));
        return null;
    }
}

/**
 * 后处理：确保人种描述正确
 */
function postProcessPrompts(storyboard, language) {
    const ethnicity = config.ethnicityMapping[language] || '';
    if (!ethnicity) return storyboard;

    if (storyboard.storyboard) {
        storyboard.storyboard = storyboard.storyboard.map(item => {
            // 如果是包含人物的场景，确保人种描述在开头
            if (item.hasCharacter && item.prompt) {
                // 检查是否已包含人种描述
                const hasEthnicity = ethnicity.split(',').some(term =>
                    item.prompt.toLowerCase().includes(term.trim().toLowerCase())
                );

                if (!hasEthnicity) {
                    // 在开头添加人种描述
                    item.prompt = `${ethnicity}, ${item.prompt}`;
                }
            }
            return item;
        });
    }

    // 确保 ethnicity 字段正确
    storyboard.ethnicity = ethnicity;

    return storyboard;
}

/**
 * 生成分镜
 * @param {array} lyrics - 解析后的歌词数组
 * @param {string} language - 语言代码
 * @param {object} options - 可选参数（genre, styleHint, mood）
 * @returns {object} 分镜结果
 */
async function generateStoryboard(lyrics, language, options = {}) {
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(lyrics, language, options) }
    ];

    let response;
    const provider = config.llm.provider;

    console.log(`使用 ${provider} 生成分镜...`);

    if (provider === 'openai') {
        response = await callOpenAI(messages);
    } else if (provider === 'gemini') {
        response = await callGemini(messages);
    } else if (provider === 'minimax') {
        response = await callMinimax(messages);
    } else {
        throw new Error(`Unsupported LLM provider: ${provider}`);
    }

    const storyboard = parseStoryboardResponse(response);
    if (!storyboard) {
        throw new Error('Failed to parse storyboard response');
    }

    // 后处理确保人种正确
    return postProcessPrompts(storyboard, language);
}

/**
 * 分批生成分镜（用于歌词数量过多的情况）
 * @param {array} lyrics - 歌词数组
 * @param {string} language - 语言代码
 * @param {object} options - 可选参数
 * @param {number} batchSize - 每批数量
 */
async function generateStoryboardBatched(lyrics, language, options = {}, batchSize = 15) {
    if (lyrics.length <= batchSize) {
        return generateStoryboard(lyrics, language, options);
    }

    console.log(`歌词数量 ${lyrics.length} 较多，分批处理...`);

    // 先生成全局风格（使用前几句）
    const firstBatch = lyrics.slice(0, Math.min(10, lyrics.length));
    const globalResult = await generateStoryboard(firstBatch, language, options);

    const globalStyle = globalResult.globalStyle;
    const characterDescription = globalResult.characterDescription;
    const allStoryboards = [...globalResult.storyboard];

    // 分批处理剩余歌词
    for (let i = batchSize; i < lyrics.length; i += batchSize) {
        const batch = lyrics.slice(i, i + batchSize);

        // 将全局风格作为额外约束
        const batchOptions = {
            ...options,
            styleHint: `${options.styleHint || ''}\n已确定的全局风格：${JSON.stringify(globalStyle)}\n角色描述：${characterDescription}`
        };

        const batchResult = await generateStoryboard(batch, language, batchOptions);

        // 调整索引
        if (batchResult.storyboard) {
            batchResult.storyboard.forEach(item => {
                item.index = item.index + i;
            });
            allStoryboards.push(...batchResult.storyboard);
        }

        // 避免 API 频率限制
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return {
        globalStyle,
        characterDescription,
        ethnicity: config.ethnicityMapping[language],
        storyboard: allStoryboards
    };
}

module.exports = {
    generateStoryboard,
    generateStoryboardBatched,
    SYSTEM_PROMPT
};
