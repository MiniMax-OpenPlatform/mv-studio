/**
 * 歌词智能切片模块
 * 识别前奏、歌词、间奏、尾奏
 */

/**
 * 智能切片歌词
 * @param {array} rawLyrics - 原始歌词数组
 * @param {number} audioDuration - 音频总时长
 * @returns {array} 切片后的歌词数组
 */
function sliceLyrics(rawLyrics, audioDuration) {
    const slices = [];

    if (rawLyrics.length === 0) {
        return slices;
    }

    // 检查前奏：第一句歌词前是否有足够长的空白
    const firstLyric = rawLyrics[0];
    if (firstLyric.startTime > 0.5) {
        slices.push({
            startTime: 0,
            endTime: firstLyric.startTime,
            duration: firstLyric.startTime,
            text: '[前奏]',
            specialType: 'prelude',
            index: slices.length + 1
        });
    }

    // 处理每句歌词
    for (let i = 0; i < rawLyrics.length; i++) {
        const lyric = rawLyrics[i];
        const nextLyric = rawLyrics[i + 1];

        // 添加当前歌词
        slices.push({
            startTime: lyric.startTime,
            endTime: lyric.endTime,
            duration: lyric.duration,
            text: lyric.text,
            specialType: null,
            index: slices.length + 1
        });

        // 检查是否有间奏：与下一句之间间隔超过 5 秒
        if (nextLyric && (nextLyric.startTime - lyric.endTime) > 5) {
            slices.push({
                startTime: lyric.endTime,
                endTime: nextLyric.startTime,
                duration: nextLyric.startTime - lyric.endTime,
                text: '[间奏]',
                specialType: 'interlude',
                index: slices.length + 1
            });
        }
    }

    // 检查尾奏：最后一句歌词后是否有足够长的空白
    const lastLyric = rawLyrics[rawLyrics.length - 1];
    if (audioDuration && (audioDuration - lastLyric.endTime) > 0.5) {
        slices.push({
            startTime: lastLyric.endTime,
            endTime: audioDuration,
            duration: audioDuration - lastLyric.endTime,
            text: '[尾奏]',
            specialType: 'outro',
            index: slices.length + 1
        });
    }

    // 重新编号
    slices.forEach((slice, i) => {
        slice.index = i + 1;
    });

    return slices;
}

/**
 * 格式化时间为显示格式
 * @param {number} seconds - 秒数
 * @returns {string} MM:SS.ss 格式
 */
function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

/**
 * 生成 LRC 格式歌词
 * @param {array} lyrics - 歌词数组
 * @param {object} metadata - 元数据（可选）
 * @returns {string} LRC 格式字符串
 */
function generateLRC(lyrics, metadata = {}) {
    const lines = [];

    // 添加元数据
    if (metadata.title) lines.push(`[ti:${metadata.title}]`);
    if (metadata.artist) lines.push(`[ar:${metadata.artist}]`);
    if (metadata.album) lines.push(`[al:${metadata.album}]`);

    // 添加歌词
    for (const lyric of lyrics) {
        const timeStr = formatTime(lyric.startTime);
        lines.push(`[${timeStr}]${lyric.text}`);
    }

    return lines.join('\n');
}

module.exports = {
    sliceLyrics,
    formatTime,
    generateLRC
};
