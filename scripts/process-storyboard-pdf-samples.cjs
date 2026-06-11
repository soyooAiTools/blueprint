#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var storyboardIr = require('../engine/storyboard-ir.cjs');
var storyboardSpecCompiler = require('../engine/storyboard-spec-compiler.cjs');
var storyboardSourceIrCompiler = require('../engine/storyboard-source-ir-compiler.cjs');
var sourceIrPreviewRenderer = require('../engine/source-ir-preview-renderer.cjs');

var RUNTIME_PHASE_MIN = 10;
var RUNTIME_PHASE_MAX = 13;
var PROFILE_RULES_PATH = path.join(__dirname, 'storyboard-pdf-profile-rules.json');
var DEFAULT_PROFILE_RULES = {
  schemaVersion: 'storyboard-pdf-action-rules.fallback.v1',
  actions: [
    { id: 'move', interaction: 'move_to:Target', patterns: ['移动|靠近|前往|走向|到达|控制|滑动|引导'] },
    { id: 'collect', interaction: 'collect:Item:1', patterns: ['收集|拾取|获取|获得|拿取|取走|吸入'] },
    { id: 'transfer', interaction: 'transfer:Item:Target:1', patterns: ['交付|提交|传递|投入|放入|填充|送入'] },
    { id: 'deliver', interaction: 'deliver:Item:Consumer:1', patterns: ['送达|送到|服务|售卖|收银|完成订单|提交订单'] },
    { id: 'select', interaction: 'select:Item', patterns: ['点击|点按|选择|点选|选中'] },
    { id: 'combine', interaction: 'combine:Item:UpgradePoint:1', patterns: ['合成|拖拽|拖动|碰撞|merge|Merge|→|->|达到\\s*Lv|升为'] },
    { id: 'show', interaction: 'show:Target', patterns: ['呈现|展示|显示|出现|高亮|发光|闪烁|摇摆|拉远|转场|播放'] },
    { id: 'produce', interaction: 'produce:Item:1', patterns: ['生产|产出|生成|刷新|自动|弹出'] },
    { id: 'upgrade', interaction: 'upgrade:UpgradePoint:2', patterns: ['升级|升阶|提升|进化|强化'] },
    { id: 'unlock', interaction: 'unlock:Target', patterns: ['解锁|扩建|开启|购买|修建|建造|搭建|打造|修复'] },
    { id: 'reward', interaction: 'reward:Reward:1', patterns: ['奖励|收益|得分|计数|结算'] },
    { id: 'attack', interaction: 'attack:Target', patterns: ['攻击|击杀|消灭|清场|防守|战斗'] },
    { id: 'wait', interaction: 'wait:1', patterns: ['等待|倒计时|计时|超时'] },
    { id: 'cta', interaction: 'click:CtaButton', patterns: ['下载|跳转|商店|CTA|Play Now|End Card|结束页面'] },
  ],
};

function usage() {
  console.error('Usage: node scripts/process-storyboard-pdf-samples.cjs <pdf-dir> <out-dir>');
  process.exit(2);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  var seen = {};
  var out = [];
  safeArray(values).forEach(function(value) {
    var text = String(value || '').trim();
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function execFile(command, args, options) {
  return childProcess.execFileSync(command, args, Object.assign({
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }, options || {}));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function loadProfileRules() {
  var rules = readJsonIfExists(PROFILE_RULES_PATH, DEFAULT_PROFILE_RULES);
  if (!rules || (!Array.isArray(rules.actions) && !Array.isArray(rules.profiles))) return DEFAULT_PROFILE_RULES;
  return rules;
}

function basenameNoExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function safeName(name) {
  return String(name || 'sample').replace(/[\\/:"*?<>|()\s]+/g, '_').replace(/^_+|_+$/g, '') || 'sample';
}

function stripText(text) {
  return String(text || '').replace(/\r/g, '').trim();
}

function compactText(text) {
  return String(text || '').replace(/\s+/g, '');
}

function stripInlineBoilerplate(line) {
  return String(line || '')
    .replace(/\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?\b/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b\d+\/\d+\b/g, ' ')
    .replace(/(?:^|\s)\/\d{1,2}\s+\d{1,2}:\d{2}(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBoilerplateLine(line) {
  var text = String(line || '').trim();
  var compact = compactText(text);
  if (!text || !compact) return true;
  if (/^https?:\/\//i.test(text)) return true;
  if (/^\d+\/\d+$/.test(text)) return true;
  if (/^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?$/.test(text)) return true;
  if (/^(PLAYABLE|MC|H5)$/i.test(text)) return true;
  if (/TAPD平台|外包-TAPD|素材H5-外包/.test(text)) return true;
  if (/^(基础信息|状态|规划中|父需求|Templated id|需求分类|优先级|处理人|制作开始时间|素材类型|标签缩写|创建人|创建时间|完成时间|详细描述|相关资源见附件|试玩提需模板|示例图片|示例链接)$/.test(text)) return true;
  if (/^(点位逻辑|Started|Failed|Retry|25%|50%|75%|Solved)\s*[：:]?$/.test(text)) return true;
  if (/^(区别描述|平面设计|视频设计|关键元素|元素|设计说明|大底图设定|跳转逻辑)$/.test(text)) return true;
  if (/^[-–—]+$/.test(text)) return true;
  return false;
}

function cleanedContentLines(text, options) {
  options = options || {};
  return stripText(text)
    .split(/\r?\n/)
    .map(function(line) { return stripInlineBoilerplate(line.trim()); })
    .filter(Boolean)
    .filter(function(line) { return options.keepNumbers || !/^\d+$/.test(line); })
    .filter(function(line) { return !isBoilerplateLine(line); })
    .filter(function(line) {
      if (options.keepTableHeader) return true;
      return !/^(序号|文字描述|画面|注释|需求描述)$/.test(line);
    })
    .filter(function(line) { return !/^序号\s+文字描述\s+画面$/.test(line); });
}

function parsePdfInfo(pdfPath) {
  var info = execFile('pdfinfo', [pdfPath]);
  var out = {};
  info.split(/\r?\n/).forEach(function(line) {
    var idx = line.indexOf(':');
    if (idx < 0) return;
    var key = line.slice(0, idx).trim();
    var value = line.slice(idx + 1).trim();
    out[key] = value;
  });
  return out;
}

function firstExistingCommand(commands) {
  for (var i = 0; i < commands.length; i += 1) {
    try {
      var found = execFile('which', [commands[i]]).trim();
      if (found) return found;
    } catch (e) {}
  }
  return '';
}

function textOfPdf(pdfPath, layout) {
  try {
    return execFile('pdftotext', layout ? ['-layout', pdfPath, '-'] : [pdfPath, '-']);
  } catch (e) {
    return '';
  }
}

function paragraphLines(text) {
  return cleanedContentLines(text);
}

function collapseLines(lines) {
  return safeArray(lines).join('').replace(/\s+/g, ' ').trim();
}

function normalizePdfText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/Phas\s*\n\s*e\s*:?\s*(\d+)\s*:?\s*/gi, 'Phase$1:\n')
    .replace(/Phas\s*\n\s*e\s*:?\s*\n\s*(\d+)/gi, 'Phase$1:')
    .replace(/Phas\s*\n\s*e\s*(\d+)\s*:/gi, 'Phase$1:')
    .replace(/Phas\s*e\s*:?\s*(\d+)\s*:/gi, 'Phase$1:')
    .replace(/Phase\s*:?\s*(\d+)\s*:/gi, 'Phase$1:')
    .replace(/Phase\s*:?\s*(\d+)(?=\s|$)/gi, 'Phase$1:')
    .replace(/Phase\s*(\d+)\s*:/gi, 'Phase$1:');
}

function phaseBodyLines(text) {
  return cleanedContentLines(text);
}

function contentLinesWithNumbers(text) {
  return cleanedContentLines(text, { keepNumbers: true });
}

function splitTitleAndDescription(lines, fallbackTitle) {
  lines = safeArray(lines);
  var titleParts = [];
  var descriptionStart = 0;
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i];
    if (/^(玩家看到什么|玩家做什么|镜头|感觉|大约耗时|耗时|注释)[:：]/.test(line)) {
      descriptionStart = i;
      break;
    }
    if (titleParts.length < 3 && line.length <= 28) {
      titleParts.push(line);
      descriptionStart = i + 1;
      continue;
    }
    descriptionStart = i;
    break;
  }
  var title = collapseLines(titleParts) || fallbackTitle || '';
  var description = collapseLines(lines.slice(descriptionStart)) || collapseLines(lines) || title;
  return { title: title, description: description };
}

function inferInteraction(text, fallbackTitle) {
  var hay = String(text || '') + ' ' + String(fallbackTitle || '');
  return inferGenericActionInteraction(hay);
}

function firstCandidate(text, candidates, fallback) {
  var hay = String(text || '');
  for (var i = 0; i < candidates.length; i += 1) {
    var item = candidates[i];
    var label = Array.isArray(item) ? item[0] : item;
    var pattern = Array.isArray(item) ? item[1] : item;
    var re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));
    if (re.test(hay)) return label;
  }
  return fallback;
}

function inferRoleLabels(text) {
  var hay = String(text || '');
  return {
    Player: firstCandidate(hay, [
      ['玩家', /玩家/],
      ['主角', /主角/],
      ['角色', /角色|小人|主厨|店员/],
    ], '玩家'),
    Source: firstCandidate(hay, [
      ['流水线', /流水线/],
      ['传送带', /传送带/],
      ['生产点', /生产|产出|生成/],
      ['起点', /来源|起点|入口/],
    ], '来源'),
    Item: firstCandidate(hay, [
      ['配菜', /配菜/],
      ['面条', /面条|拉面/],
      ['汉堡', /汉堡/],
      ['甜品', /甜品|蛋糕|可颂|舒芙蕾|饮品/],
      ['面团', /面团/],
      ['金币', /金币|金钱|钱币/],
      ['木头', /木头|木材/],
      ['氧气', /氧气/],
      ['子弹', /子弹/],
      ['水', /水\b|卖水/],
      ['钥匙', /钥匙/],
      ['食物', /食物/],
    ], '物品'),
    Target: firstCandidate(hay, [
      ['订单小票', /订单小票/],
      ['订单', /订单/],
      ['面碗', /面碗|碗/],
      ['煮锅', /煮锅|锅/],
      ['收银台', /收银台/],
      ['制作台', /制作台/],
      ['餐厅', /餐厅|店铺|店面/],
      ['桌面物件', /桌面物件|物件/],
      ['顾客', /顾客|客人/],
      ['敌人', /敌人|怪物|士兵/],
      ['基地', /基地/],
      ['休眠舱', /休眠舱/],
      ['目标', /目标/],
    ], '目标'),
    Container: firstCandidate(hay, [
      ['面碗', /面碗|碗/],
      ['煮锅', /煮锅|锅/],
      ['容器', /容器/],
    ], '容器'),
    Consumer: firstCandidate(hay, [
      ['顾客', /顾客|客人/],
      ['收银台', /收银台/],
      ['订单', /订单/],
    ], '顾客'),
    Producer: firstCandidate(hay, [
      ['传送带', /传送带/],
      ['抻面小人', /抻面小人/],
      ['制作台', /制作台/],
      ['煮锅', /煮锅|锅/],
      ['生产点', /生产|产出|生成/],
    ], '生产点'),
    UpgradePoint: firstCandidate(hay, [
      ['制作台', /制作台/],
      ['收银台', /收银台/],
      ['合成链', /合成链|升级链/],
      ['升级点', /升级|升阶|提升/],
      ['空位', /空位/],
      ['解锁点', /解锁|购买|扩建|开启/],
    ], '升级点'),
    Reward: firstCandidate(hay, [
      ['金币', /金币|金钱|钱币/],
      ['订单计数', /订单计数|计数/],
      ['奖励', /奖励|收益|得分|结算/],
    ], '奖励'),
    CtaButton: firstCandidate(hay, [
      ['下载按钮', /下载|商店|Play\s*Now|CTA/i],
    ], '下载按钮'),
  };
}

function inferGenericActionInteraction(text) {
  var hay = String(text || '');
  if (/下载|跳转|商店|CTA|Play\s*Now|End\s*Card|结束页面/i.test(hay)) return 'click:CtaButton';
  if (/合成|拖拽|拖动|碰撞|merge|→|->|达到\s*Lv|升为/i.test(hay)) return 'combine:Item:UpgradePoint:1';
  if (/送达|送到|服务|售卖|收银|完成订单|提交订单/.test(hay)) return 'deliver:Item:Consumer:1';
  if (/交付|提交|传递|投入|放入|填充|送入/.test(hay)) return 'transfer:Item:Target:1';
  if (/解锁|扩建|开启|购买|修建|建造|搭建|打造|修复/.test(hay)) return 'unlock:Target';
  if (/升级|升阶|提升|进化|强化/.test(hay)) return 'upgrade:UpgradePoint:2';
  if (/点击|点按|选择|点选|选中/.test(hay)) return 'select:Item';
  if (/收集|拾取|获取|获得|拿取|取走|吸入/.test(hay)) return 'collect:Item:1';
  if (/生产|产出|生成|刷新|自动|弹出/.test(hay)) return 'produce:Item:1';
  if (/奖励|收益|得分|计数|结算/.test(hay)) return 'reward:Reward:1';
  if (/等待|倒计时|计时|超时/.test(hay) && /UI|界面|小票|提示|圆环|进度条|计数|图标|按钮|文字|显示|闪烁|飘出/.test(hay)) return 'show:Target';
  if (/等待|倒计时|计时|超时/.test(hay)) return 'wait:1';
  if (/呈现|展示|显示|出现|高亮|发光|闪烁|摇摆|拉远|转场|播放/.test(hay)) return 'show:Target';
  if (/攻击|击杀|消灭|清场|防守|战斗/.test(hay)) return 'attack:Target';
  if (/移动|靠近|前往|走向|到达|控制|滑动|引导/.test(hay)) return 'move_to:Target';
  return 'wait:1';
}

function entitiesForKind(kind, text) {
  var labels = inferRoleLabels(text || '');
  return [
    { name: 'Player', label: labels.Player, template: 'PlayerController' },
    { name: 'Source', label: labels.Source, template: 'Static' },
    { name: 'Item', label: labels.Item, template: 'Collectible' },
    { name: 'Target', label: labels.Target, template: 'Buildable' },
    { name: 'Container', label: labels.Container, template: 'Buildable' },
    { name: 'Consumer', label: labels.Consumer, template: 'NPC' },
    { name: 'Producer', label: labels.Producer, template: 'Upgradeable' },
    { name: 'UpgradePoint', label: labels.UpgradePoint, template: 'Upgradeable' },
    { name: 'Reward', label: labels.Reward, template: 'Collectible' },
    { name: 'CtaButton', label: labels.CtaButton, template: 'UI' },
  ];
}

function themeForKind(kind) {
  return 'default';
}

function resourcesForKind(kind, text) {
  var labels = inferRoleLabels(text || '');
  return [
    { id: 'Item', label: labels.Item, carrierEntity: 'Item', kind: 'resource', initial: 0 },
    { id: 'Reward', label: labels.Reward, carrierEntity: 'Reward', kind: 'resource', initial: 0 },
  ];
}

function entityNamesForKind(kind) {
  return entitiesForKind(kind).map(function(entity) { return entity.name || entity.id; }).filter(Boolean);
}

function addVisibleEntity(out, entitySet, name) {
  if (!name || !entitySet[name]) return;
  out.push(name);
}

function addInteractionVisibleEntity(out, entitySet, interaction, kind) {
  var parts = interactionParts(interaction);
  var verb = parts.verb || '';
  var target = parts.target || '';
  var resource = parts.resource || '';
  if (verb === 'collect') {
    addVisibleEntity(out, entitySet, 'Source');
    addVisibleEntity(out, entitySet, resource || 'Item');
    return;
  }
  if (verb === 'produce') {
    addVisibleEntity(out, entitySet, 'Producer');
    addVisibleEntity(out, entitySet, resource || 'Item');
    return;
  }
  if (verb === 'reward') {
    addVisibleEntity(out, entitySet, resource || 'Reward');
    return;
  }
  if (verb === 'transfer') {
    addVisibleEntity(out, entitySet, resource || 'Item');
    addVisibleEntity(out, entitySet, target || 'Target');
    return;
  }
  if (verb === 'deliver') {
    addVisibleEntity(out, entitySet, resource || 'Item');
    addVisibleEntity(out, entitySet, target || 'Consumer');
    return;
  }
  if (verb === 'combine') {
    addVisibleEntity(out, entitySet, resource || 'Item');
    addVisibleEntity(out, entitySet, target || 'UpgradePoint');
    return;
  }
  if (verb === 'select') {
    addVisibleEntity(out, entitySet, target || resource || 'Item');
    return;
  }
  if (verb === 'unlock') {
    addVisibleEntity(out, entitySet, target || 'Target');
    return;
  }
  if (verb === 'upgrade') {
    addVisibleEntity(out, entitySet, target || 'UpgradePoint');
    return;
  }
  if (verb === 'click' && /^CtaButton$/i.test(target)) {
    addVisibleEntity(out, entitySet, 'CtaButton');
    return;
  }
  addVisibleEntity(out, entitySet, target);
}

function visibleEntityKeywordRules(kind) {
  return [
    ['CtaButton', /下载|跳转|商店|CTA|Play\s*Now|End\s*Card|结束页面/i],
    ['Source', /收集|拾取|获取|获得|拿取|取走|吸入/],
    ['Item', /收集|拾取|获取|获得|拿取|取走|合成|拖拽|拖动|选择|点击|生产|产出|生成|刷新|自动|弹出/],
    ['Target', /移动|靠近|前往|走向|到达|交付|提交|传递|投入|放入|填充|送入|解锁|扩建|开启|购买/],
    ['Consumer', /送达|送到|服务|售卖|收银|完成订单|提交订单/],
    ['Producer', /生产|产出|生成|刷新|自动|弹出/],
    ['UpgradePoint', /合成|拖拽|拖动|碰撞|merge|升级|升阶|提升|进化|强化/i],
    ['Reward', /奖励|收益|得分|计数|结算/],
    ['Target', /呈现|展示|显示|出现|高亮|发光|闪烁|摇摆|拉远|转场|播放/],
  ];
}

function interactionParts(value) {
  if (value && typeof value === 'object') {
    return {
      object: value,
      verb: String(value.verb || '').trim(),
      target: String(value.target || value.entity || value.resource || '').trim(),
      resource: String(value.resource || '').trim(),
      amount: value.amount == null ? '' : String(value.amount),
    };
  }
  var parts = String(value || '').split(':').map(function(part) { return part.trim(); });
  var verb = parts[0] || '';
  if (verb === 'deliver' || verb === 'transfer' || verb === 'combine') {
    return {
      object: null,
      verb: verb,
      resource: parts[1] || '',
      target: parts[2] || '',
      amount: parts[3] || '',
      rest: parts.slice(3),
    };
  }
  if (verb === 'produce' || verb === 'reward' || verb === 'collect') {
    return {
      object: null,
      verb: verb,
      resource: parts[1] || '',
      target: parts[1] || '',
      amount: parts[2] || '',
      rest: parts.slice(2),
    };
  }
  return { object: null, verb: verb, target: parts[1] || '', resource: '', amount: parts[2] || '', rest: parts.slice(2) };
}

function disambiguateFrameInteraction(frame, kind) {
  return Object.assign({}, frame || {});
}

function inferVisibleEntitiesForFrame(frame, kind) {
  var entitySet = {};
  entityNamesForKind(kind).forEach(function(name) { entitySet[name] = true; });
  var out = [];
  addVisibleEntity(out, entitySet, 'Player');
  var text = [
    frame && frame.title,
    frame && frame.scene,
    frame && frame.ui,
    frame && frame.interaction,
  ].map(function(value) { return String(value || ''); }).join(' ');
  addInteractionVisibleEntity(out, entitySet, frame && frame.interaction, kind);
  visibleEntityKeywordRules(kind).forEach(function(rule) {
    if (rule[1].test(text)) addVisibleEntity(out, entitySet, rule[0]);
  });
  if (/下载|跳转|结束页面|CTA|PlayNow/i.test(text)) addVisibleEntity(out, entitySet, 'CtaButton');
  return uniqueStrings(out);
}

function enrichFramesWithVisibleEntities(frames, kind) {
  return safeArray(frames).map(function(frame) {
    var copy = disambiguateFrameInteraction(frame, kind);
    var visible = safeArray(copy.visibleEntities).concat(safeArray(copy.entities));
    visible = visible.concat(inferVisibleEntitiesForFrame(copy, kind));
    copy.visibleEntities = uniqueStrings(visible);
    copy.entities = copy.visibleEntities;
    return copy;
  });
}

function parseParagraphFrames(text) {
  var lines = paragraphLines(text)
    .filter(function(line) { return line !== '\f'; })
    .filter(function(line) { return !/^?$/.test(line); });
  var paragraphs = [];
  var current = [];
  lines.forEach(function(line) {
    if (/^(成功跳转|失败跳转|防呆跳转|CTA弹窗|按钮[:：]?|结束页面[:：]?)/.test(line) && current.length > 0) {
      paragraphs.push(collapseLines(current));
      current = [line.replace(/^[•￮]\s*/, '')];
      return;
    }
    if (/^[•￮]/.test(line) && current.length > 0) {
      paragraphs.push(collapseLines(current));
      current = [line.replace(/^[•￮]\s*/, '')];
      return;
    }
    if (current.length > 0 && current.join('').length > 34 && !/[，。；、]$/.test(current[current.length - 1])) {
      paragraphs.push(collapseLines(current));
      current = [line.replace(/^[•￮]\s*/, '')];
      return;
    }
    current.push(line.replace(/^[•￮]\s*/, ''));
  });
  if (current.length > 0) paragraphs.push(collapseLines(current));
  paragraphs = paragraphs.filter(function(item) {
    return item.length >= 6 && !/^\d+$/.test(item);
  });
  var frames = paragraphs.map(function(textBlock, index) {
    var title = textBlock.slice(0, Math.min(18, textBlock.length));
    return {
      id: 'paragraph-step-' + (index + 1),
      chapter: index + 1,
      chapterTitle: title,
      step: 1,
      title: title,
      scene: textBlock,
      interaction: inferInteraction(textBlock, title),
      ui: title,
      timing: '玩家操作，预计 3-5s',
    };
  });
  return frames;
}

function parseWaterFrames(text) {
  return parseParagraphFrames(text);
}

function parseNumberedTableFrames(text, fallbackName) {
  var lines = contentLinesWithNumbers(text)
    .filter(function(line) { return line !== fallbackName; });
  var frames = [];
  var prelude = [];
  var current = null;

  function finishCurrent() {
    if (!current) return;
    var textBlock = collapseLines(current.lines);
    if (textBlock.length >= 3) {
      var fallbackTitle = (fallbackName || 'Phase') + ' ' + current.chapter;
      var parts = splitTitleAndDescription(current.lines, fallbackTitle);
      var title = collapseLines(current.lines).slice(0, 24) || parts.title || fallbackTitle;
      var description = parts.description || textBlock || title;
      frames.push({
        id: 'numbered-row-' + current.chapter,
        chapter: current.chapter,
        chapterTitle: title,
        step: 1,
        title: title,
        scene: description,
        interaction: inferInteraction(title + ' ' + description, title),
        ui: title,
        timing: '玩家操作，预计 3-5s',
        parser: 'numbered-table',
      });
    }
    current = null;
  }

  function startCurrent(chapter, firstLine) {
    finishCurrent();
    current = { chapter: chapter, lines: prelude.splice(0) };
    if (firstLine) current.lines.push(firstLine);
  }

  lines.forEach(function(line) {
    var markerWithText = line.match(/^(\d{1,2})\s+(.+)$/);
    if (markerWithText) {
      startCurrent(Number(markerWithText[1]), markerWithText[2]);
      return;
    }
    var markerOnly = line.match(/^(\d{1,2})$/);
    if (markerOnly) {
      startCurrent(Number(markerOnly[1]), '');
      return;
    }
    if (current) current.lines.push(line);
    else prelude.push(line);
  });
  finishCurrent();
  return frames.length >= 3 ? frames : [];
}

function parsePhaseMarkedFrames(text, fallbackName) {
  var normalized = normalizePdfText(text);
  var re = /(?:^|\n)\s*Phase\s*(\d+)\s*:\s*/gi;
  var matches = [];
  var match;
  while ((match = re.exec(normalized))) {
    matches.push({
      raw: Number(match[1]),
      index: match.index,
      bodyStart: re.lastIndex,
    });
  }
  if (matches.length < 2) return [];
  var frames = [];
  var lastChapter = 0;
  for (var i = 0; i < matches.length; i += 1) {
    var rawChapter = matches[i].raw || i + 1;
    var chapter = rawChapter <= lastChapter ? lastChapter + 1 : rawChapter;
    lastChapter = chapter;
    var body = normalized.slice(matches[i].bodyStart, i + 1 < matches.length ? matches[i + 1].index : normalized.length);
    var lines = phaseBodyLines(body);
    var parts = splitTitleAndDescription(lines, (fallbackName || 'Phase') + ' ' + chapter);
    var title = parts.title || ((fallbackName || 'Phase') + ' ' + chapter);
    var description = parts.description || title;
    frames.push({
      id: 'phase-marked-' + chapter,
      chapter: chapter,
      chapterTitle: title,
      step: 1,
      title: title,
      scene: description,
      interaction: inferInteraction(title + ' ' + description, title),
      ui: title,
      timing: '玩家操作，预计 3-5s',
      parser: 'phase-marker',
    });
  }
  return frames;
}

function findCueIndex(text, cue, startAt) {
  startAt = Math.max(0, Number(startAt) || 0);
  var match = String(text || '').slice(startAt).match(cue);
  return match ? startAt + match.index : -1;
}

function firstCueIndexAfter(text, cues, startAt) {
  var best = -1;
  safeArray(cues).forEach(function(cue) {
    var idx = findCueIndex(text, cue, startAt);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  });
  return best;
}

function storyboardPlayableContentText(text) {
  var source = normalizePdfText(text);
  var start = firstCueIndexAfter(source, [
    /玩法逻辑/,
    /游戏整体玩法/,
    /核心玩法/,
    /核心流程/,
  ], 0);
  if (start < 0) return source;
  var end = firstCueIndexAfter(source, [
    /除通用打点外/,
    /点位逻辑/,
    /区别描述/,
    /平面设计/,
    /视频设计/,
    /3D设计/,
  ], start + 1);
  return source.slice(start, end >= 0 ? end : source.length).trim();
}

function parseGenericFrames(text, fallbackName) {
  var playableText = storyboardPlayableContentText(text);
  var phaseFrames = parsePhaseMarkedFrames(playableText, fallbackName);
  if (phaseFrames.length >= 2) return phaseFrames;
  var numberedFrames = parseNumberedTableFrames(playableText, fallbackName);
  if (numberedFrames.length >= 3) return numberedFrames;
  return parseParagraphFrames(playableText);
}

function runtimePhaseCount(frames) {
  var seen = {};
  safeArray(frames).forEach(function(frame, index) {
    var chapter = Number(frame && frame.chapter || index + 1);
    if (!Number.isFinite(chapter) || chapter <= 0) chapter = index + 1;
    seen[String(chapter)] = true;
  });
  return Object.keys(seen).length;
}

function interactionVerb(value) {
  var text = String(value || '').trim();
  var match = text.match(/^([A-Za-z_]+)(?::|\b)/);
  return match ? match[1].toLowerCase() : '';
}

function frameActionScore(frame) {
  var verb = interactionVerb(frame && frame.interaction);
  if (verb === 'click') return 90;
  if ([
    'attack', 'build', 'upgrade', 'collect', 'deliver', 'transfer',
    'select', 'combine', 'produce', 'reward', 'unlock', 'show',
  ].indexOf(verb) >= 0) return 70;
  if (verb === 'move_to' || verb === 'move') return 50;
  if (verb === 'wait' || verb === 'timer') return 0;
  return 0;
}

function groupActionScore(group) {
  return safeArray(group && group.frames).reduce(function(best, frame) {
    return Math.max(best, frameActionScore(frame));
  }, 0);
}

function groupHasFinalCta(group) {
  return safeArray(group && group.frames).some(function(frame) {
    return /^click:CtaButton$/i.test(String(frame && frame.interaction || ''));
  });
}

function groupIsOnlyFinalCta(group) {
  var frames = safeArray(group && group.frames);
  return frames.length > 0 && frames.every(function(frame) {
    return /^click:CtaButton$/i.test(String(frame && frame.interaction || ''));
  });
}

function groupTerminalText(group) {
  return safeArray(group && group.frames).map(frameSplitSourceText).join(' ');
}

function groupHasTerminalTailCue(group) {
  var text = groupTerminalText(group);
  return /跳转|商店|Play\s*(?:\/\s*)?(?:App\s*)?Store|App\s*Store|End\s*Card|CTA|下载|结束页面|拉起应用商店|成功跳转|失败跳转|防呆跳转|结束跳转|超时|提示|引导|路径|路线|虚线|目标|手势|停下|最终/i.test(text);
}

function groupIsTerminalCtaOrTail(group) {
  var frames = safeArray(group && group.frames);
  if (!frames.length) return false;
  var allowed = frames.every(function(frame) {
    var interaction = String(frame && frame.interaction || '').trim();
    var verb = interactionVerb(interaction);
    if (/^click:CtaButton$/i.test(interaction)) return true;
    return verb === 'show' || verb === 'wait' || verb === 'timer';
  });
  if (!allowed) return false;
  if (groupIsOnlyFinalCta(group)) return true;
  if (groupHasFinalCta(group) && groupHasTerminalTailCue(group)) return true;
  return !groupHasFinalCta(group) && groupHasTerminalTailCue(group);
}

function collapseTerminalCtaGroups(groups) {
  groups = safeArray(groups).map(function(group) {
    return {
      chapter: group.chapter,
      frames: safeArray(group.frames).map(function(frame) { return Object.assign({}, frame); }),
      firstIndex: group.firstIndex,
    };
  });
  if (groups.length < 2) return { groups: groups, diagnostics: [] };
  var suffixStart = groups.length;
  for (var i = groups.length - 1; i >= 0; i -= 1) {
    if (!groupIsTerminalCtaOrTail(groups[i])) break;
    suffixStart = i;
  }
  if (suffixStart >= groups.length) return { groups: groups, diagnostics: [] };
  var start = -1;
  for (var j = suffixStart; j < groups.length; j += 1) {
    if (groupHasFinalCta(groups[j])) {
      start = j;
      break;
    }
  }
  if (start < 0 || start >= groups.length - 1) return { groups: groups, diagnostics: [] };
  var merged = groups.slice(0, start);
  var ctaFrames = [];
  groups.slice(start).forEach(function(group) {
    ctaFrames = ctaFrames.concat(group.frames);
  });
  merged.push({
    chapter: groups[start].chapter,
    frames: ctaFrames,
    firstIndex: groups[start].firstIndex,
  });
  return {
    groups: merged,
    diagnostics: [{
      code: 'storyboard_pdf_terminal_cta_merge',
      severity: 'info',
      fromPhaseCount: groups.length,
      toPhaseCount: merged.length,
      mergedTerminalCtaCount: groups.length - start,
      message: 'Merged adjacent terminal CTA storyboard rows into one final runtime phase.',
    }],
  };
}

function groupFramesByRuntimeChapter(frames) {
  var groups = [];
  var byChapter = {};
  safeArray(frames).forEach(function(frame, index) {
    var chapter = Number(frame && frame.chapter || index + 1);
    if (!Number.isFinite(chapter) || chapter <= 0) chapter = index + 1;
    var key = String(chapter);
    if (!byChapter[key]) {
      byChapter[key] = { chapter: chapter, frames: [], firstIndex: index };
      groups.push(byChapter[key]);
    }
    byChapter[key].frames.push(Object.assign({}, frame));
  });
  return groups.sort(function(a, b) { return a.firstIndex - b.firstIndex; });
}

function frameSplitSourceText(frame) {
  return [
    frame && frame.title,
    frame && frame.scene,
  ].map(function(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }).filter(Boolean).join(' ');
}

function titleFromChunk(chunk, fallbackTitle) {
  var text = String(chunk || '').replace(/^(玩家看到什么|玩家做什么|镜头|感觉|大约耗时)[:：]\s*/g, '').trim();
  text = text.replace(/\s+/g, ' ');
  if (!text) return fallbackTitle || 'Phase';
  return text.slice(0, Math.min(24, text.length));
}

function splitTextByRuntimeCues(text) {
  var source = String(text || '').replace(/\s+/g, ' ').trim();
  if (source.length < 48) return [];
  var cueRe = /(玩家看到什么[:：]|玩家做什么[:：]|STEP\s*\d+|步骤\s*\d+|触发条件[:：]?|结束表现[:：]?|镜头表现[:：]?|CTA弹窗[:：]?|引导|合成|拖拽|拖动|点击|选择|收集|获取|生产|产出|交付|送达|服务|售卖|解锁|扩建|升级|高亮|发光|展示|显示|出现|拉远|转场|结束页面[:：]?|在第[一二三四五六七八九十]+个房间|在第二个房间|右下角房间|右下房间|右侧中间房间|左下房间获取钥匙|左上右上房间获取电池|升级电塔|获取胜利)/g;
  var matches = [];
  var match;
  while ((match = cueRe.exec(source))) {
    if (match.index > 0) matches.push(match.index);
  }
  if (!matches.length) return [];
  var cuts = [0].concat(matches).filter(function(value, index, arr) {
    return index === 0 || value - arr[index - 1] >= 32;
  });
  var chunks = [];
  for (var i = 0; i < cuts.length; i += 1) {
    var start = cuts[i];
    var end = i + 1 < cuts.length ? cuts[i + 1] : source.length;
    var chunk = source.slice(start, end).trim();
    if (chunk.length >= 24) chunks.push(chunk);
  }
  if (chunks.length >= 2) return chunks;
  var sentences = source
    .replace(/([。；;.!?？])/g, '$1\n')
    .split(/\n+/)
    .map(function(item) { return item.trim(); })
    .filter(function(item) { return item.length >= 10; });
  if (sentences.length < 2) return [];
  var sentenceChunks = [];
  var current = '';
  sentences.forEach(function(sentence) {
    if (current && (current.length + sentence.length > 54)) {
      sentenceChunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? current + sentence : sentence;
    }
  });
  if (current) sentenceChunks.push(current.trim());
  return sentenceChunks.length >= 2 ? sentenceChunks : [];
}

function splitFrameForRuntimeExpansion(frame, maxParts) {
  maxParts = Math.max(1, Number(maxParts) || 1);
  var chunks = splitTextByRuntimeCues(frameSplitSourceText(frame));
  if (chunks.length < 2) return [];
  if (chunks.length > maxParts) {
    chunks = chunks.slice(0, maxParts - 1).concat([chunks.slice(maxParts - 1).join(' ')]);
  }
  return chunks.map(function(chunk, index) {
    var title = titleFromChunk(chunk, frame && frame.title || ('Phase ' + (index + 1)));
    return Object.assign({}, frame, {
      id: String(frame && frame.id || 'frame') + '-part-' + (index + 1),
      chapterTitle: title,
      title: title,
      scene: chunk,
      interaction: inferInteraction(title + ' ' + chunk, title),
      ui: title,
      runtimeExpansion: 'storyboard-pdf-min-phase',
      expandedFromFrameId: frame && frame.id || null,
      expandedPartIndex: index + 1,
      expandedPartCount: chunks.length,
    });
  });
}

function splitGroupForRuntimeExpansion(group, maxParts) {
  maxParts = Math.max(1, Number(maxParts) || 1);
  if (!group || maxParts < 2) return [];
  if (safeArray(group.frames).length > 1) {
    return group.frames.slice(0, maxParts).map(function(frame) {
      return { chapter: group.chapter, frames: [Object.assign({}, frame)], firstIndex: group.firstIndex };
    });
  }
  var parts = splitFrameForRuntimeExpansion(group.frames[0], maxParts);
  return parts.map(function(frame) {
    return { chapter: group.chapter, frames: [frame], firstIndex: group.firstIndex };
  });
}

function groupTextLength(group) {
  return safeArray(group && group.frames).reduce(function(total, frame) {
    return total + frameSplitSourceText(frame).length;
  }, 0);
}

function expandRuntimePhases(groups, options) {
  var min = Number(options && options.min) || RUNTIME_PHASE_MIN;
  var max = Number(options && options.max) || RUNTIME_PHASE_MAX;
  groups = safeArray(groups).map(function(group) {
    return {
      chapter: group.chapter,
      frames: safeArray(group.frames).map(function(frame) { return Object.assign({}, frame); }),
      firstIndex: group.firstIndex,
    };
  });
  var originalCount = groups.length;
  while (groups.length < min && groups.length < max) {
    var room = max - groups.length + 1;
    var best = null;
    for (var i = 0; i < groups.length; i += 1) {
      var maxParts = Math.min(room, min - groups.length + 1, 5);
      var parts = splitGroupForRuntimeExpansion(groups[i], maxParts);
      if (parts.length < 2) continue;
      var score = groupTextLength(groups[i]) + (parts.length * 250);
      if (groupHasFinalCta(groups[i])) score -= 500;
      if (!best || score > best.score) best = { index: i, parts: parts, score: score };
    }
    if (!best) break;
    groups.splice.apply(groups, [best.index, 1].concat(best.parts));
  }
  if (groups.length === originalCount) return { groups: groups, diagnostics: [] };
  return {
    groups: groups,
    diagnostics: [{
      code: 'storyboard_pdf_runtime_phase_expand',
      severity: 'info',
      fromPhaseCount: originalCount,
      toPhaseCount: groups.length,
      minPhaseCount: min,
      maxPhaseCount: max,
      message: 'Split long storyboard phases into runtime phases before SourceIR build.',
    }],
  };
}

function mergedRuntimePhaseTarget(groups, options) {
  var max = Number(options && options.max) || RUNTIME_PHASE_MAX;
  var min = Number(options && options.min) || RUNTIME_PHASE_MIN;
  var actionGroups = safeArray(groups).filter(function(group) { return groupActionScore(group) > 0; }).length;
  var noActionGroups = Math.max(0, groups.length - actionGroups);
  return Math.min(max, Math.max(Math.min(min, groups.length), actionGroups + Math.ceil(noActionGroups / 3)));
}

function chooseRuntimeMergePair(groups) {
  for (var i = 0; i < groups.length; i += 1) {
    if (groupActionScore(groups[i]) > 0 || groupHasFinalCta(groups[i])) continue;
    if (i > 0) return i - 1;
    return 0;
  }
  var best = { index: 0, penalty: Infinity };
  for (var j = 0; j < groups.length - 1; j += 1) {
    var penalty = groupActionScore(groups[j]) + groupActionScore(groups[j + 1]);
    if (groupHasFinalCta(groups[j + 1])) penalty += 400;
    if (interactionVerb(groups[j].frames[0] && groups[j].frames[0].interaction) === interactionVerb(groups[j + 1].frames[0] && groups[j + 1].frames[0].interaction)) {
      penalty -= 20;
    }
    if (penalty < best.penalty) best = { index: j, penalty: penalty };
  }
  return best.index;
}

function capRuntimePhases(frames, options) {
  options = options || {};
  var max = Number(options.max) || RUNTIME_PHASE_MAX;
  var groups = groupFramesByRuntimeChapter(frames);
  var collapsed = collapseTerminalCtaGroups(groups);
  groups = collapsed.groups;
  var diagnostics = [].concat(collapsed.diagnostics);
  if (groups.length < (Number(options.min) || RUNTIME_PHASE_MIN)) {
    var minPhases = Number(options.min) || RUNTIME_PHASE_MIN;
    var expanded = expandRuntimePhases(groups, options);
    groups = expanded.groups;
    diagnostics = diagnostics.concat(expanded.diagnostics);
    if (groups.length < minPhases) {
      diagnostics.push({
        code: 'storyboard_pdf_runtime_phase_below_min',
        severity: 'error',
        phaseCount: groups.length,
        minPhaseCount: minPhases,
        message: 'Storyboard runtime phase count is below the required minimum after generic action expansion.',
      });
    }
  }
  if (groups.length <= max) {
    var normalizedFrames = [];
    groups.forEach(function(group, groupIndex) {
      var phaseIndex = groupIndex + 1;
      var phaseTitle = group.frames[0] && (group.frames[0].chapterTitle || group.frames[0].title) || ('Phase ' + phaseIndex);
      group.frames.forEach(function(frame, frameIndex) {
        var copy = Object.assign({}, frame);
        copy.chapter = phaseIndex;
        copy.chapterTitle = phaseTitle;
        copy.runtimePhaseIndex = phaseIndex;
        copy.runtimePhaseFrameIndex = frameIndex + 1;
        copy.runtimePhaseFrameCount = group.frames.length;
        normalizedFrames.push(copy);
      });
    });
    return { frames: normalizedFrames, diagnostics: diagnostics };
  }
  var originalCount = groups.length;
  var target = mergedRuntimePhaseTarget(groups, options);
  while (groups.length > target && groups.length > 1) {
    var pairIndex = chooseRuntimeMergePair(groups);
    groups[pairIndex].frames = groups[pairIndex].frames.concat(groups[pairIndex + 1].frames);
    groups.splice(pairIndex + 1, 1);
  }
  var cappedFrames = [];
  groups.forEach(function(group, groupIndex) {
    var phaseIndex = groupIndex + 1;
    var phaseTitle = group.frames[0] && (group.frames[0].chapterTitle || group.frames[0].title) || ('Phase ' + phaseIndex);
    group.frames.forEach(function(frame, frameIndex) {
      var copy = Object.assign({}, frame);
      copy.chapter = phaseIndex;
      copy.chapterTitle = phaseTitle;
      copy.runtimePhaseIndex = phaseIndex;
      copy.runtimePhaseFrameIndex = frameIndex + 1;
      copy.runtimePhaseFrameCount = group.frames.length;
      cappedFrames.push(copy);
    });
  });
  return {
    frames: cappedFrames,
    diagnostics: diagnostics.concat([{
      code: 'storyboard_pdf_runtime_phase_merge',
      severity: 'info',
      fromPhaseCount: originalCount,
      toPhaseCount: groups.length,
      minPhaseCount: Number(options.min) || RUNTIME_PHASE_MIN,
      maxPhaseCount: max,
      message: 'Merged adjacent storyboard frames into runtime phases before SourceIR build.',
    }]),
  };
}

function storyboardQualityDiagnostics(compiled, kind) {
  var diagnostics = [];
  var specs = safeArray(compiled && compiled.specs);
  var existing = safeArray(compiled && compiled.diagnostics);
  var noActionCount = existing.filter(function(item) {
    return item && item.code === 'storyboard_spec_phase_no_actions';
  }).length;
  var longWeakStoryboard = specs.length > 18 && noActionCount > 0;
  var consecutiveTimerOnly = 0;
  var maxConsecutiveTimerOnly = 0;
  specs.forEach(function(spec) {
    var required = safeArray(spec && spec.requiredInteractions).filter(Boolean);
    var interactionText = required.join(' ');
    var timerOnly = required.length === 0 || /^wait\b|timer/i.test(interactionText);
    if (timerOnly) {
      consecutiveTimerOnly += 1;
      if (consecutiveTimerOnly > maxConsecutiveTimerOnly) maxConsecutiveTimerOnly = consecutiveTimerOnly;
    } else {
      consecutiveTimerOnly = 0;
    }
  });
  if (longWeakStoryboard) {
    diagnostics.push({
      code: 'storyboard_pdf_low_quality_phase_split',
      severity: 'error',
      phaseCount: specs.length,
      noActionCount: noActionCount,
      message: 'PDF storyboard produced too many weak/no-action phases; use a phase-aware parser before SourceIR build.',
    });
  }
  if (specs.length > RUNTIME_PHASE_MAX) {
    diagnostics.push({
      code: 'storyboard_pdf_runtime_phase_cap_exceeded',
      severity: 'error',
      phaseCount: specs.length,
      maxPhaseCount: RUNTIME_PHASE_MAX,
      message: 'Runtime phase count exceeds the blueprint storyboard cap.',
    });
  }
  if (maxConsecutiveTimerOnly >= 4) {
    diagnostics.push({
      code: 'storyboard_pdf_consecutive_timer_only_phases',
      severity: 'error',
      maxConsecutiveTimerOnly: maxConsecutiveTimerOnly,
      message: 'Consecutive timer-only phases are likely to fail production CUA visual-freeze gates.',
    });
  }
  return diagnostics;
}

function scoreKeywordProfile(text, patterns) {
  var score = 0;
  safeArray(patterns).forEach(function(pattern) {
    try {
      var re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
      if (re.test(text)) score += 1;
    } catch (e) {}
  });
  return score;
}

function actionRulesFromRules(rules) {
  return safeArray(rules && rules.actions).filter(function(action) {
    return action && action.id && safeArray(action.patterns).length > 0;
  });
}

function scoreActionRules(text, actions) {
  var scores = {};
  safeArray(actions).forEach(function(action) {
    scores[action.id] = scoreKeywordProfile(text, action.patterns);
  });
  return scores;
}

function actionIdsFromScores(scores) {
  return Object.keys(scores || {}).filter(function(id) {
    return Number(scores[id] || 0) > 0;
  });
}

function preferredActionId(scores, order) {
  for (var i = 0; i < order.length; i += 1) {
    if (Number(scores && scores[order[i]] || 0) > 0) return order[i];
  }
  return '';
}

function inferSampleProfile(name, text, textChars) {
  var hay = [name, text].map(function(value) { return String(value || ''); }).join('\n');
  var rules = loadProfileRules();
  var actions = actionRulesFromRules(rules);
  var actionScores = scoreActionRules(hay, actions);
  var actionIds = actionIdsFromScores(actionScores);
  var primaryAction = preferredActionId(actionScores, [
    'cta', 'combine', 'deliver', 'transfer', 'unlock', 'upgrade', 'show',
    'select', 'collect', 'produce', 'reward', 'attack', 'move', 'wait',
  ]);
  var parser = 'generic';
  var structureScore = 0;
  var normalized = normalizePdfText(text);
  if (/(?:^|\n)\s*Phase\s*\d+\s*:/i.test(normalized)) {
    parser = 'phase-marker';
    structureScore = 1;
  } else if (contentLinesWithNumbers(text).some(function(line) { return /^\d{1,2}(\s+.+)?$/.test(line); })) {
    parser = 'numbered-table';
    structureScore = 1;
  }
  var actionConfidence = Math.min(1, actionIds.length / 4);
  return {
    kind: 'generic',
    parser: parser,
    confidence: Math.min(1, (actionConfidence + structureScore) / 2),
    ruleSet: rules.schemaVersion || 'unknown',
    scores: actionScores,
    actionScores: actionScores,
    actionIds: actionIds,
    primaryAction: primaryAction || 'observe',
    behaviorScores: actionScores,
    contentScores: {},
    explicitScores: {},
    profileEligibility: {},
    structureScore: structureScore,
    reason: 'Storyboard PDF classified by generic action primitives only; topic nouns are ignored by the classifier.',
  };
}

function classifySample(name, textChars, text) {
  return inferSampleProfile(name, text, textChars).kind;
}

function buildIrForSample(sample, outDir) {
  var requestedKind = sample && sample.kind || 'generic';
  var effectiveKind = 'generic';
  if (sample) sample.kind = effectiveKind;
  var text = sample.layoutText || sample.plainText;
  var frames;
  var entities = entitiesForKind(effectiveKind, text);
  var resources = resourcesForKind(effectiveKind, text);
  var diagnostics = [];
  if (requestedKind !== effectiveKind) {
    diagnostics.push({
      code: 'storyboard_pdf_topic_profile_disabled',
      severity: 'info',
      requestedKind: requestedKind,
      effectiveKind: effectiveKind,
      message: 'Topic/profile-specific PDF parsing is disabled for batch generation; generic action primitives are used instead.',
    });
  }
  var parser = sample.profile && sample.profile.parser || 'generic';
  if (parser === 'phase-marker') {
    frames = parsePhaseMarkedFrames(text, sample.name);
    if (frames.length < 2) frames = parseGenericFrames(text, sample.name);
  } else if (parser === 'numbered-table') {
    frames = parseNumberedTableFrames(text, sample.name);
    if (frames.length < 3) frames = parseGenericFrames(text, sample.name);
  } else {
    frames = parseGenericFrames(text, sample.name);
  }
  var capped = capRuntimePhases(frames, { min: RUNTIME_PHASE_MIN, max: RUNTIME_PHASE_MAX });
  frames = capped.frames;
  frames = enrichFramesWithVisibleEntities(frames, effectiveKind);
  diagnostics = diagnostics.concat(capped.diagnostics);
  var theme = themeForKind(effectiveKind);
  var ir = storyboardIr.normalizeStoryboardIr({
    projectName: sample.name,
    themeHint: theme,
    storyboardFrames: frames,
    entities: entities,
  }, {
    projectName: sample.name,
    theme: theme,
    entities: entities,
  });
  ir.diagnostics = ir.diagnostics.concat(diagnostics);
  return { ir: ir, entities: entities, resources: resources, frames: frames };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function sourceIrSummaryDiagnostics(sourceIr) {
  if (!sourceIr || !sourceIr.diagnostics) return [];
  return safeArray(sourceIr.diagnostics.storyboardSemanticFallbacks);
}

function processPdf(pdfPath, outRoot) {
  var name = basenameNoExt(pdfPath);
  var outDir = path.join(outRoot, safeName(name));
  ensureDir(outDir);
  var info = parsePdfInfo(pdfPath);
  var plainText = textOfPdf(pdfPath, false);
  var layoutText = textOfPdf(pdfPath, true);
  var textChars = stripText(plainText).length;
  var compactHash = sha256(compactText(plainText));
  var profile = inferSampleProfile(name, layoutText || plainText, textChars);
  var kind = profile.kind;
  var sample = {
    name: name,
    kind: kind,
    profile: profile,
    pdfPath: pdfPath,
    info: info,
    textChars: textChars,
    textCompactSha256: compactHash,
    plainText: plainText,
    layoutText: layoutText,
  };
  fs.writeFileSync(path.join(outDir, 'text.txt'), plainText);
  fs.writeFileSync(path.join(outDir, 'text-layout.txt'), layoutText);
  var built = buildIrForSample(sample, outDir);
  writeJson(path.join(outDir, 'storyboard-ir.json'), built.ir);
  writeJson(path.join(outDir, 'frames.json'), built.frames);
  if (sample.rowManifest) writeJson(path.join(outDir, 'row-manifest.json'), sample.rowManifest);

  var compiled = storyboardSpecCompiler.compileSpecsFromStoryboardIr(built.ir, {
    entities: built.entities,
    minActionCoverage: 0.35,
  });
  var qualityDiagnostics = storyboardQualityDiagnostics(compiled, kind);
  if (qualityDiagnostics.length > 0) {
    compiled.ok = false;
    compiled.diagnostics = safeArray(compiled.diagnostics).concat(qualityDiagnostics);
  }
  writeJson(path.join(outDir, 'spec-compile-report.json'), compiled);
  var sourceIr = null;
  var sourceIrDiagnostics = [];
  if (compiled.ok) {
    writeJson(path.join(outDir, 'specs.json'), compiled.specs);
    sourceIr = storyboardSourceIrCompiler.compileSourceSceneIrFromStoryboard({
      projectName: name,
      themeHint: themeForKind(kind),
      entities: built.entities,
      resources: built.resources,
      specs: compiled.specs,
      storyboardIr: built.ir,
    }, {
      sourceHtmlPath: path.join(outDir, 'source-ir-preview.html'),
    });
    sourceIrDiagnostics = sourceIrSummaryDiagnostics(sourceIr);
    writeJson(path.join(outDir, 'source-scene-ir.json'), sourceIr);
    var html = sourceIrPreviewRenderer.buildSourceIrPreviewHtml(sourceIr, {
      sourceHtmlPath: path.join(outDir, 'source-ir-preview.html'),
      html: '<div id="joystick"></div>',
    });
    fs.writeFileSync(path.join(outDir, 'source-ir-preview.html'), html);
  }

  return {
    name: name,
    kind: kind,
    profile: profile,
    pdfPath: pdfPath,
    outDir: outDir,
    pages: Number(info.Pages || 0),
    textChars: textChars,
    textCompactSha256: compactHash,
    frameCount: built.ir.frames.length,
    phaseCount: runtimePhaseCount(built.ir.frames),
    specCompileOk: compiled.ok,
    sourceIrCompileOk: compiled.ok && !sourceIrDiagnostics.some(function(item) { return item && item.severity === 'error'; }),
    specCount: compiled.specs.length,
    actionCoverage: compiled.summary.actionCoverage,
    diagnostics: built.ir.diagnostics.concat(compiled.diagnostics || [], sourceIrDiagnostics),
    rowCount: sample.rowManifest ? sample.rowManifest.rows.length : 0,
  };
}

function main() {
  var inputDir = process.argv[2];
  var outRoot = process.argv[3];
  if (!inputDir || !outRoot) usage();
  ensureDir(outRoot);
  ['pdfinfo', 'pdftotext'].forEach(function(cmd) {
    if (!firstExistingCommand([cmd])) throw new Error(cmd + ' not found in PATH');
  });
  var pdfs = fs.readdirSync(inputDir)
    .filter(function(file) { return /\.pdf$/i.test(file); })
    .map(function(file) { return path.join(inputDir, file); })
    .sort();
  var summaries = pdfs.map(function(pdfPath) {
    return processPdf(pdfPath, outRoot);
  });
  var byTextHash = {};
  summaries.forEach(function(item) {
    if (!byTextHash[item.textCompactSha256]) byTextHash[item.textCompactSha256] = [];
    byTextHash[item.textCompactSha256].push(item.name);
  });
  summaries.forEach(function(item) {
    var group = byTextHash[item.textCompactSha256] || [];
    if (group.length > 1) item.duplicateTextGroup = group;
  });
  var summary = {
    schemaVersion: 'storyboard-pdf-sample-processing.v1',
    generatedAt: new Date().toISOString(),
    inputDir: path.resolve(inputDir),
    outRoot: path.resolve(outRoot),
    samples: summaries,
  };
  writeJson(path.join(outRoot, 'summary.json'), summary);
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  }
}

module.exports = {
  processPdf: processPdf,
  buildIrForSample: buildIrForSample,
  _internals: {
    classifySample: classifySample,
    capRuntimePhases: capRuntimePhases,
    disambiguateFrameInteraction: disambiguateFrameInteraction,
    enrichFramesWithVisibleEntities: enrichFramesWithVisibleEntities,
    entitiesForKind: entitiesForKind,
    inferInteraction: inferInteraction,
    inferVisibleEntitiesForFrame: inferVisibleEntitiesForFrame,
    inferSampleProfile: inferSampleProfile,
    parseGenericFrames: parseGenericFrames,
    parseNumberedTableFrames: parseNumberedTableFrames,
    parsePhaseMarkedFrames: parsePhaseMarkedFrames,
    runtimePhaseCount: runtimePhaseCount,
    storyboardQualityDiagnostics: storyboardQualityDiagnostics,
    themeForKind: themeForKind,
    resourcesForKind: resourcesForKind,
  },
};
