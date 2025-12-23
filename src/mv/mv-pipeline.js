/**
 * MV 制作主流程编排器
 * 整合版本：支持图片确认环节
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const lrcParser = require('./lrc-parser');
const storyboardGenerator = require('./storyboard-generator');
const segmentClassifier = require('./segment-classifier');
const imageGenerator = require('./image-generator');
const videoGenerator = require('./video-generator');
const imageAnimator = require('./image-animator');
const mvComposer = require('./mv-composer');

/**
 * 项目状态（扩展版，包含图片确认环节）
 */
const ProjectStatus = config.projectStatus;

/**
 * MV 制作管道类
 */
class MVPipeline {
    constructor(projectId = null) {
        this.projectId = projectId || uuidv4();
        this.projectDir = path.join(process.cwd(), config.paths.temp, this.projectId);
        this.status = ProjectStatus.CREATED;
        this.progress = 0;
        this.error = null;
        this.data = {
            // 图片确认状态
            imageConfirmation: {
                confirmed: [],    // 已确认的图片索引
                pending: [],      // 待确认的图片索引
                regenerating: []  // 正在重新生成的图片索引
            }
        };
        this.callbacks = {
            onProgress: null,
            onStatusChange: null,
            onError: null
        };
    }

    /**
     * 设置回调函数
     */
    setCallbacks(callbacks) {
        Object.assign(this.callbacks, callbacks);
    }

    /**
     * 更新状态
     */
    updateStatus(status, progress = null) {
        this.status = status;
        if (progress !== null) {
            this.progress = progress;
        }
        if (this.callbacks.onStatusChange) {
            this.callbacks.onStatusChange({
                projectId: this.projectId,
                status: this.status,
                progress: this.progress
            });
        }
        this.saveProjectData();
    }

    /**
     * 更新进度
     */
    updateProgress(progress, message = '') {
        this.progress = progress;
        if (this.callbacks.onProgress) {
            this.callbacks.onProgress({
                projectId: this.projectId,
                progress: this.progress,
                message: message
            });
        }
    }

    /**
     * 报告错误
     */
    reportError(error) {
        this.error = error;
        this.status = ProjectStatus.FAILED;
        if (this.callbacks.onError) {
            this.callbacks.onError({
                projectId: this.projectId,
                error: error.message || error
            });
        }
        this.saveProjectData();
    }

    /**
     * 初始化项目目录
     */
    initProjectDir() {
        const dirs = [
            this.projectDir,
            path.join(this.projectDir, 'images'),
            path.join(this.projectDir, 'videos'),
            path.join(this.projectDir, 'output')
        ];

        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }

    /**
     * 保存项目数据
     */
    saveProjectData() {
        const dataPath = path.join(this.projectDir, 'project.json');
        try {
            fs.writeFileSync(dataPath, JSON.stringify({
                projectId: this.projectId,
                status: this.status,
                progress: this.progress,
                data: this.data,
                error: this.error
            }, null, 2));
        } catch (e) {
            console.error('保存项目数据失败:', e.message);
        }
    }

    /**
     * 加载项目数据
     */
    loadProjectData() {
        const dataPath = path.join(this.projectDir, 'project.json');
        if (fs.existsSync(dataPath)) {
            const saved = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
            this.status = saved.status;
            this.progress = saved.progress;
            this.data = saved.data;
            this.error = saved.error;
            return true;
        }
        return false;
    }

    /**
     * 步骤 1: 解析 LRC 歌词
     */
    async parseLyrics(lrcContent, audioDuration = null) {
        this.updateStatus(ProjectStatus.GENERATING_STORYBOARD, 5);
        console.log('Step 1: Parsing LRC lyrics...');

        const result = lrcParser.parseLRC(lrcContent, audioDuration);

        this.data.lyrics = result.lyrics;
        this.data.language = result.language;
        this.data.metadata = result.metadata;
        this.data.lrcContent = lrcContent;

        console.log(`Parsed ${result.lyrics.length} lyrics, language: ${result.language}`);
        this.updateProgress(10, `解析完成: ${result.lyrics.length} 句歌词`);

        return result;
    }

    /**
     * 步骤 2: 生成分镜 Prompt
     */
    async generateStoryboard(options = {}) {
        this.updateStatus(ProjectStatus.GENERATING_STORYBOARD, 10);
        console.log('Step 2: Generating storyboard prompts...');

        const result = await storyboardGenerator.generateStoryboardBatched(
            this.data.lyrics,
            this.data.language,
            options
        );

        this.data.storyboard = result.storyboard;
        this.data.globalStyle = result.globalStyle;
        this.data.characterDescription = result.characterDescription;
        this.data.ethnicity = result.ethnicity;

        console.log(`Generated ${result.storyboard.length} storyboard prompts`);
        this.updateProgress(20, `生成 ${result.storyboard.length} 个分镜`);

        this.saveProjectData();
        return result;
    }

    /**
     * 步骤 3: 智能分级
     */
    classifySegments(options = {}) {
        console.log('Step 3: Classifying segments...');

        let classified = segmentClassifier.classifySegments(
            this.data.lyrics,
            this.data.storyboard,
            options
        );

        if (options.budget) {
            classified = segmentClassifier.optimizeForBudget(classified, options.budget);
        }

        if (options.mergeShort) {
            classified = segmentClassifier.mergeAdjacentSegments(classified);
        }

        const stats = segmentClassifier.getClassificationStats(classified);

        this.data.classifiedSegments = classified;
        this.data.classificationStats = stats;

        console.log('Classification stats:', stats);
        this.updateProgress(25, `分类完成: ${stats.byRenderType.video} 视频, ${stats.byRenderType.animation} 动画`);

        this.saveProjectData();
        return { classified, stats };
    }

    /**
     * 步骤 4: 生成图片
     */
    async generateImages(options = {}) {
        this.updateStatus(ProjectStatus.GENERATING_IMAGES, 25);
        console.log('Step 4: Generating images...');

        const imageDir = path.join(this.projectDir, 'images');

        const results = await imageGenerator.generateImagesWithCharacter(
            this.data.classifiedSegments,
            imageDir,
            {
                globalStyle: this.data.globalStyle,
                characterDescription: this.data.characterDescription,
                ethnicity: this.data.ethnicity
            },
            options,
            (progress) => {
                const overallProgress = 25 + (progress.percentage * 0.35);
                this.updateProgress(overallProgress, `生成图片: ${progress.completed}/${progress.total}`);
            }
        );

        const successCount = results.filter(r => r.success).length;
        this.data.imageResults = results;

        // 初始化图片确认状态：所有成功生成的图片都待确认
        this.data.imageConfirmation = {
            confirmed: [],
            pending: results.filter(r => r.success).map(r => r.index),
            regenerating: []
        };

        console.log(`Generated ${successCount}/${results.length} images`);
        this.updateProgress(60, `图片生成完成: ${successCount}/${results.length}`);

        // 进入等待图片确认状态
        this.updateStatus(ProjectStatus.AWAITING_IMAGE_CONFIRM, 60);

        this.saveProjectData();
        return results;
    }

    /**
     * 获取所有图片信息（用于确认环节）
     */
    getImagesForConfirmation() {
        const imageDir = path.join(this.projectDir, 'images');
        const images = [];

        for (const segment of this.data.classifiedSegments) {
            const paddedIndex = String(segment.index).padStart(3, '0');
            const imagePath = path.join(imageDir, `image_${paddedIndex}.png`);

            const imageResult = this.data.imageResults?.find(r => r.index === segment.index);

            images.push({
                index: segment.index,
                lyric: segment.lyric,
                startTime: segment.startTime,
                endTime: segment.endTime,
                duration: segment.duration,
                hasCharacter: segment.hasCharacter,
                prompt: segment.prompt,
                imagePath: imagePath,
                imageExists: fs.existsSync(imagePath),
                imageUrl: `/projects/${this.projectId}/images/image_${paddedIndex}.png`,
                confirmed: this.data.imageConfirmation.confirmed.includes(segment.index),
                success: imageResult?.success || false
            });
        }

        return images;
    }

    /**
     * 确认单张图片
     */
    confirmImage(index) {
        const confirmation = this.data.imageConfirmation;

        // 从 pending 移到 confirmed
        const pendingIdx = confirmation.pending.indexOf(index);
        if (pendingIdx !== -1) {
            confirmation.pending.splice(pendingIdx, 1);
        }

        if (!confirmation.confirmed.includes(index)) {
            confirmation.confirmed.push(index);
        }

        this.saveProjectData();

        return {
            confirmed: confirmation.confirmed.length,
            pending: confirmation.pending.length,
            total: this.data.classifiedSegments.length
        };
    }

    /**
     * 确认所有图片
     */
    confirmAllImages() {
        const confirmation = this.data.imageConfirmation;
        const allIndexes = this.data.classifiedSegments.map(s => s.index);

        confirmation.confirmed = allIndexes;
        confirmation.pending = [];

        this.saveProjectData();

        return {
            confirmed: confirmation.confirmed.length,
            pending: 0,
            total: this.data.classifiedSegments.length
        };
    }

    /**
     * 重新生成单张图片
     */
    async regenerateImage(index, newPrompt = null) {
        const segment = this.data.classifiedSegments.find(s => s.index === index);
        if (!segment) {
            throw new Error(`Segment ${index} not found`);
        }

        // 如果提供了新 prompt，更新它
        if (newPrompt) {
            segment.prompt = newPrompt;
            // 同时更新 storyboard 中的 prompt
            const storyboardItem = this.data.storyboard.find(s => s.index === index);
            if (storyboardItem) {
                storyboardItem.prompt = newPrompt;
            }
        }

        const confirmation = this.data.imageConfirmation;
        confirmation.regenerating.push(index);
        this.saveProjectData();

        const imageDir = path.join(this.projectDir, 'images');
        const paddedIndex = String(index).padStart(3, '0');
        const outputPath = path.join(imageDir, `image_${paddedIndex}.png`);

        console.log(`Regenerating image ${index}: ${segment.prompt.substring(0, 50)}...`);

        try {
            // 构建完整 prompt
            let fullPrompt = segment.prompt;

            if (segment.hasCharacter) {
                if (this.data.characterDescription) {
                    fullPrompt = `${this.data.characterDescription}, same character, consistent appearance, ${fullPrompt}`;
                }
                if (this.data.ethnicity) {
                    fullPrompt = `${this.data.ethnicity}, ${fullPrompt}`;
                }
            } else {
                fullPrompt = `${fullPrompt}, no people, no person, no human figure, empty scene`;
            }

            // 添加全局风格
            if (this.data.globalStyle) {
                const styleParts = [];
                if (this.data.globalStyle.quality) styleParts.push(this.data.globalStyle.quality);
                if (this.data.globalStyle.colorTone) styleParts.push(this.data.globalStyle.colorTone);
                if (this.data.globalStyle.aesthetic) styleParts.push(this.data.globalStyle.aesthetic);
                if (styleParts.length > 0) {
                    fullPrompt = `${fullPrompt}, ${styleParts.join(', ')}`;
                }
            }

            const result = await imageGenerator.generateImage(fullPrompt, outputPath, {});

            // 更新状态
            const regenIdx = confirmation.regenerating.indexOf(index);
            if (regenIdx !== -1) {
                confirmation.regenerating.splice(regenIdx, 1);
            }

            // 添加到 pending（需要重新确认）
            if (!confirmation.pending.includes(index)) {
                confirmation.pending.push(index);
            }
            // 从 confirmed 移除
            const confirmedIdx = confirmation.confirmed.indexOf(index);
            if (confirmedIdx !== -1) {
                confirmation.confirmed.splice(confirmedIdx, 1);
            }

            // 更新 imageResults
            const resultIdx = this.data.imageResults.findIndex(r => r.index === index);
            if (resultIdx !== -1) {
                this.data.imageResults[resultIdx] = {
                    ...result,
                    index: index,
                    lyric: segment.lyric
                };
            }

            this.saveProjectData();

            return {
                success: result.success,
                index: index,
                prompt: segment.prompt,
                imageUrl: `/projects/${this.projectId}/images/image_${paddedIndex}.png?t=${Date.now()}`
            };

        } catch (error) {
            // 移除 regenerating 状态
            const regenIdx = confirmation.regenerating.indexOf(index);
            if (regenIdx !== -1) {
                confirmation.regenerating.splice(regenIdx, 1);
            }
            this.saveProjectData();

            throw error;
        }
    }

    /**
     * 更新分镜 Prompt
     */
    updatePrompt(index, newPrompt) {
        const segment = this.data.classifiedSegments.find(s => s.index === index);
        if (segment) {
            segment.prompt = newPrompt;
        }

        const storyboardItem = this.data.storyboard.find(s => s.index === index);
        if (storyboardItem) {
            storyboardItem.prompt = newPrompt;
        }

        this.saveProjectData();

        return { success: true, index, prompt: newPrompt };
    }

    /**
     * 检查是否所有图片都已确认
     */
    isAllImagesConfirmed() {
        const confirmation = this.data.imageConfirmation;
        return confirmation.pending.length === 0 && confirmation.regenerating.length === 0;
    }

    /**
     * 步骤 5: 生成视频（需要图片确认后才能执行）
     */
    async generateVideos(options = {}) {
        if (!this.isAllImagesConfirmed()) {
            throw new Error('请先确认所有图片后再继续生成视频');
        }

        this.updateStatus(ProjectStatus.GENERATING_VIDEOS, 60);

        let videoSegments;

        if (options.allVideo) {
            console.log('Step 5: Generating AI videos (全视频模式)...');
            videoSegments = this.data.classifiedSegments;
        } else {
            console.log('Step 5: Generating AI videos...');
            videoSegments = this.data.classifiedSegments.filter(
                s => s.renderType === segmentClassifier.RenderType.VIDEO
            );
        }

        if (videoSegments.length === 0) {
            console.log('No video segments to generate');
            this.data.videoResults = [];
            return [];
        }

        console.log(`需要生成 ${videoSegments.length} 个 AI 视频`);

        const imageDir = path.join(this.projectDir, 'images');
        const videoDir = path.join(this.projectDir, 'videos');

        const results = await videoGenerator.generateVideos(
            videoSegments,
            imageDir,
            videoDir,
            {
                ...options,
                generateFallbackAnimation: true
            },
            (progress) => {
                const overallProgress = 60 + (progress.percentage * 0.25);
                this.updateProgress(overallProgress, `生成视频: ${progress.completed}/${progress.total}`);
            }
        );

        const successCount = results.filter(r => r.success).length;
        this.data.videoResults = results;

        console.log(`Generated ${successCount}/${results.length} AI videos`);
        this.updateProgress(85, `AI 视频生成完成: ${successCount}/${results.length}`);

        this.saveProjectData();
        return results;
    }

    /**
     * 步骤 6: 图片动画化
     */
    async animateImages(options = {}) {
        if (options.skipIfAllVideo && this.data.videoResults &&
            this.data.videoResults.length === this.data.classifiedSegments.length) {
            console.log('Step 6: Skipped (全视频模式)');
            this.data.animationResults = [];
            return [];
        }

        this.updateStatus(ProjectStatus.ANIMATING_IMAGES, 85);
        console.log('Step 6: Animating images...');

        const animationSegments = this.data.classifiedSegments.filter(
            s => s.renderType === segmentClassifier.RenderType.ANIMATION ||
                 s.renderType === segmentClassifier.RenderType.STATIC
        );

        if (animationSegments.length === 0) {
            console.log('No segments to animate');
            this.data.animationResults = [];
            return [];
        }

        const imageDir = path.join(this.projectDir, 'images');
        const videoDir = path.join(this.projectDir, 'videos');

        const results = await imageAnimator.animateImages(
            animationSegments,
            imageDir,
            videoDir,
            options,
            (progress) => {
                const overallProgress = 85 + (progress.percentage * 0.05);
                this.updateProgress(overallProgress, `图片动画化: ${progress.completed}/${progress.total}`);
            }
        );

        const successCount = results.filter(r => r.success).length;
        this.data.animationResults = results;

        console.log(`Animated ${successCount}/${results.length} images`);
        this.updateProgress(90, `图片动画化完成: ${successCount}/${results.length}`);

        this.saveProjectData();
        return results;
    }

    /**
     * 步骤 7: 合成最终 MV
     */
    async composeMV(audioPath, options = {}) {
        this.updateStatus(ProjectStatus.COMPOSING_MV, 90);
        console.log('Step 7: Composing final MV...');

        const videoDir = path.join(this.projectDir, 'videos');
        const outputPath = path.join(this.projectDir, 'output', 'mv_final.mp4');

        const result = await mvComposer.composeMV({
            segments: this.data.classifiedSegments,
            videoDir: videoDir,
            audioPath: audioPath,
            outputPath: outputPath,
            lyrics: this.data.lyrics,
            options: options
        });

        this.data.outputPath = result.path;
        this.data.outputDuration = result.duration;

        console.log(`MV composed: ${result.path}`);
        this.updateProgress(100, 'MV 合成完成');
        this.updateStatus(ProjectStatus.COMPLETED, 100);

        this.saveProjectData();
        return result;
    }

    /**
     * 继续执行（从图片确认后）
     * 强制使用全视频模式：所有分镜都使用 AI 视频生成
     */
    async continueAfterImageConfirmation(audioPath, options = {}) {
        if (!this.isAllImagesConfirmed()) {
            throw new Error('请先确认所有图片');
        }

        try {
            // 强制使用全视频模式
            const videoOptions = {
                ...(options.videoOptions || {}),
                allVideo: true  // 强制所有分镜使用 AI 视频
            };

            await this.generateVideos(videoOptions);
            // 不再调用 animateImages，完全使用 AI 视频
            // await this.animateImages(...);

            await this.composeMV(audioPath, options.composeOptions || {});

            return {
                success: true,
                projectId: this.projectId,
                outputPath: this.data.outputPath,
                duration: this.data.outputDuration
            };

        } catch (error) {
            console.error('继续生成失败:', error);
            this.reportError(error);

            return {
                success: false,
                projectId: this.projectId,
                error: error.message
            };
        }
    }

    /**
     * 执行到图片生成（等待用户确认）
     */
    async runUntilImageConfirmation(params) {
        const {
            lrcContent,
            audioPath,
            audioDuration,
            storyboardOptions = {},
            classifyOptions = {},
            imageOptions = {}
        } = params;

        try {
            console.log(`\n${'='.repeat(50)}`);
            console.log(`MV Pipeline started: ${this.projectId}`);
            console.log(`${'='.repeat(50)}\n`);

            this.initProjectDir();

            let duration = audioDuration;
            if (!duration && audioPath && fs.existsSync(audioPath)) {
                duration = mvComposer.getMediaDuration(audioPath);
            }

            // 复制音频到项目目录
            if (audioPath && fs.existsSync(audioPath)) {
                const projectAudioPath = path.join(this.projectDir, 'audio' + path.extname(audioPath));
                fs.copyFileSync(audioPath, projectAudioPath);
                this.data.audioPath = projectAudioPath;
            }

            await this.parseLyrics(lrcContent, duration);
            await this.generateStoryboard(storyboardOptions);
            this.classifySegments(classifyOptions);
            await this.generateImages(imageOptions);

            // 此时状态为 AWAITING_IMAGE_CONFIRM
            console.log(`\n${'='.repeat(50)}`);
            console.log(`图片生成完成，等待用户确认`);
            console.log(`${'='.repeat(50)}\n`);

            return {
                success: true,
                projectId: this.projectId,
                status: this.status,
                imagesForConfirmation: this.getImagesForConfirmation()
            };

        } catch (error) {
            console.error('Pipeline failed:', error);
            this.reportError(error);

            return {
                success: false,
                projectId: this.projectId,
                error: error.message
            };
        }
    }

    /**
     * 获取项目状态
     */
    getStatus() {
        return {
            projectId: this.projectId,
            status: this.status,
            progress: this.progress,
            error: this.error,
            data: {
                lyricsCount: this.data.lyrics?.length || 0,
                storyboardCount: this.data.storyboard?.length || 0,
                classificationStats: this.data.classificationStats,
                imageConfirmation: this.data.imageConfirmation,
                outputPath: this.data.outputPath
            }
        };
    }
}

module.exports = {
    MVPipeline,
    ProjectStatus
};
