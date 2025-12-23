/**
 * 智能分级模块
 * 根据歌词时长和类型，决定使用视频生成、图片动画还是静态图
 */

const config = require('../config');

/**
 * 渲染类型枚举
 */
const RenderType = {
    VIDEO: 'video',           // AI 视频生成（成本高，效果好）
    ANIMATION: 'animation',   // 图片 + Ken Burns 动画（成本低）
    STATIC: 'static'          // 静态图片（最低成本）
};

/**
 * 优先级枚举
 */
const Priority = {
    HIGH: 'high',       // 高潮、重点歌词
    MEDIUM: 'medium',   // 普通歌词
    LOW: 'low'          // 前奏、间奏等
};

/**
 * 分析歌词重要性
 * @param {object} lyric - 歌词对象
 * @param {number} index - 索引
 * @param {number} total - 总数
 * @returns {string} 优先级
 */
function analyzePriority(lyric, index, total) {
    // 特殊片段优先级较低
    if (lyric.specialType) {
        return Priority.LOW;
    }

    // 歌曲高潮部分（通常在 60%-80% 的位置）
    const position = index / total;
    if (position >= 0.5 && position <= 0.8) {
        return Priority.HIGH;
    }

    // 开头和结尾
    if (index <= 2 || index >= total - 2) {
        return Priority.MEDIUM;
    }

    // 根据时长判断
    if (lyric.duration >= 6) {
        return Priority.HIGH;
    }

    return Priority.MEDIUM;
}

/**
 * 确定渲染类型
 * @param {object} lyric - 歌词对象
 * @param {string} priority - 优先级
 * @param {object} options - 配置选项
 * @returns {string} 渲染类型
 */
function determineRenderType(lyric, priority, options = {}) {
    const { minVideoThreshold, minAnimationThreshold } = config.segmentation;
    const duration = lyric.duration;

    // 全视频模式：所有片段都使用 AI 视频
    if (options.allVideo) {
        return RenderType.VIDEO;
    }

    // 强制模式：全部使用某种类型
    if (options.forceType) {
        return options.forceType;
    }

    // 特殊片段：前奏/间奏/尾奏 使用动画
    if (lyric.specialType) {
        return duration >= minAnimationThreshold ? RenderType.ANIMATION : RenderType.STATIC;
    }

    // 高优先级 + 足够时长 → 视频
    if (priority === Priority.HIGH && duration >= minVideoThreshold) {
        return RenderType.VIDEO;
    }

    // 中等优先级 + 较长时长 → 视频
    if (priority === Priority.MEDIUM && duration >= minVideoThreshold * 1.5) {
        return RenderType.VIDEO;
    }

    // 时长足够 → 动画
    if (duration >= minAnimationThreshold) {
        return RenderType.ANIMATION;
    }

    // 短时长 → 静态
    return RenderType.STATIC;
}

/**
 * 计算视频时长
 * 根据歌词时长和 API 限制计算实际视频时长
 * @param {number} lyricDuration - 歌词时长（秒）
 * @param {number} maxDuration - 最大时长限制（秒）
 * @returns {number} 视频时长
 */
function calculateVideoDuration(lyricDuration, maxDuration = 10) {
    // 最小 3 秒，最大受 API 限制
    return Math.min(Math.max(lyricDuration, 3), maxDuration);
}

/**
 * 对歌词列表进行分类
 * @param {array} lyrics - 歌词数组
 * @param {array} storyboard - 分镜数组
 * @param {object} options - 配置选项
 * @returns {array} 分类后的数据
 */
function classifySegments(lyrics, storyboard, options = {}) {
    const total = lyrics.length;

    const classified = lyrics.map((lyric, index) => {
        // 找到对应的分镜
        const scene = storyboard.find(s => s.index === index + 1) || {};

        // 分析优先级
        const priority = analyzePriority(lyric, index, total);

        // 确定渲染类型
        const renderType = determineRenderType(lyric, priority, options);

        // 计算视频时长
        const videoDuration = renderType === RenderType.VIDEO
            ? calculateVideoDuration(lyric.duration)
            : null;

        return {
            index: index + 1,
            lyric: lyric.text,
            startTime: lyric.startTime,
            endTime: lyric.endTime,
            duration: lyric.duration,
            specialType: lyric.specialType,
            priority,
            renderType,
            videoDuration,
            prompt: scene.prompt || '',
            sceneType: scene.sceneType || 'unknown',
            hasCharacter: scene.hasCharacter || false
        };
    });

    return classified;
}

/**
 * 获取分类统计
 * @param {array} classified - 分类后的数据
 * @returns {object} 统计信息
 */
function getClassificationStats(classified) {
    const stats = {
        total: classified.length,
        byRenderType: {
            [RenderType.VIDEO]: 0,
            [RenderType.ANIMATION]: 0,
            [RenderType.STATIC]: 0
        },
        byPriority: {
            [Priority.HIGH]: 0,
            [Priority.MEDIUM]: 0,
            [Priority.LOW]: 0
        },
        estimatedCost: {
            videoCount: 0,
            imageCount: 0
        }
    };

    for (const item of classified) {
        stats.byRenderType[item.renderType]++;
        stats.byPriority[item.priority]++;

        // 估算成本
        if (item.renderType === RenderType.VIDEO) {
            stats.estimatedCost.videoCount++;
            stats.estimatedCost.imageCount++; // 视频也需要首帧图
        } else {
            stats.estimatedCost.imageCount++;
        }
    }

    return stats;
}

/**
 * 优化分类以控制成本
 * @param {array} classified - 分类后的数据
 * @param {object} budget - 预算限制
 * @returns {array} 优化后的分类
 */
function optimizeForBudget(classified, budget = {}) {
    const { maxVideos = 10, maxImages = 50 } = budget;

    let videoCount = classified.filter(c => c.renderType === RenderType.VIDEO).length;

    // 如果视频数量超过预算，降级部分为动画
    if (videoCount > maxVideos) {
        // 按优先级排序，保留最高优先级的视频
        const sorted = [...classified].sort((a, b) => {
            if (a.renderType !== RenderType.VIDEO) return 1;
            if (b.renderType !== RenderType.VIDEO) return -1;

            // 优先级排序
            const priorityOrder = { [Priority.HIGH]: 0, [Priority.MEDIUM]: 1, [Priority.LOW]: 2 };
            const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
            if (priorityDiff !== 0) return priorityDiff;

            // 时长排序（更长的优先）
            return b.duration - a.duration;
        });

        // 降级超出预算的视频
        let kept = 0;
        for (const item of sorted) {
            if (item.renderType === RenderType.VIDEO) {
                if (kept >= maxVideos) {
                    // 降级为动画
                    item.renderType = RenderType.ANIMATION;
                    item.videoDuration = null;
                } else {
                    kept++;
                }
            }
        }
    }

    return classified;
}

/**
 * 合并相邻的同类型短片段
 * 减少生成数量，提高效率
 * @param {array} classified - 分类后的数据
 * @param {number} mergeThreshold - 合并阈值（秒）
 * @returns {array} 合并后的数据
 */
function mergeAdjacentSegments(classified, mergeThreshold = 2) {
    const merged = [];
    let buffer = null;

    for (const item of classified) {
        if (!buffer) {
            buffer = { ...item };
            continue;
        }

        // 判断是否可以合并
        const canMerge =
            buffer.renderType === item.renderType &&
            buffer.renderType !== RenderType.VIDEO && // 视频不合并
            buffer.duration < mergeThreshold &&
            item.duration < mergeThreshold &&
            !buffer.specialType &&
            !item.specialType;

        if (canMerge) {
            // 合并
            buffer.lyric += ' ' + item.lyric;
            buffer.endTime = item.endTime;
            buffer.duration = buffer.endTime - buffer.startTime;
            buffer.prompt += '; ' + item.prompt;
        } else {
            merged.push(buffer);
            buffer = { ...item };
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
    RenderType,
    Priority,
    classifySegments,
    getClassificationStats,
    optimizeForBudget,
    mergeAdjacentSegments,
    calculateVideoDuration
};
