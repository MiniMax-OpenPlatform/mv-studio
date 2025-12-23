/**
 * 音频格式转换模块
 * 使用 FFmpeg 转换音频为 ASR 所需格式
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * 检查 FFmpeg 是否可用
 */
function checkFFmpeg() {
    try {
        execSync('which ffmpeg', { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * 转换音频为 ASR 所需格式
 * - 16kHz 采样率
 * - 单声道
 * - 如果文件太大会压缩为 MP3
 *
 * @param {string} inputPath - 输入音频路径
 * @param {string} outputPath - 输出音频路径
 * @param {number} targetSizeMB - 目标文件大小（MB）
 * @returns {boolean} 是否成功转换
 */
function convertAudio(inputPath, outputPath, targetSizeMB = 5) {
    try {
        if (!checkFFmpeg()) {
            console.log('FFmpeg 未安装，直接使用原文件');
            fs.copyFileSync(inputPath, outputPath);
            return false;
        }

        // 第一步：转换为 16k 采样率，单声道，wav 格式
        execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -f wav "${outputPath}"`, { stdio: 'ignore' });

        // 检查文件大小
        const stats = fs.statSync(outputPath);
        const sizeMB = stats.size / (1024 * 1024);

        if (sizeMB > targetSizeMB) {
            console.log(`WAV 文件 ${sizeMB.toFixed(2)} MB 超过限制，转换为 MP3 压缩...`);
            const mp3Path = outputPath.replace('.wav', '.mp3');

            // 使用较低比特率的 MP3 来压缩
            execSync(`ffmpeg -y -i "${outputPath}" -ar 16000 -ac 1 -b:a 32k "${mp3Path}"`, { stdio: 'ignore' });

            // 检查 MP3 大小
            const mp3Stats = fs.statSync(mp3Path);
            const mp3SizeMB = mp3Stats.size / (1024 * 1024);
            console.log(`MP3 文件大小: ${mp3SizeMB.toFixed(2)} MB`);

            if (mp3SizeMB <= targetSizeMB) {
                fs.unlinkSync(outputPath);
                fs.renameSync(mp3Path, outputPath);
            } else {
                // 仍然太大，进一步降低比特率
                console.log('仍然太大，进一步压缩...');
                execSync(`ffmpeg -y -i "${mp3Path}" -ar 16000 -ac 1 -b:a 16k "${outputPath}"`, { stdio: 'ignore' });
                fs.unlinkSync(mp3Path);
            }
        }

        return true;
    } catch (e) {
        console.error('FFmpeg 转换失败:', e.message);
        fs.copyFileSync(inputPath, outputPath);
        return false;
    }
}

/**
 * 获取音频时长
 * @param {string} audioPath - 音频文件路径
 * @returns {number} 时长（秒）
 */
function getAudioDuration(audioPath) {
    try {
        const result = execSync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
            { encoding: 'utf-8' }
        );
        return parseFloat(result.trim()) || 0;
    } catch (e) {
        console.error('获取音频时长失败:', e.message);
        return 0;
    }
}

module.exports = {
    checkFFmpeg,
    convertAudio,
    getAudioDuration
};
