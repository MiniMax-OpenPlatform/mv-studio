/**
 * LRC 歌词解析模块
 * 支持标准 LRC 格式和增强 LRC 格式
 */

/**
 * 解析 LRC 时间戳
 * 支持格式: [mm:ss.xx] 或 [mm:ss.xxx] 或 [mm:ss]
 * @param {string} timeStr - 时间戳字符串，如 "01:23.45"
 * @returns {number} 秒数
 */
function parseTimeStamp(timeStr) {
    const match = timeStr.match(/(\d+):(\d+)(?:\.(\d+))?/);
    if (!match) return 0;

    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const milliseconds = match[3]
        ? parseInt(match[3].padEnd(3, '0').substring(0, 3), 10)
        : 0;

    return minutes * 60 + seconds + milliseconds / 1000;
}

/**
 * 格式化时间为 LRC 格式
 * @param {number} seconds - 秒数
 * @returns {string} 格式化的时间字符串
 */
function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

/**
 * 解析 LRC 元数据标签
 * @param {string} line - LRC 行
 * @returns {object|null} 元数据对象或 null
 */
function parseMetadata(line) {
    const metaTags = {
        'ti': 'title',
        'ar': 'artist',
        'al': 'album',
        'au': 'author',
        'by': 'creator',
        'offset': 'offset',
        'length': 'length'
    };

    const match = line.match(/^\[([a-z]+):(.+)\]$/i);
    if (match) {
        const tag = match[1].toLowerCase();
        const value = match[2].trim();
        if (metaTags[tag]) {
            return { [metaTags[tag]]: value };
        }
    }
    return null;
}

/**
 * 检测歌词语言
 * @param {string} text - 歌词文本
 * @returns {string} 语言代码
 */
function detectLanguage(text) {
    // 统计各语言字符占比
    const totalLength = text.replace(/\s/g, '').length;
    if (totalLength === 0) return 'unknown';

    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const japaneseChars = (text.match(/[\u3040-\u30ff\u31f0-\u31ff]/g) || []).length;
    const koreanChars = (text.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;

    const chineseRatio = chineseChars / totalLength;
    const japaneseRatio = japaneseChars / totalLength;
    const koreanRatio = koreanChars / totalLength;

    // 日语判断：包含平假名或片假名
    if (japaneseRatio > 0.1) return 'japanese';
    // 韩语判断
    if (koreanRatio > 0.2) return 'korean';
    // 中文判断
    if (chineseRatio > 0.3) return 'chinese';
    // 默认英语
    return 'english';
}

/**
 * 判断是否为特殊片段（前奏、间奏、尾奏等）
 * @param {string} text - 歌词文本
 * @returns {string|null} 特殊类型或 null
 */
function detectSpecialSegment(text) {
    const trimmed = text.trim().toLowerCase();

    const patterns = {
        'prelude': /^[\[【\(（]?(前奏|intro|prelude|opening)[\]】\)）]?$/i,
        'interlude': /^[\[【\(（]?(间奏|interlude|instrumental|music)[\]】\)）]?$/i,
        'outro': /^[\[【\(（]?(尾奏|outro|ending|尾声)[\]】\)）]?$/i,
        'bridge': /^[\[【\(（]?(桥段|bridge)[\]】\)）]?$/i,
        'chorus': /^[\[【\(（]?(副歌|chorus|hook)[\]】\)）]?$/i
    };

    for (const [type, pattern] of Object.entries(patterns)) {
        if (pattern.test(trimmed)) {
            return type;
        }
    }
    return null;
}

/**
 * 解析 LRC 文件内容
 * @param {string} lrcContent - LRC 文件内容
 * @param {number} totalDuration - 音频总时长（秒），用于计算最后一句的结束时间
 * @returns {object} 解析结果，包含 metadata 和 lyrics
 */
function parseLRC(lrcContent, totalDuration = null) {
    const lines = lrcContent.split(/\r?\n/);
    const metadata = {};
    const lyrics = [];

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // 尝试解析元数据
        const meta = parseMetadata(trimmedLine);
        if (meta) {
            Object.assign(metadata, meta);
            continue;
        }

        // 解析歌词行 - 支持多时间戳格式 [00:01.00][00:02.00]歌词
        const timeMatches = trimmedLine.match(/\[(\d+:\d+(?:\.\d+)?)\]/g);
        if (!timeMatches) continue;

        // 提取歌词文本（去除所有时间戳）
        const text = trimmedLine.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();

        // 跳过空歌词（但保留特殊标记如 [前奏]）
        if (!text) continue;

        // 为每个时间戳创建一条歌词
        for (const timeMatch of timeMatches) {
            const timeStr = timeMatch.slice(1, -1); // 去除方括号
            const startTime = parseTimeStamp(timeStr);

            lyrics.push({
                startTime,
                endTime: null, // 稍后计算
                text,
                specialType: detectSpecialSegment(text)
            });
        }
    }

    // 按时间排序
    lyrics.sort((a, b) => a.startTime - b.startTime);

    // 计算每句的结束时间（下一句的开始时间）
    for (let i = 0; i < lyrics.length; i++) {
        if (i < lyrics.length - 1) {
            lyrics[i].endTime = lyrics[i + 1].startTime;
        } else {
            // 最后一句：使用总时长或估算
            lyrics[i].endTime = totalDuration || (lyrics[i].startTime + 5);
        }

        // 计算时长
        lyrics[i].duration = lyrics[i].endTime - lyrics[i].startTime;

        // 添加索引
        lyrics[i].index = i + 1;
    }

    // 检测整体语言
    const allText = lyrics.map(l => l.text).join('');
    const language = detectLanguage(allText);

    return {
        metadata,
        language,
        lyrics,
        totalLyrics: lyrics.length
    };
}

/**
 * 生成 LRC 文件内容
 * @param {object} data - 包含 metadata 和 lyrics 的对象
 * @returns {string} LRC 格式内容
 */
function generateLRC(data) {
    const lines = [];

    // 写入元数据
    if (data.metadata) {
        const tagMap = {
            'title': 'ti',
            'artist': 'ar',
            'album': 'al',
            'author': 'au',
            'creator': 'by'
        };
        for (const [key, value] of Object.entries(data.metadata)) {
            if (tagMap[key]) {
                lines.push(`[${tagMap[key]}:${value}]`);
            }
        }
    }

    // 写入歌词
    for (const lyric of data.lyrics) {
        const timeStr = formatTime(lyric.startTime);
        lines.push(`[${timeStr}]${lyric.text}`);
    }

    return lines.join('\n');
}

/**
 * 智能合并短句
 * 将连续的短句（时长小于阈值）合并，减少生成片段数量
 * @param {array} lyrics - 歌词数组
 * @param {number} minDuration - 最小时长阈值（秒）
 * @returns {array} 合并后的歌词数组
 */
function mergeShortLyrics(lyrics, minDuration = 2) {
    const merged = [];
    let buffer = null;

    for (const lyric of lyrics) {
        // 特殊片段不合并
        if (lyric.specialType) {
            if (buffer) {
                merged.push(buffer);
                buffer = null;
            }
            merged.push({ ...lyric });
            continue;
        }

        if (!buffer) {
            buffer = { ...lyric };
        } else if (buffer.duration < minDuration && lyric.duration < minDuration) {
            // 合并短句
            buffer.text += ' ' + lyric.text;
            buffer.endTime = lyric.endTime;
            buffer.duration = buffer.endTime - buffer.startTime;
        } else {
            merged.push(buffer);
            buffer = { ...lyric };
        }
    }

    if (buffer) {
        merged.push(buffer);
    }

    // 重新编号
    merged.forEach((item, index) => {
        item.index = index + 1;
    });

    return merged;
}

module.exports = {
    parseLRC,
    generateLRC,
    parseTimeStamp,
    formatTime,
    detectLanguage,
    detectSpecialSegment,
    mergeShortLyrics
};
