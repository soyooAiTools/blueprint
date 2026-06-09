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
  schemaVersion: 'storyboard-pdf-profile-rules.fallback.v1',
  profiles: [
    { kind: 'guard', parserHint: 'generic', patterns: ['守护家园', '玉米|爆米花|异形|英雄塔|孢子|飞船舱室'] },
    { kind: 'space', parserHint: 'phase-marker', patterns: ['太空捡垃圾|太空救星', '太空舱|休眠舱|助手|怪物|航天|太阳能板', '回收站|太空垃圾|锻造|钻头'] },
    { kind: 'forest_defense', parserHint: 'phase-marker', patterns: ['取木射箭', '木头|木材|弩炮|传送带|红色士兵|森林营地|基地'] },
    { kind: 'shelter_warmth', parserHint: 'phase-marker', patterns: ['搜屋取暖', '火堆|冻僵|木材|电塔|电线|取暖|房间'] },
    { kind: 'water', parserHint: 'paragraph', patterns: ['卖水|制作子弹|桶装水|冰晶|熔炉|宇航员排队|农田|苹果'] },
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
  if (!rules || !Array.isArray(rules.profiles)) return DEFAULT_PROFILE_RULES;
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

function renderFirstPage(pdfPath, outPath, dpi) {
  var stem = outPath.replace(/\.jpg$/i, '');
  execFile('pdftoppm', ['-f', '1', '-singlefile', '-jpeg', '-r', String(dpi || 72), pdfPath, stem], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return outPath;
}

function imageSize(imagePath) {
  var text = execFile('identify', ['-format', '%w %h', imagePath]).trim();
  var parts = text.split(/\s+/).map(Number);
  return { width: parts[0] || 0, height: parts[1] || 0 };
}

function resizeImage(inputPath, outPath, width) {
  execFile('convert', [inputPath, '-resize', String(width || 1000) + 'x', outPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return outPath;
}

function cropImage(inputPath, outPath, crop) {
  execFile('convert', [
    inputPath,
    '-crop',
    crop.width + 'x' + crop.height + '+' + crop.x + '+' + crop.y,
    '+repage',
    outPath,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return outPath;
}

function appendImages(imagePaths, outPath) {
  if (!safeArray(imagePaths).length) return '';
  execFile('convert', imagePaths.concat(['-append', outPath]), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return outPath;
}

function textOfPdf(pdfPath, layout) {
  try {
    return execFile('pdftotext', layout ? ['-layout', pdfPath, '-'] : [pdfPath, '-']);
  } catch (e) {
    return '';
  }
}

function paragraphLines(text) {
  return stripText(text)
    .split(/\r?\n/)
    .map(function(line) { return line.trim(); })
    .filter(Boolean)
    .filter(function(line) { return !/^\d+$/.test(line); })
    .filter(function(line) { return !/^(序号|文字描述|画面|注释|需求描述)$/.test(line); });
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
  return paragraphLines(text)
    .filter(function(line) {
      return !/^(需求描述|序号|文字描述|画面|注释)$/.test(line);
    })
    .filter(function(line) {
      return !/^序号\s+文字描述\s+画面$/.test(line);
    });
}

function contentLinesWithNumbers(text) {
  return stripText(text)
    .split(/\r?\n/)
    .map(function(line) { return line.trim(); })
    .filter(Boolean)
    .filter(function(line) { return !/^?$/.test(line); })
    .filter(function(line) { return !/^(需求描述|序号|文字描述|画面|注释)$/.test(line); })
    .filter(function(line) { return !/^序号\s+文字描述\s+画面$/.test(line); })
    .filter(function(line) { return !/^大底图设定$/.test(line); });
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

function optionKind(options) {
  if (typeof options === 'string') return options;
  return String(options && options.kind || '');
}

function optionVerb(options) {
  if (typeof options === 'string') return '';
  return String(options && options.verb || '');
}

function optionPrimaryText(options) {
  if (typeof options === 'string') return '';
  return String(options && options.primaryText || '');
}

function firstPatternIndex(text, patterns) {
  text = String(text || '');
  var best = -1;
  safeArray(patterns).forEach(function(pattern) {
    var idx = text.search(pattern);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  });
  return best;
}

function hasSideCue(text, side) {
  text = String(text || '');
  if (side === 'right') return /(右侧|右边|右路|右方|右侧中间)/.test(text);
  if (side === 'left') return /(左侧|左边|左路|左方|自己所在一侧|己方|本侧)/.test(text);
  return false;
}

function hasTurretCue(text) {
  return /(弩炮|炮塔|箭塔|防御塔|射击)/.test(String(text || ''));
}

function sideSpecificTurretTarget(text, primaryText) {
  primaryText = String(primaryText || '');
  text = String(text || '');
  if (hasTurretCue(primaryText) && hasSideCue(primaryText, 'right')) return 'RightCrossbowTurret';
  if (hasTurretCue(primaryText) && hasSideCue(primaryText, 'left')) return 'LeftCrossbowTurret';
  if (hasTurretCue(text) && hasSideCue(text, 'right')) return 'RightCrossbowTurret';
  if (hasTurretCue(text) && hasSideCue(text, 'left')) return 'LeftCrossbowTurret';
  return '';
}

function inferForestDefenseTargetId(text, fallback, options) {
  var hay = String(text || '');
  var primaryText = optionPrimaryText(options);
  var verb = optionVerb(options);
  var bossIndex = firstPatternIndex(hay, [/巨大\s*Boss/i, /Boss\s*来袭/i, /boss\s*展示/i, /最终决战/, /血条/]);
  var rightWaveIndex = firstPatternIndex(hay, [/右侧开始刷新敌人/, /右侧.*?(敌人|红色士兵|刷新|来袭|战斗)/, /招募右侧工人/]);
  var rightWorkerIndex = firstPatternIndex(hay, [/招募右侧工人/, /右侧.*?(工人木屋|木屋|工人)/, /工人木屋/]);
  var turretTarget = sideSpecificTurretTarget(hay, primaryText);

  if (verb === 'attack') {
    if (rightWaveIndex >= 0 && (bossIndex < 0 || rightWaveIndex < bossIndex)) return 'RightEnemyWave';
    if (bossIndex >= 0) return 'BossEnemy';
    if (/Boss|BOSS|boss/.test(primaryText)) return 'BossEnemy';
    if (/敌|丧尸|怪|士兵/.test(hay)) return 'Enemy';
    if (turretTarget) return turretTarget;
  } else {
    if (turretTarget) return turretTarget;
    if ((verb === 'build' || verb === 'upgrade' || verb === 'click') && rightWorkerIndex >= 0 && !hasTurretCue(hay)) return 'RightWorkerHouse';
    if (bossIndex >= 0 && !hasTurretCue(primaryText)) return 'BossEnemy';
    if (rightWaveIndex >= 0 && !hasTurretCue(primaryText)) return 'RightEnemyWave';
  }

  if (/传送带/.test(hay)) return 'Conveyor';
  if (/弩炮|炮塔/.test(hay)) return 'CrossbowTurret';
  if (/木屋|基地|营地/.test(hay)) return 'BaseCamp';
  if (/树木|木材|木头/.test(hay)) return 'WoodPile';
  if (/敌|丧尸|BOSS|Boss|怪/.test(hay)) return bossIndex >= 0 ? 'BossEnemy' : 'Enemy';
  return fallback || 'Target';
}

function inferInteraction(text, fallbackTitle, options) {
  var hay = String(text || '') + ' ' + String(fallbackTitle || '');
  var kind = optionKind(options);
  if (/下载|跳转|下一关|结束/.test(hay)) return 'click:CtaButton';
  if (kind === 'shelter_warmth') return inferShelterWarmthInteraction(hay, fallbackTitle);
  if (/选择助手|角色卡片|只剩一个角色|随机出现/.test(hay)) return 'click:' + inferTargetId(hay, 'RoleCard', { kind: kind, verb: 'click' });
  if (/技能|进度条满|释放技能/.test(hay)) return 'upgrade:' + inferTargetId(hay, 'SkillMeter', { kind: kind, verb: 'upgrade' }) + ':2';
  if (/攻击|击杀|打死|打掉|打怪|战斗|Boss|BOSS|丧尸/.test(hay)) {
    return 'attack:' + inferTargetId(hay, 'Enemy', { kind: kind, verb: 'attack', primaryText: fallbackTitle });
  }
  if (/升级/.test(hay)) return 'upgrade:' + inferTargetId(hay, 'UpgradeTarget', { kind: kind, verb: 'upgrade', primaryText: fallbackTitle }) + ':2';
  if (/修建|建屋|建完|建好|建造|扩充|解锁|建成|打造|修复/.test(hay)) return 'build:' + inferTargetId(hay, 'BuildTarget', { kind: kind, verb: 'build', primaryText: fallbackTitle });
  if (/售卖|贩卖|换得|换取|金币|美金|收集|拾取|采集|采冰|捡|垃圾|冰晶|苹果|水|玉米/.test(hay)) {
    return 'collect:' + inferResourceId(hay) + ':1';
  }
  if (/引导|移动|回到|靠近|去/.test(hay)) return 'move_to:' + inferTargetId(hay, 'Target', { kind: kind, verb: 'move_to', primaryText: fallbackTitle });
  return String(fallbackTitle || text || 'observe').slice(0, 80);
}

function inferShelterWarmthInteraction(text, fallbackTitle) {
  var hay = String(text || '') + ' ' + String(fallbackTitle || '');
  if (/下载|跳转|结束页面|Play\s*Now|CTA|获取胜利|全场景积雪融化/.test(hay)) return 'click:CtaButton';
  if (/电塔需要物资|升级电塔|去电塔处缴纳|电塔升级/.test(hay)) return 'upgrade:PowerTower:3';
  if (/电池/.test(hay)) return 'collect:Battery:1';
  if (/钥匙/.test(hay)) return 'collect:Key:1';
  if (/缴纳木材后篝火升级为电塔|升级篝火为电塔|篝火变为电塔/.test(hay)) return 'upgrade:PowerTower:2';
  if (/右下房间|足够的木材|收集.*木材|木材.*开宝箱|先捡木材/.test(hay)) return 'collect:Wood:1';
  if (/右侧中间房间|搜刮物资|破坏家具|获得宝箱|出丧尸击杀|击杀丧尸/.test(hay)) return 'attack:Enemy';
  if (/篝火需要点燃|点燃篝火/.test(hay)) return 'collect:Wood:1';
  if (/房间|指引|前往|去/.test(hay)) return 'move_to:ShelterRoom';
  if (/火堆|篝火|寒意|寒冷|开局/.test(hay)) return 'move_to:Campfire';
  return String(fallbackTitle || text || 'observe').slice(0, 80);
}

function inferResourceId(text) {
  if (/垃圾|金属|碎块/.test(text)) return 'Scrap';
  if (/冰晶|冰/.test(text)) return 'Ice';
  if (/钥匙/.test(text)) return 'Key';
  if (/电池/.test(text)) return 'Battery';
  if (/木头|木材|木/.test(text)) return 'Wood';
  if (/桶装水|喝水|水/.test(text)) return 'Water';
  if (/苹果/.test(text)) return 'Apple';
  if (/玉米/.test(text)) return 'Corn';
  if (/金币|美金/.test(text)) return 'Coin';
  return 'Resource';
}

function inferTargetId(text, fallback, options) {
  if (optionKind(options) === 'forest_defense') return inferForestDefenseTargetId(text, fallback, options);
  if (/回收站|收购站|太空舱/.test(text)) return 'RecyclingCabin';
  if (/锻造/.test(text)) return 'ForgeWorkshop';
  if (/钻头/.test(text)) return 'Drill';
  if (/粉碎车/.test(text)) return 'CrusherCar';
  if (/液压车/.test(text)) return 'HydraulicCar';
  if (/角色卡片|选择助手|只剩一个角色|随机出现/.test(text)) return 'RoleCard';
  if (/技能|进度条满|进度条|释放/.test(text)) return 'SkillMeter';
  if (/传送带/.test(text)) return 'Conveyor';
  if (/弩炮|炮塔/.test(text)) return 'CrossbowTurret';
  if (/木屋|基地|营地/.test(text)) return 'BaseCamp';
  if (/火堆|取暖/.test(text)) return 'Campfire';
  if (/电塔|发电/.test(text)) return 'PowerTower';
  if (/电线/.test(text)) return 'PowerLine';
  if (/冻僵|人群/.test(text)) return 'FrozenCrowd';
  if (/树木|木材|木头/.test(text)) return 'WoodPile';
  if (/敌|丧尸|BOSS|Boss|怪/.test(text)) return 'Enemy';
  if (/房间/.test(text) && /火堆|取暖|冻僵|电塔|电线|木材|丧尸|宝箱|钥匙|电池/.test(text)) return 'ShelterRoom';
  if (/房间|船舱|餐厅|宿舍/.test(text)) return 'NewCabin';
  if (/冰晶|冰/.test(text)) return 'IceChunk';
  if (/水箱|浇水|制氧/.test(text)) return 'WaterTank';
  if (/爆米花制作|制作机器|机器/.test(text)) return 'PopcornMachine';
  if (/售卖台|卖爆米花|售卖/.test(text)) return 'PopcornStand';
  if (/小人|帮手|助手|工人|搬运/.test(text)) return 'HelperWorker';
  if (/异形船/.test(text)) return 'AlienShip';
  if (/武器台|步枪|枪/.test(text)) return 'WeaponRack';
  if (/塔台|英雄塔|英雄/.test(text)) return 'HeroTower';
  if (/孢子/.test(text)) return 'Spore';
  if (/升级/.test(text)) return 'ShipCabin';
  if (/熔炉|烧杯/.test(text)) return 'Furnace';
  if (/宇航员|船员/.test(text)) return 'AstronautQueue';
  if (/农田|植物|苹果/.test(text)) return 'FarmRoom';
  if (/水桶|桶装水/.test(text)) return 'WaterBucket';
  if (/门/.test(text)) return 'Door';
  if (/玉米|玉米地/.test(text)) return 'CornField';
  return fallback || 'Target';
}

function entitiesForKind(kind) {
  if (kind === 'space') {
    return [
      { name: 'Player', label: '玩家', template: 'PlayerController' },
      { name: 'SpaceJunk', label: '太空垃圾', template: 'Collectible' },
      { name: 'RecyclingCabin', label: '回收站太空舱', template: 'Buildable' },
      { name: 'ForgeWorkshop', label: '锻造间', template: 'Buildable' },
      { name: 'Drill', label: '钻头', template: 'Upgradeable' },
      { name: 'CrusherCar', label: '粉碎车', template: 'Upgradeable' },
      { name: 'HydraulicCar', label: '液压车', template: 'Upgradeable' },
      { name: 'NewCabin', label: '新船舱', template: 'Buildable' },
      { name: 'DormantPod', label: '休眠舱', template: 'Buildable' },
      { name: 'HelperWorker', label: '助手', template: 'NPC' },
      { name: 'RoleCard', label: '助手角色卡片', template: 'UI' },
      { name: 'SkillMeter', label: '助手技能条', template: 'UI' },
      { name: 'SolarPanel', label: '太阳能板', template: 'Static' },
      { name: 'Enemy', label: '太空怪物', template: 'Damageable' },
      { name: 'CtaButton', label: '下载按钮', template: 'UI' },
    ];
  }
  if (kind === 'water') {
    return [
      { name: 'Player', label: '玩家', template: 'PlayerController' },
      { name: 'AstronautQueue', label: '排队宇航员', template: 'Static' },
      { name: 'IceChunk', label: '冰晶', template: 'Collectible' },
      { name: 'Furnace', label: '熔炉', template: 'Buildable' },
      { name: 'WaterBucket', label: '桶装水', template: 'Collectible' },
      { name: 'FarmRoom', label: '种植室', template: 'Buildable' },
      { name: 'Apple', label: '苹果', template: 'Collectible' },
      { name: 'CtaButton', label: '下载按钮', template: 'UI' },
    ];
  }
  if (kind === 'guard') {
    return [
      { name: 'Player', label: '玩家', template: 'PlayerController' },
      { name: 'IceChunk', label: '冰块', template: 'Collectible' },
      { name: 'WaterTank', label: '水箱', template: 'Buildable' },
      { name: 'CornField', label: '玉米地', template: 'Buildable' },
      { name: 'PopcornMachine', label: '爆米花制作机', template: 'Buildable' },
      { name: 'PopcornStand', label: '爆米花售卖台', template: 'Buildable' },
      { name: 'Door', label: '门', template: 'Static' },
      { name: 'HelperWorkerA', label: '采收小人', template: 'NPC' },
      { name: 'HelperWorkerB', label: '采冰小人', template: 'NPC' },
      { name: 'AlienShip', label: '异形飞船', template: 'Static' },
      { name: 'DockingDoor', label: '对接舱门', template: 'Static' },
      { name: 'WeaponRack', label: '武器台', template: 'Buildable' },
      { name: 'HeroTower', label: '英雄塔台', template: 'Upgradeable' },
      { name: 'Enemy', label: '异形敌人', template: 'Damageable' },
      { name: 'Spore', label: '异形孢子', template: 'Damageable' },
      { name: 'ShipCabin', label: '飞船舱室', template: 'Upgradeable' },
      { name: 'BossEnemy', label: '异形 Boss', template: 'Damageable' },
      { name: 'CtaButton', label: '下载按钮', template: 'UI' },
    ];
  }
  if (kind === 'forest_defense') {
    return [
      { name: 'Player', label: '玩家', template: 'PlayerController' },
      { name: 'WoodPile', label: '木材堆', template: 'Collectible' },
      { name: 'Conveyor', label: '传送带', template: 'Buildable' },
      { name: 'CrossbowTurret', label: '弩炮', template: 'Buildable' },
      { name: 'LeftCrossbowTurret', label: '左侧弩炮', template: 'Buildable' },
      { name: 'RightCrossbowTurret', label: '右侧炮塔', template: 'Buildable' },
      { name: 'BaseCamp', label: '森林基地', template: 'Buildable' },
      { name: 'HelperWorker', label: '搬运工人', template: 'NPC' },
      { name: 'RightWorkerHouse', label: '右侧工人木屋', template: 'Buildable' },
      { name: 'Enemy', label: '红色士兵', template: 'Damageable' },
      { name: 'RightEnemyWave', label: '右侧敌人', template: 'Damageable' },
      { name: 'BossEnemy', label: 'Boss 敌人', template: 'Damageable' },
      { name: 'CtaButton', label: '下载按钮', template: 'UI' },
    ];
  }
  if (kind === 'shelter_warmth') {
    return [
      { name: 'Player', label: '玩家', template: 'PlayerController' },
      { name: 'Campfire', label: '火堆', template: 'Buildable' },
      { name: 'WoodPile', label: '木材', template: 'Collectible' },
      { name: 'ShelterRoom', label: '房间', template: 'Buildable' },
      { name: 'PowerTower', label: '电塔', template: 'Upgradeable' },
      { name: 'PowerLine', label: '电线', template: 'Static' },
      { name: 'FrozenCrowd', label: '冻僵人群', template: 'NPC' },
      { name: 'Enemy', label: '丧尸', template: 'Damageable' },
      { name: 'Chest', label: '宝箱', template: 'Collectible' },
      { name: 'Furniture', label: '家具', template: 'Damageable' },
      { name: 'KeyItem', label: '钥匙', template: 'Collectible' },
      { name: 'Battery', label: '电池', template: 'Collectible' },
      { name: 'AxeOrbit', label: '飞斧', template: 'Weapon' },
      { name: 'CtaButton', label: '下载按钮', template: 'UI' },
    ];
  }
  return [{ name: 'Player', label: '玩家', template: 'PlayerController' }, { name: 'CtaButton', label: '下载按钮', template: 'UI' }];
}

function themeForKind(kind) {
  if (kind === 'forest_defense') return 'farming';
  return kind === 'water' || kind === 'space' || kind === 'guard' ? 'space' : 'default';
}

function resourcesForKind(kind) {
  if (kind === 'forest_defense') {
    return [
      { id: 'Wood', label: '木头', carrierEntity: 'WoodPile', kind: 'resource', initial: 0 },
      { id: 'Coin', label: '金币', carrierEntity: 'BaseCamp', kind: 'resource', initial: 0 },
    ];
  }
  if (kind === 'shelter_warmth') {
    return [
      { id: 'Wood', label: '木材', carrierEntity: 'WoodPile', kind: 'resource', initial: 0 },
      { id: 'Key', label: '钥匙', carrierEntity: 'KeyItem', kind: 'resource', initial: 0 },
      { id: 'Battery', label: '电池', carrierEntity: 'Battery', kind: 'resource', initial: 0 },
    ];
  }
  if (kind === 'guard') {
    return [
      { id: 'Ice', label: '冰块', carrierEntity: 'IceChunk', kind: 'resource', initial: 0 },
      { id: 'Corn', label: '玉米', carrierEntity: 'CornField', kind: 'resource', initial: 0 },
      { id: 'Popcorn', label: '爆米花', carrierEntity: 'PopcornMachine', kind: 'resource', initial: 0 },
      { id: 'Coin', label: '金币', carrierEntity: 'PopcornStand', kind: 'resource', initial: 0 },
    ];
  }
  return [];
}

function entityNamesForKind(kind) {
  return entitiesForKind(kind).map(function(entity) { return entity.name || entity.id; }).filter(Boolean);
}

function addVisibleEntity(out, entitySet, name) {
  if (!name || !entitySet[name]) return;
  out.push(name);
}

function addInteractionVisibleEntity(out, entitySet, interaction, kind) {
  var parts = String(interaction || '').split(':').map(function(part) { return part.trim(); });
  var verb = parts[0] || '';
  var target = parts[1] || '';
  if (verb === 'collect') {
    if (target === 'Wood') addVisibleEntity(out, entitySet, 'WoodPile');
    else if (target === 'Coin' && kind === 'forest_defense') addVisibleEntity(out, entitySet, 'BaseCamp');
    else if (target === 'Coin' && kind === 'space') addVisibleEntity(out, entitySet, 'DormantPod');
    else addVisibleEntity(out, entitySet, target);
    return;
  }
  if (verb === 'click' && /^CtaButton$/i.test(target)) {
    addVisibleEntity(out, entitySet, 'CtaButton');
    return;
  }
  addVisibleEntity(out, entitySet, target);
}

function visibleEntityKeywordRules(kind) {
  var common = [
    ['CtaButton', /下载|跳转|结束页面|PlayNow|CTA|logo/i],
    ['Enemy', /敌|怪|丧尸|士兵|战斗|打怪|击杀|攻击/],
  ];
  if (kind === 'forest_defense') {
    return common.concat([
      ['BaseCamp', /基地|营地|木屋|城堡/],
      ['WoodPile', /木头|木材|树木|资源/],
      ['Conveyor', /传送带/],
      ['LeftCrossbowTurret', /(左侧|左边|左路|自己所在一侧|己方|本侧).*?(弩炮|炮塔|射击)|(弩炮|炮塔|射击).*?(左侧|左边|左路|自己所在一侧|己方|本侧)/],
      ['RightCrossbowTurret', /(右侧|右边|右路|右方).*?(弩炮|炮塔|射击)|(弩炮|炮塔|射击).*?(右侧|右边|右路|右方)/],
      ['CrossbowTurret', /弩炮|炮塔|射击/],
      ['RightWorkerHouse', /(右侧|右边).*?(工人木屋|木屋|工人)|工人木屋/],
      ['RightEnemyWave', /(右侧|右边).*?(敌人|红色士兵|刷新|来袭|战斗)|右侧开始刷新敌人/],
      ['HelperWorker', /小人|工人|帮手|搬运/],
    ]);
  }
  if (kind === 'space') {
    return common.concat([
      ['RecyclingCabin', /太空舱|主空间|航天休眠室|舱内/],
      ['DormantPod', /休眠舱|培养皿/],
      ['HelperWorker', /助手|英雄|角色|跟随/],
      ['RoleCard', /角色卡片|选择助手|随机出现|只剩一个角色/],
      ['SkillMeter', /技能|进度条|释放/],
      ['SolarPanel', /太阳能板/],
      ['NewCabin', /房间|舱/],
      ['SpaceJunk', /垃圾|金属|碎块/],
    ]);
  }
  if (kind === 'shelter_warmth') {
    return common.concat([
      ['Campfire', /火堆|篝火|取暖|点燃/],
      ['WoodPile', /木材|木头|树木/],
      ['ShelterRoom', /房间|左下|左上|右下|右上|右侧中间|墙壁|床铺/],
      ['PowerTower', /电塔|发电|升级/],
      ['PowerLine', /电线|链接/],
      ['FrozenCrowd', /冻僵|人群|苏醒|欢呼/],
      ['Chest', /宝箱/],
      ['Furniture', /家具|破坏/],
      ['KeyItem', /钥匙/],
      ['Battery', /电池/],
      ['AxeOrbit', /斧子|飞斧/],
    ]);
  }
  return common;
}

function frameInferenceText(frame) {
  return [
    frame && frame.title,
    frame && frame.chapterTitle,
    frame && frame.scene,
    frame && frame.ui,
  ].map(function(value) { return String(value || ''); }).filter(Boolean).join(' ');
}

function framePrimaryText(frame) {
  return [
    frame && frame.title,
    frame && frame.chapterTitle,
    frame && frame.ui,
  ].map(function(value) { return String(value || ''); }).filter(Boolean).join(' ');
}

function interactionParts(value) {
  if (value && typeof value === 'object') {
    return {
      object: value,
      verb: String(value.verb || '').trim(),
      target: String(value.target || value.entity || value.resource || '').trim(),
      amount: value.amount == null ? '' : String(value.amount),
    };
  }
  var parts = String(value || '').split(':').map(function(part) { return part.trim(); });
  return { object: null, verb: parts[0] || '', target: parts[1] || '', amount: parts[2] || '', rest: parts.slice(2) };
}

function coarseForestTarget(target) {
  return !target || /^(Target|BuildTarget|UpgradeTarget|CrossbowTurret|Enemy)$/.test(String(target || ''));
}

function rewriteInteractionTarget(interaction, target) {
  var parts = interactionParts(interaction);
  if (!parts.verb || !target) return interaction;
  if (parts.object) {
    var next = Object.assign({}, parts.object, { target: target });
    if (parts.verb === 'collect') next.resource = parts.object.resource || parts.target;
    next.raw = [parts.verb, target].concat(parts.amount ? [parts.amount] : []).join(':');
    return next;
  }
  var suffix = safeArray(parts.rest).filter(Boolean);
  return [parts.verb, target].concat(suffix).join(':');
}

function disambiguateFrameInteraction(frame, kind) {
  var copy = Object.assign({}, frame || {});
  if (kind !== 'forest_defense') return copy;
  var parts = interactionParts(copy.interaction);
  if (['attack', 'build', 'upgrade', 'move_to', 'click'].indexOf(parts.verb) < 0) return copy;
  var target = inferTargetId(frameInferenceText(copy), parts.target || 'Target', {
    kind: kind,
    verb: parts.verb,
    primaryText: framePrimaryText(copy),
  });
  if (!target || target === parts.target) return copy;
  if (!coarseForestTarget(parts.target) && !/^(LeftCrossbowTurret|RightCrossbowTurret|RightEnemyWave|BossEnemy|RightWorkerHouse)$/.test(target)) return copy;
  copy.interaction = rewriteInteractionTarget(copy.interaction, target);
  copy.entityDisambiguation = {
    from: parts.target || '',
    to: target,
    kind: kind,
    reason: 'storyboard-direction-or-boss-cue',
  };
  return copy;
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


function parseSpaceFrames(text) {
  var normalized = stripText(text)
    .replace(/Phas\s*\n\s*e\s*(\d+)/g, 'Phase$1')
    .replace(/Phas\s*e\s*(\d+)/g, 'Phase$1')
    .replace(/Phase\s*(\d+)\s*:/g, 'Phase$1:');
  var re = /Phase(\d+):/g;
  var matches = [];
  var match;
  while ((match = re.exec(normalized))) {
    matches.push({ phase: Number(match[1]), index: match.index, end: re.lastIndex });
  }
  var frames = [];
  var lastChapter = 0;
  for (var i = 0; i < matches.length; i += 1) {
    var rawChapter = matches[i].phase;
    var chapter = rawChapter <= lastChapter ? lastChapter + 1 : rawChapter;
    lastChapter = chapter;
    var start = matches[i].end;
    var end = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
    var body = normalized.slice(start, end).trim();
    var lines = paragraphLines(body);
    var titleParts = [];
    for (var j = 0; j < lines.length; j += 1) {
      if (lines[j].length > 18 && titleParts.length > 0) break;
      if (titleParts.length < 2) titleParts.push(lines[j]);
    }
    var title = collapseLines(titleParts) || ('Phase ' + chapter);
    var description = collapseLines(lines.slice(titleParts.length)) || collapseLines(lines);
    frames.push({
      id: 'space-phase-' + chapter,
      chapter: chapter,
      chapterTitle: title,
      step: 1,
      title: title,
      scene: description,
      interaction: inferInteraction(title + ' ' + description, title),
      ui: title,
      timing: '玩家操作，预计 3-5s',
    });
  }
  return frames;
}

function parseWaterFrames(text) {
  var lines = paragraphLines(text)
    .filter(function(line) { return line !== '\f'; })
    .filter(function(line) { return !/^?$/.test(line); });
  var paragraphs = [];
  var current = [];
  lines.forEach(function(line) {
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
      id: 'water-step-' + (index + 1),
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

function collapsedStoryboardText(text) {
  return normalizePdfText(text).replace(/\s+/g, ' ').trim();
}

function findCueIndex(text, cue, startAt) {
  startAt = Math.max(0, Number(startAt) || 0);
  var match = String(text || '').slice(startAt).match(cue);
  return match ? startAt + match.index : -1;
}

function chunkBetweenCues(text, startCue, endCue, fallback) {
  var source = String(text || '');
  var start = findCueIndex(source, startCue, 0);
  if (start < 0) return fallback || '';
  var end = endCue ? findCueIndex(source, endCue, start + 1) : -1;
  return source.slice(start, end >= 0 ? end : source.length).trim();
}

function parseShelterWarmthFrames(text) {
  var source = collapsedStoryboardText(text);
  if (!/搜屋取暖|火堆|篝火|电塔|取暖/.test(source)) return [];
  var rows = [
    {
      title: '开局寒冷火堆',
      start: /冰雪场景|风雪吹灭篝火|熄灭的小火堆/,
      end: /篝火需要点燃/,
      interaction: 'move_to:Campfire',
    },
    {
      title: '收集木材点燃篝火',
      start: /篝火需要点燃/,
      end: /篝火点燃后变旺/,
      interaction: 'collect:Wood:1',
    },
    {
      title: '前往右侧中间房间',
      start: /篝火点燃后变旺/,
      end: /右侧中间房间里有数量/,
      interaction: 'move_to:ShelterRoom',
    },
    {
      title: '右中房间搜刮战斗',
      start: /右侧中间房间里有数量/,
      end: /右下房间里也有丧尸/,
      interaction: 'attack:Enemy',
    },
    {
      title: '右下房间收集木材飞斧',
      start: /右下房间里也有丧尸/,
      end: /缴纳木材后篝火升级为电/,
      interaction: 'collect:Wood:1',
    },
    {
      title: '升级篝火为电塔',
      start: /缴纳木材后篝火升级为电|升级篝火为电塔/,
      end: /升级后电塔上方再度出现/,
      interaction: 'upgrade:PowerTower:2',
    },
    {
      title: '左下房间获取钥匙',
      start: /升级后电塔上方再度出现|左下房间获取钥匙/,
      end: /房间里的宝箱家具和丧尸/,
      interaction: 'collect:Key:1',
    },
    {
      title: '左上右上房间获取电池',
      start: /房间里的宝箱家具和丧尸/,
      end: /电塔需要物资/,
      interaction: 'collect:Battery:1',
    },
    {
      title: '缴纳电池木材升级电塔',
      start: /电塔需要物资/,
      end: /全场景积雪融化|结束页面/,
      interaction: 'upgrade:PowerTower:3',
    },
    {
      title: '胜利结束页面',
      start: /全场景积雪融化|结束页面/,
      end: null,
      interaction: 'click:CtaButton',
    },
  ];
  var frames = rows.map(function(row, index) {
    var scene = chunkBetweenCues(source, row.start, row.end, '');
    if (!scene) scene = row.title;
    return {
      id: 'shelter-warmth-' + (index + 1),
      chapter: index + 1,
      chapterTitle: row.title,
      step: 1,
      title: row.title,
      scene: scene,
      interaction: row.interaction || inferShelterWarmthInteraction(scene, row.title),
      ui: row.title,
      timing: '玩家操作，预计 3-5s',
      parser: 'shelter-warmth-profile',
    };
  });
  return frames.filter(function(frame) {
    return frame.scene && frame.scene !== frame.title || /^click:CtaButton$/.test(frame.interaction);
  }).length >= 8 ? frames : [];
}

function parseGenericFrames(text, fallbackName) {
  var phaseFrames = parsePhaseMarkedFrames(text, fallbackName);
  if (phaseFrames.length >= 2) return phaseFrames;
  var numberedFrames = parseNumberedTableFrames(text, fallbackName);
  if (numberedFrames.length >= 3) return numberedFrames;
  return parseWaterFrames(text);
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
  if (verb === 'attack' || verb === 'build' || verb === 'upgrade' || verb === 'collect') return 70;
  if (verb === 'move_to' || verb === 'move') return 50;
  if (verb === 'wait' || verb === 'timer') return 10;
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
  var cueRe = /(玩家看到什么[:：]|在第[一二三四五六七八九十]+个房间|在第二个房间|右下角房间|右下房间|右侧中间房间|左下房间获取钥匙|左上右上房间获取电池|升级电塔|获取胜利|结束页面[:：]?)/g;
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
  var diagnostics = [];
  if (groups.length < (Number(options.min) || RUNTIME_PHASE_MIN)) {
    var expanded = expandRuntimePhases(groups, options);
    groups = expanded.groups;
    diagnostics = diagnostics.concat(expanded.diagnostics);
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
  if (kind !== 'guard' && maxConsecutiveTimerOnly >= 4) {
    diagnostics.push({
      code: 'storyboard_pdf_consecutive_timer_only_phases',
      severity: 'error',
      maxConsecutiveTimerOnly: maxConsecutiveTimerOnly,
      message: 'Consecutive timer-only phases are likely to fail production CUA visual-freeze gates.',
    });
  }
  return diagnostics;
}

var GUARD_HOME_VISUAL_FALLBACK_VERSION = 'guard-home-image-table.v1';
var GUARD_HOME_VISUAL_ROWS = [
  {
    title: '引导出门凿冰制氧',
    scene: '玩家位于飞船农场舱室，门外有冰块采集点，箭头引导玩家从玉米地侧门出门去凿冰。',
    interaction: 'move_to:IceChunk',
    ui: '前往冰块',
    visibleEntities: ['Player', 'CornField', 'Door', 'IceChunk'],
  },
  {
    title: '圆锯凿碎冰块',
    scene: '玩家使用圆锯切碎冰块，冰块飞到背包上，表现背包逐渐装满。',
    interaction: 'collect:Ice:1',
    ui: '收集冰块',
    visibleEntities: ['Player', 'IceChunk', 'Door'],
  },
  {
    title: '回舱注入水箱',
    scene: '玩家回到一号舱室，把冰块倒入水箱，水箱启动并给植物浇水制氧。',
    interaction: 'build:WaterTank',
    ui: '注入水箱',
    visibleEntities: ['Player', 'WaterTank', 'CornField', 'ShipCabin'],
  },
  {
    title: '收割成熟玉米',
    scene: '植物长出玉米，箭头引导玩家收割玉米，玉米飞到玩家背包上。',
    interaction: 'collect:Corn:1',
    ui: '收割玉米',
    visibleEntities: ['Player', 'CornField', 'WaterTank', 'PopcornMachine'],
  },
  {
    title: '制作爆米花',
    scene: '玩家把玉米放入爆米花机器，机器做 Q 弹缩放动画，爆米花不断从锅里冒出并打包。',
    interaction: 'build:PopcornMachine',
    ui: '制作爆米花',
    visibleEntities: ['Player', 'PopcornMachine', 'CornField', 'PopcornStand'],
  },
  {
    title: '售卖爆米花得金币',
    scene: '玩家背着打包好的爆米花来到售卖台售卖，获得金币，售卖台旁弹出解锁小人 UI。',
    interaction: 'collect:Coin:1',
    ui: '获得金币',
    visibleEntities: ['Player', 'PopcornStand', 'PopcornMachine', 'HelperWorkerA'],
  },
  {
    title: '解锁采收小人',
    scene: '玩家用首轮金币解锁第一个小人，小人负责收玉米、制作爆米花并拿去售卖。',
    interaction: 'build:HelperWorkerA',
    ui: '解锁小人',
    visibleEntities: ['Player', 'HelperWorkerA', 'CornField', 'PopcornMachine', 'PopcornStand'],
  },
  {
    title: '继续出门采冰',
    scene: '解锁售卖小人后，玉米地门口出现解锁 UI，箭头继续引导玩家出门凿冰。',
    interaction: 'move_to:IceChunk',
    ui: '继续采冰',
    visibleEntities: ['Player', 'HelperWorkerA', 'CornField', 'Door', 'IceChunk'],
  },
  {
    title: '再次浇水长玉米',
    scene: '玩家把新采集的冰块放入水箱，植物再次被浇水并长出玉米。',
    interaction: 'build:WaterTank',
    ui: '浇水',
    visibleEntities: ['Player', 'WaterTank', 'CornField', 'HelperWorkerA'],
  },
  {
    title: '再次制作爆米花',
    scene: '玩家或小人把玉米送到爆米花制作机，制作更多爆米花。',
    interaction: 'collect:Popcorn:1',
    ui: '获得爆米花',
    visibleEntities: ['Player', 'HelperWorkerA', 'CornField', 'PopcornMachine', 'PopcornStand'],
  },
  {
    title: '解锁采冰小人',
    scene: '第二次售卖获得金币后，箭头引导玩家解锁第二个小人。',
    interaction: 'build:HelperWorkerB',
    ui: '解锁第二个小人',
    visibleEntities: ['Player', 'HelperWorkerA', 'HelperWorkerB', 'PopcornStand', 'IceChunk'],
  },
  {
    title: '小人自动凿冰',
    scene: '第二个小人主要负责出门凿冰，冰块持续进入飞船生产循环。',
    interaction: 'collect:Ice:1',
    ui: '自动采冰',
    visibleEntities: ['Player', 'HelperWorkerB', 'IceChunk', 'WaterTank'],
  },
  {
    title: '异形船靠近抓取',
    scene: '飞船闪红并晃动，镜头拉远，右侧更大的异形飞船靠近。',
    interaction: 'move_to:AlienShip',
    ui: '发现异形船',
    visibleEntities: ['Player', 'ShipCabin', 'AlienShip', 'DockingDoor'],
  },
  {
    title: '异形飞船完成对接',
    scene: '异形船伸出机械臂抓住我们的飞船并强行对接，下面异形开始向我方飞船移动。',
    interaction: 'move_to:DockingDoor',
    ui: '飞船对接',
    visibleEntities: ['Player', 'AlienShip', 'DockingDoor', 'Enemy', 'ShipCabin'],
  },
  {
    title: '拿武器击杀异形',
    scene: '镜头推近三号舱室，门口武器台上放着步枪，箭头引导玩家拿枪出门击杀异形。',
    interaction: 'attack:Enemy',
    ui: '击杀异形',
    visibleEntities: ['Player', 'WeaponRack', 'Enemy', 'DockingDoor'],
  },
  {
    title: '解锁英雄塔台',
    scene: '玩家用金币解锁塔台英雄，英雄帮助攻击移动缓慢的异形。',
    interaction: 'build:HeroTower',
    ui: '解锁英雄',
    visibleEntities: ['Player', 'HeroTower', 'Enemy', 'ShipCabin'],
  },
  {
    title: '打爆孢子刷怪',
    scene: '沿途孢子会爆出异形，玩家和英雄塔需要攻击孢子并处理刷出的敌人。',
    interaction: 'attack:Spore',
    ui: '打爆孢子',
    visibleEntities: ['Player', 'HeroTower', 'Spore', 'Enemy'],
  },
  {
    title: '英雄防线拦截',
    scene: '英雄塔不一定能清掉所有异形，部分异形继续向农场舱室门口推进。',
    interaction: 'attack:Enemy',
    ui: '拦截异形',
    visibleEntities: ['Player', 'HeroTower', 'Enemy', 'Spore', 'Door'],
  },
  {
    title: '保护舱门',
    scene: '有一两只异形跑到农场舱室门口拍打舱门，引导玩家回防击杀。',
    interaction: 'attack:Enemy',
    ui: '保护舱门',
    visibleEntities: ['Player', 'Door', 'Enemy', 'HeroTower'],
  },
  {
    title: '升级三号舱室',
    scene: '解锁完异形舱室的所有英雄塔后，三号舱室门口弹出升级 UI，玩家交金币升级。',
    interaction: 'upgrade:ShipCabin:2',
    ui: '升级舱室',
    visibleEntities: ['Player', 'ShipCabin', 'HeroTower', 'Enemy', 'DockingDoor'],
  },
  {
    title: '英雄武器升级',
    scene: '镜头拉远展示整艘飞船升级特效，英雄塔武器升级成迫击炮。',
    interaction: 'upgrade:HeroTower:2',
    ui: '升级英雄塔',
    visibleEntities: ['Player', 'HeroTower', 'ShipCabin', 'Enemy'],
  },
  {
    title: '迫击炮清场',
    scene: '所有英雄一起投放炸弹到船尾，连续爆炸清理剩余异形和孢子。',
    interaction: 'attack:Enemy',
    ui: '清理异形',
    visibleEntities: ['Player', 'HeroTower', 'Enemy', 'Spore', 'ShipCabin'],
  },
  {
    title: 'BOSS 出现并收口',
    scene: '船尾爆出一只大异形 Boss，画面进入结束收口并露出下载 CTA。',
    interaction: 'click:CtaButton',
    ui: '立即下载',
    visibleEntities: ['Player', 'BossEnemy', 'HeroTower', 'ShipCabin', 'CtaButton'],
  },
];

function buildGuardVisualFallbackFrames(rowManifest) {
  return GUARD_HOME_VISUAL_ROWS.map(function(item, index) {
    var row = safeArray(rowManifest && rowManifest.rows)[index] || {};
    var chapter = index + 1;
    return {
      id: 'guard-row-' + chapter,
      chapter: chapter,
      chapterTitle: item.title,
      step: 1,
      title: item.title,
      scene: item.scene,
      interaction: item.interaction,
      ui: item.ui,
      entities: item.visibleEntities,
      visibleEntities: item.visibleEntities,
      image: row.cropPath || '',
      timing: '玩家操作，预计 3-5s',
      parserFallback: GUARD_HOME_VISUAL_FALLBACK_VERSION,
    };
  });
}

function buildVisualOnlyFrames(rowManifest) {
  return safeArray(rowManifest.rows).map(function(row) {
    return {
      id: 'guard-row-' + row.index,
      chapter: row.index,
      chapterTitle: 'Row ' + row.index + ' needs OCR',
      step: 1,
      title: 'Row ' + row.index + ' needs OCR',
      scene: 'Image-only storyboard row. OCR or visual parser required before semantic compilation.',
      interaction: '',
      ui: '',
      image: row.cropPath,
      timing: '待识别',
    };
  });
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

function inferSampleProfile(name, text, textChars) {
  var hay = [name, text].map(function(value) { return String(value || ''); }).join('\n');
  var rules = loadProfileRules();
  var profiles = safeArray(rules.profiles);
  var profileScores = {};
  var profileByKind = {};
  profiles.forEach(function(profile) {
    if (!profile || !profile.kind) return;
    profileByKind[profile.kind] = profile;
    profileScores[profile.kind] = scoreKeywordProfile(hay, profile.patterns);
  });
  ['guard', 'space', 'water'].forEach(function(kind) {
    if (profileScores[kind] == null) profileScores[kind] = 0;
  });
  var bestKind = 'generic';
  var bestScore = 0;
  Object.keys(profileScores).forEach(function(kind) {
    if (profileScores[kind] > bestScore) {
      bestKind = kind;
      bestScore = profileScores[kind];
    }
  });
  if (/守护家园/.test(name) || textChars < 50) {
    bestKind = 'guard';
    bestScore = Math.max(bestScore, 3);
  }
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
  else if (profileByKind[bestKind] && profileByKind[bestKind].parserHint) parser = profileByKind[bestKind].parserHint;
  else if (bestKind === 'space') parser = 'phase-marker';
  else if (bestKind === 'water') parser = 'paragraph';
  return {
    kind: bestKind,
    parser: parser,
    confidence: Math.min(1, (bestScore + structureScore) / 3),
    ruleSet: rules.schemaVersion || 'unknown',
    scores: profileScores,
    structureScore: structureScore,
    reason: bestKind === 'generic'
      ? 'No named or feature profile crossed the classification threshold.'
      : 'Matched storyboard profile keywords and structure.',
  };
}

function classifySample(name, textChars, text) {
  return inferSampleProfile(name, text, textChars).kind;
}

function createRowCrops(pdfPath, outDir, kind) {
  ensureDir(outDir);
  var renderPath = path.join(outDir, 'preview-source.jpg');
  renderFirstPage(pdfPath, renderPath, kind === 'guard' ? 45 : 60);
  var previewPath = path.join(outDir, 'preview.jpg');
  resizeImage(renderPath, previewPath, 1000);
  var size = imageSize(previewPath);
  var rowCount = kind === 'guard' ? 23 : 0;
  var rows = [];
  if (rowCount > 0) {
    var top = Math.round(size.height * 0.057);
    var bottom = Math.round(size.height * 0.984);
    var rowHeight = Math.floor((bottom - top) / rowCount);
    var cropDir = path.join(outDir, 'rows');
    ensureDir(cropDir);
    for (var i = 0; i < rowCount; i += 1) {
      var y = top + i * rowHeight;
      var h = i === rowCount - 1 ? bottom - y : rowHeight;
      var cropPath = path.join(cropDir, 'row-' + String(i + 1).padStart(2, '0') + '.jpg');
      cropImage(previewPath, cropPath, { x: 0, y: y, width: size.width, height: h });
      rows.push({
        index: i + 1,
        cropPath: cropPath,
        bbox: { x: 0, y: y, width: size.width, height: h },
        needsOcr: true,
      });
    }
    appendImages(rows.map(function(row) { return row.cropPath; }), path.join(outDir, 'rows-contact.jpg'));
  }
  return {
    previewPath: previewPath,
    sourcePreviewPath: renderPath,
    width: size.width,
    height: size.height,
    rows: rows,
  };
}

function buildIrForSample(sample, outDir) {
  var frames;
  var entities = entitiesForKind(sample.kind);
  var resources = resourcesForKind(sample.kind);
  var diagnostics = [];
  var text = sample.layoutText || sample.plainText;
  var parser = sample.profile && sample.profile.parser || 'generic';
  if (sample.kind === 'guard') {
    sample.rowManifest = createRowCrops(sample.pdfPath, outDir, sample.kind);
    frames = buildGuardVisualFallbackFrames(sample.rowManifest);
    diagnostics.push({
      code: 'pdf_image_only_guard_template_fallback',
      severity: 'info',
      version: GUARD_HOME_VISUAL_FALLBACK_VERSION,
      rowCount: sample.rowManifest.rows.length,
    });
  } else if (sample.kind === 'shelter_warmth') {
    frames = parseShelterWarmthFrames(text);
    if (frames.length < 8 && parser === 'phase-marker') frames = parsePhaseMarkedFrames(text, sample.name);
    if (frames.length < 2) frames = parseGenericFrames(text, sample.name);
  } else if (parser === 'phase-marker') {
    frames = parsePhaseMarkedFrames(text, sample.name);
    if (frames.length < 2 && sample.kind === 'space') frames = parseSpaceFrames(sample.layoutText);
    if (frames.length < 2) frames = parseGenericFrames(text, sample.name);
  } else if (parser === 'numbered-table') {
    frames = parseNumberedTableFrames(text, sample.name);
    if (frames.length < 3) frames = parseGenericFrames(text, sample.name);
  } else if (sample.kind === 'space') {
    frames = parseSpaceFrames(sample.layoutText);
    if (frames.length < 2) frames = parseGenericFrames(text, sample.name);
  } else if (sample.kind === 'water') {
    frames = parseWaterFrames(sample.plainText);
  } else {
    frames = parseGenericFrames(text, sample.name);
  }
  var capped = capRuntimePhases(frames, { min: RUNTIME_PHASE_MIN, max: RUNTIME_PHASE_MAX });
  frames = capped.frames;
  frames = enrichFramesWithVisibleEntities(frames, sample.kind);
  diagnostics = diagnostics.concat(capped.diagnostics);
  var theme = themeForKind(sample.kind);
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
    minActionCoverage: kind === 'guard' ? 1 : 0.35,
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
  ['pdfinfo', 'pdftotext', 'pdftoppm', 'identify', 'convert'].forEach(function(cmd) {
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
    GUARD_HOME_VISUAL_FALLBACK_VERSION: GUARD_HOME_VISUAL_FALLBACK_VERSION,
    buildGuardVisualFallbackFrames: buildGuardVisualFallbackFrames,
    buildVisualOnlyFrames: buildVisualOnlyFrames,
    classifySample: classifySample,
    capRuntimePhases: capRuntimePhases,
    disambiguateFrameInteraction: disambiguateFrameInteraction,
    enrichFramesWithVisibleEntities: enrichFramesWithVisibleEntities,
    entitiesForKind: entitiesForKind,
    inferInteraction: inferInteraction,
    inferTargetId: inferTargetId,
    inferVisibleEntitiesForFrame: inferVisibleEntitiesForFrame,
    inferSampleProfile: inferSampleProfile,
    parseGenericFrames: parseGenericFrames,
    parseShelterWarmthFrames: parseShelterWarmthFrames,
    parseNumberedTableFrames: parseNumberedTableFrames,
    parsePhaseMarkedFrames: parsePhaseMarkedFrames,
    runtimePhaseCount: runtimePhaseCount,
    storyboardQualityDiagnostics: storyboardQualityDiagnostics,
    themeForKind: themeForKind,
    resourcesForKind: resourcesForKind,
  },
};
