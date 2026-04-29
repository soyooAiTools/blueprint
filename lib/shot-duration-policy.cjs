'use strict';

var REVIEW_SHOT_MIN_SECONDS = 10;
var REVIEW_SHOT_MAX_SECONDS = 15;
var REVIEW_SHOT_TARGET_SECONDS = 12;

function _toFiniteNumber(value) {
  var num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function _formatNumber(value) {
  return Math.round(value * 1000) / 1000;
}

function normalizeReviewShotDuration(duration) {
  var fixes = [];
  var source = duration && typeof duration === 'object' ? duration : {};
  var min = _toFiniteNumber(source.min);
  var max = _toFiniteNumber(source.max);

  if (min == null) {
    min = REVIEW_SHOT_MIN_SECONDS;
    fixes.push('duration.min missing/invalid -> ' + REVIEW_SHOT_MIN_SECONDS);
  }
  if (max == null) {
    max = REVIEW_SHOT_MAX_SECONDS;
    fixes.push('duration.max missing/invalid -> ' + REVIEW_SHOT_MAX_SECONDS);
  }

  if (min > max) {
    var tmp = min;
    min = max;
    max = tmp;
    fixes.push('duration min/max swapped');
  }

  if (min < REVIEW_SHOT_MIN_SECONDS) {
    fixes.push('duration.min ' + _formatNumber(min) + ' -> ' + REVIEW_SHOT_MIN_SECONDS);
    min = REVIEW_SHOT_MIN_SECONDS;
  } else if (min > REVIEW_SHOT_MAX_SECONDS) {
    fixes.push('duration.min ' + _formatNumber(min) + ' -> ' + REVIEW_SHOT_MAX_SECONDS);
    min = REVIEW_SHOT_MAX_SECONDS;
  }

  if (max < REVIEW_SHOT_MIN_SECONDS) {
    fixes.push('duration.max ' + _formatNumber(max) + ' -> ' + REVIEW_SHOT_TARGET_SECONDS);
    max = REVIEW_SHOT_TARGET_SECONDS;
  } else if (max > REVIEW_SHOT_MAX_SECONDS) {
    fixes.push('duration.max ' + _formatNumber(max) + ' -> ' + REVIEW_SHOT_MAX_SECONDS);
    max = REVIEW_SHOT_MAX_SECONDS;
  }

  if (max < min) {
    fixes.push('duration.max ' + _formatNumber(max) + ' -> ' + _formatNumber(min) + ' to preserve min<=max');
    max = min;
  }

  return {
    duration: { min: _formatNumber(min), max: _formatNumber(max) },
    fixes: fixes,
    changed: fixes.length > 0,
  };
}

module.exports = {
  REVIEW_SHOT_MIN_SECONDS: REVIEW_SHOT_MIN_SECONDS,
  REVIEW_SHOT_MAX_SECONDS: REVIEW_SHOT_MAX_SECONDS,
  REVIEW_SHOT_TARGET_SECONDS: REVIEW_SHOT_TARGET_SECONDS,
  normalizeReviewShotDuration: normalizeReviewShotDuration,
};
