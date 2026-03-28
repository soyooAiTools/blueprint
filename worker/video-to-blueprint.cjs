'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Get video metadata (duration, resolution) via ffprobe.
 * @param {string} videoPath
 * @returns {Promise<{duration: number, width: number, height: number}>}
 */
function getVideoInfo(videoPath) {
  return new Promise(function(resolve, reject) {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      videoPath
    ], function(err, stdout) {
      if (err) return reject(new Error('ffprobe failed: ' + err.message));
      try {
        var info = JSON.parse(stdout);
        var vs = (info.streams || []).find(function(s) { return s.codec_type === 'video'; });
        resolve({
          duration: parseFloat(info.format.duration) || 0,
          width: vs ? vs.width : 0,
          height: vs ? vs.height : 0,
        });
      } catch(e) { reject(new Error('ffprobe parse failed: ' + e.message)); }
    });
  });
}

/**
 * Preprocess video: truncate to maxDuration, convert to mp4.
 * @param {string} inputPath - Raw uploaded video
 * @param {string} outputPath - Processed mp4 path
 * @param {number} maxDuration - Max seconds (default 60)
 * @returns {Promise<string>} outputPath
 */
function preprocessVideo(inputPath, outputPath, maxDuration) {
  maxDuration = maxDuration || 60;
  return new Promise(function(resolve, reject) {
    var args = ['-y', '-i', inputPath, '-t', String(maxDuration), '-c:v', 'libx264', '-preset', 'fast', '-an', outputPath];
    execFile('ffmpeg', args, { timeout: 120000 }, function(err) {
      if (err) return reject(new Error('ffmpeg preprocess failed: ' + err.message));
      resolve(outputPath);
    });
  });
}

/**
 * Extract evenly-spaced keyframes from video.
 * @param {string} videoPath
 * @param {string} outDir - Directory to save frame_1.jpg ... frame_N.jpg
 * @param {number} count - Number of frames (default 8)
 * @param {number} duration - Video duration in seconds
 * @returns {Promise<string[]>} Array of frame filenames
 */
function extractFrames(videoPath, outDir, count, duration) {
  count = count || 8;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  var interval = duration / (count + 1);
  var promises = [];
  var filenames = [];

  for (var i = 1; i <= count; i++) {
    (function(idx) {
      var timestamp = (interval * idx).toFixed(2);
      var filename = 'frame_' + idx + '.jpg';
      var outPath = path.join(outDir, filename);
      filenames.push(filename);
      promises.push(new Promise(function(resolve, reject) {
        execFile('ffmpeg', [
          '-y', '-ss', timestamp, '-i', videoPath,
          '-frames:v', '1', '-q:v', '2', outPath
        ], { timeout: 30000 }, function(err) {
          if (err) return reject(new Error('Frame extract failed at ' + timestamp + 's: ' + err.message));
          resolve();
        });
      }));
    })(i);
  }

  return Promise.all(promises).then(function() { return filenames; });
}

/**
 * Extract a single thumbnail from the first second.
 * @param {string} videoPath
 * @param {string} outPath
 * @returns {Promise<void>}
 */
function extractThumbnail(videoPath, outPath) {
  return new Promise(function(resolve, reject) {
    execFile('ffmpeg', [
      '-y', '-ss', '1', '-i', videoPath,
      '-frames:v', '1', '-q:v', '2', outPath
    ], { timeout: 15000 }, function(err) {
      if (err) return reject(new Error('Thumbnail extract failed: ' + err.message));
      resolve();
    });
  });
}

module.exports = { getVideoInfo, preprocessVideo, extractFrames, extractThumbnail };
