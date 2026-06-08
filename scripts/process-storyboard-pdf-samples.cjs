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

function usage() {
  console.error('Usage: node scripts/process-storyboard-pdf-samples.cjs <pdf-dir> <out-dir>');
  process.exit(2);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
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

function inferInteraction(text, fallbackTitle) {
  var hay = String(text || '') + ' ' + String(fallbackTitle || '');
  if (/下载|跳转|下一关|结束/.test(hay)) return 'click:CtaButton';
  if (/建造|扩充|解锁|建成|打造/.test(hay)) return 'build:' + inferTargetId(hay, 'BuildTarget');
  if (/升级/.test(hay)) return 'upgrade:' + inferTargetId(hay, 'UpgradeTarget') + ':2';
  if (/攻击|击杀|打死|打掉|Boss|BOSS/.test(hay)) return 'attack:' + inferTargetId(hay, 'Enemy');
  if (/售卖|贩卖|换得|换取|金币|美金|收集|拾取|采集|采冰|捡|垃圾|冰晶|苹果|水|玉米/.test(hay)) {
    return 'collect:' + inferResourceId(hay) + ':1';
  }
  if (/引导|移动|回到|靠近|去/.test(hay)) return 'move_to:' + inferTargetId(hay, 'Target');
  return String(fallbackTitle || text || 'observe').slice(0, 80);
}

function inferResourceId(text) {
  if (/垃圾|金属|碎块/.test(text)) return 'Scrap';
  if (/冰晶|冰/.test(text)) return 'Ice';
  if (/桶装水|喝水|水/.test(text)) return 'Water';
  if (/苹果/.test(text)) return 'Apple';
  if (/玉米/.test(text)) return 'Corn';
  if (/金币|美金/.test(text)) return 'Coin';
  return 'Resource';
}

function inferTargetId(text, fallback) {
  if (/回收站|收购站|太空舱/.test(text)) return 'RecyclingCabin';
  if (/锻造/.test(text)) return 'ForgeWorkshop';
  if (/钻头/.test(text)) return 'Drill';
  if (/粉碎车/.test(text)) return 'CrusherCar';
  if (/液压车/.test(text)) return 'HydraulicCar';
  if (/房间|船舱|餐厅|宿舍/.test(text)) return 'NewCabin';
  if (/冰晶|冰/.test(text)) return 'IceChunk';
  if (/水箱|浇水|制氧/.test(text)) return 'WaterTank';
  if (/爆米花制作|制作机器|机器/.test(text)) return 'PopcornMachine';
  if (/售卖台|卖爆米花|售卖/.test(text)) return 'PopcornStand';
  if (/小人|帮手|助手/.test(text)) return 'HelperWorker';
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
  if (/敌|BOSS|Boss|怪/.test(text)) return 'Enemy';
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
  return [{ name: 'Player', label: '玩家', template: 'PlayerController' }, { name: 'CtaButton', label: '下载按钮', template: 'UI' }];
}

function themeForKind(kind) {
  return kind === 'water' || kind === 'space' || kind === 'guard' ? 'space' : 'default';
}

function resourcesForKind(kind) {
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

function classifySample(name, textChars) {
  if (/守护家园/.test(name) || textChars < 50) return 'guard';
  if (/太空捡垃圾/.test(name)) return 'space';
  if (/卖水|制作子弹/.test(name)) return 'water';
  return 'generic';
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
  if (sample.kind === 'space') {
    frames = parseSpaceFrames(sample.layoutText);
  } else if (sample.kind === 'water') {
    frames = parseWaterFrames(sample.plainText);
  } else if (sample.kind === 'guard') {
    sample.rowManifest = createRowCrops(sample.pdfPath, outDir, sample.kind);
    frames = buildGuardVisualFallbackFrames(sample.rowManifest);
    diagnostics.push({
      code: 'pdf_image_only_guard_template_fallback',
      severity: 'info',
      version: GUARD_HOME_VISUAL_FALLBACK_VERSION,
      rowCount: sample.rowManifest.rows.length,
    });
  } else {
    frames = parseWaterFrames(sample.plainText || sample.layoutText);
  }
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

function processPdf(pdfPath, outRoot) {
  var name = basenameNoExt(pdfPath);
  var outDir = path.join(outRoot, safeName(name));
  ensureDir(outDir);
  var info = parsePdfInfo(pdfPath);
  var plainText = textOfPdf(pdfPath, false);
  var layoutText = textOfPdf(pdfPath, true);
  var textChars = stripText(plainText).length;
  var compactHash = sha256(compactText(plainText));
  var kind = classifySample(name, textChars);
  var sample = {
    name: name,
    kind: kind,
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
  writeJson(path.join(outDir, 'spec-compile-report.json'), compiled);
  if (compiled.ok) {
    writeJson(path.join(outDir, 'specs.json'), compiled.specs);
    var sourceIr = storyboardSourceIrCompiler.compileSourceSceneIrFromStoryboard({
      projectName: name,
      themeHint: themeForKind(kind),
      entities: built.entities,
      resources: built.resources,
      specs: compiled.specs,
      storyboardIr: built.ir,
    }, {
      sourceHtmlPath: path.join(outDir, 'source-ir-preview.html'),
    });
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
    pdfPath: pdfPath,
    outDir: outDir,
    pages: Number(info.Pages || 0),
    textChars: textChars,
    textCompactSha256: compactHash,
    frameCount: built.ir.frames.length,
    specCompileOk: compiled.ok,
    specCount: compiled.specs.length,
    actionCoverage: compiled.summary.actionCoverage,
    diagnostics: built.ir.diagnostics.concat(compiled.diagnostics || []),
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
    entitiesForKind: entitiesForKind,
    themeForKind: themeForKind,
    resourcesForKind: resourcesForKind,
  },
};
