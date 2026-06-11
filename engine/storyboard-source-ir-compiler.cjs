'use strict';

var sourceSceneIr = require('./source-scene-ir.cjs');
var storyboardIrMod = require('./storyboard-ir.cjs');
var storyboardSpecCompiler = require('./storyboard-spec-compiler.cjs');

var UNRESOLVED_SEMANTIC_WAIT_SECONDS = 999999;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function uniqueStrings(values) {
  var seen = {};
  var out = [];
  safeArray(values).forEach(function(value) {
    var text = stringValue(value);
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });
  return out;
}

function isCtaId(value) {
  return /cta|install|download|下载|安装|按钮/i.test(stringValue(value));
}

function isPlayerId(value, entity) {
  var id = stringValue(value);
  var label = stringValue(entity && (entity.label || entity.chineseName || entity.name));
  var kind = stringValue(entity && (entity.kind || entity.type || entity.template));
  var compactId = id.replace(/[\s_-]+/g, '').toLowerCase();
  var compactKind = kind.replace(/[\s_-]+/g, '').toLowerCase();
  if (/^(player|playerrobot|playerchar|mainplayer|maincharacter|mainchar|protagonist|avatar|hero|mainhero)$/.test(compactId)) return true;
  if (/^(player|playercontroller|playercharacter|hero|mainhero|avatar)$/.test(compactKind)) return true;
  if (/^(玩家|主角|角色|主人公)$/.test(label)) return true;
  if (/(玩家|主角|可控角色)/.test(label) && !/(塔|炮塔|基地|按钮|敌|怪|建筑)/.test(label)) return true;
  return /(^|[\s_-])player($|[\s_-])/i.test(id);
}

function roundCoord(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function layoutPositionForEntity(entity, ordinal, kind) {
  if (isPlayerId(entity && entity.id, entity) || kind === 'player') return [0, 0, 0];
  if (isCtaId(entity && entity.id) || kind === 'cta') return [15, 0, -12];
  var slotsPerRing = 8;
  var ring = Math.floor(Math.max(0, ordinal) / slotsPerRing);
  var slot = Math.max(0, ordinal) % slotsPerRing;
  var angle = (-Math.PI * 0.72) + (slot * Math.PI * 2 / slotsPerRing) + (ring * 0.27);
  var radius = 6.8 + ring * 3.0 + (slot % 2) * 0.65;
  return [roundCoord(Math.cos(angle) * radius), 0, roundCoord(Math.sin(angle) * radius)];
}

function entityLayoutBounds(entities) {
  var bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, maxAbs: 0 };
  safeArray(entities).forEach(function(entity) {
    var p = safeArray(entity && entity.position);
    var x = Number(p[0]) || 0;
    var z = Number(p[2]) || 0;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxZ = Math.max(bounds.maxZ, z);
    bounds.maxAbs = Math.max(bounds.maxAbs, Math.abs(x), Math.abs(z));
  });
  bounds.width = bounds.maxX - bounds.minX;
  bounds.depth = bounds.maxZ - bounds.minZ;
  return bounds;
}

function sceneLayoutForEntities(entities) {
  var bounds = entityLayoutBounds(entities);
  var needed = Math.max(bounds.width + 10, bounds.depth + 10, (bounds.maxAbs + 6) * 2, 42);
  var mapSize = Math.min(72, Math.ceil(needed / 2) * 2);
  return {
    mapSize: mapSize,
    camera: {
      position: [0, roundCoord(Math.max(16, mapSize * 0.42)), roundCoord(Math.max(24, mapSize * 0.58))],
      lookAt: [0, 0, 0],
      fov: 58,
    },
    bounds: bounds,
  };
}

function normalizeEntityId(value, fallback) {
  var text = stringValue(value || fallback).replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  if (!text && fallback === '') return '';
  if (!text) text = fallback || 'Entity';
  if (!/^[A-Za-z_]/.test(text)) text = 'Entity_' + text;
  return text;
}

function splitInteraction(value) {
  return stringValue(value).split(':').map(function(part) { return part.trim(); });
}

function collectRequiredEntityRefs(specs) {
  var refs = [];
  safeArray(specs).forEach(function(spec) {
    safeArray(spec && spec.entitiesRequired).forEach(function(entity) {
      refs.push(typeof entity === 'string' ? entity : entity && entity.name);
    });
    safeArray(spec && spec.requiredInteractions).forEach(function(item) {
      var parts = splitInteraction(item);
      var verb = parts[0];
      if (['move_to', 'click', 'build', 'upgrade', 'attack', 'show'].indexOf(verb) >= 0) refs.push(parts[1]);
      if (verb === 'select' || verb === 'unlock') refs.push(parts[1]);
      if (verb === 'deliver' || verb === 'transfer' || verb === 'combine') refs.push(parts[2]);
    });
  });
  return uniqueStrings(refs);
}

function resourceAliasWords(resourceId) {
  var text = stringValue(resourceId).toLowerCase();
  var aliases = [text];
  if (/scrap|junk|debris|trash|garbage/.test(text)) aliases = aliases.concat(['scrap', 'junk', 'debris', 'trash', 'garbage', 'metal', 'spacejunk', '垃圾', '金属', '碎块']);
  if (/ice/.test(text)) aliases = aliases.concat(['ice', 'crystal', 'icechunk', '冰晶', '冰']);
  if (/water/.test(text)) aliases = aliases.concat(['water', 'bucket', 'bottle', '水', '水桶', '桶装水']);
  if (/apple/.test(text)) aliases = aliases.concat(['apple', '苹果']);
  if (/corn/.test(text)) aliases = aliases.concat(['corn', 'field', '玉米', '玉米地']);
  if (/coin|gold|money/.test(text)) aliases = aliases.concat(['coin', 'gold', 'money', '金币', '美金']);
  return uniqueStrings(aliases);
}

function inferResourceCarrierEntity(resourceId, entities) {
  var aliases = resourceAliasWords(resourceId);
  var best = null;
  function scoreEntity(entity, index) {
    if (!entity) return 0;
    var id = stringValue(entity.id || entity.name);
    if (!id || isCtaId(id) || isPlayerId(id, entity)) return 0;
    var hay = [
      id,
      entity.label,
      entity.chineseName,
      entity.kind,
      entity.type,
      entity.template,
    ].map(stringValue).join(' ').toLowerCase();
    var score = 100 - index;
    aliases.forEach(function(alias) {
      var key = stringValue(alias).toLowerCase();
      if (!key) return;
      if (hay === key || id.toLowerCase() === key) score += 1000;
      else if (hay.indexOf(key) >= 0 || key.indexOf(id.toLowerCase()) >= 0) score += 500;
    });
    if (/collect|resource|pickup|loot|drop/.test(hay)) score += 250;
    if (/build|upgrade|workshop|room|cabin|station|button|ui/.test(hay)) score -= 180;
    return score;
  }
  safeArray(entities).forEach(function(entity, index) {
    var score = scoreEntity(entity, index);
    if (score <= 0 || best && best.score >= score) return;
    best = { entity: entity, score: score };
  });
  return best && best.score >= 300 ? normalizeEntityId(best.entity.id || best.entity.name, '') : '';
}

function collectResourceSpecs(input, specs) {
  var resources = [];
  safeArray(input.resources).forEach(function(resource) {
    if (typeof resource === 'string') resources.push({ id: resource, label: resource, carrierEntity: inferResourceCarrierEntity(resource, input.entities) || normalizeEntityId(resource, 'Resource') });
    else if (resource) resources.push({
      id: resource.id || resource.name,
      label: resource.label || resource.name || resource.id,
      carrierEntity: resource.carrierEntity || resource.entity || inferResourceCarrierEntity(resource.id || resource.name, input.entities) || normalizeEntityId(resource.id || resource.name, 'Resource'),
      kind: resource.kind || 'resource',
      initial: resource.initial || 0,
    });
  });
  safeArray(specs).forEach(function(spec) {
    safeArray(spec.requiredInteractions).forEach(function(item) {
      var parts = splitInteraction(item);
      if (parts[0] !== 'collect' || !parts[1]) return;
      resources.push({ id: parts[1], label: parts[1], carrierEntity: inferResourceCarrierEntity(parts[1], input.entities) || normalizeEntityId(parts[1], 'Resource'), kind: 'resource', initial: 0 });
    });
    safeArray(spec.entitiesRequired).forEach(function(entity) {
      if (entity && entity.resource) {
        resources.push({ id: entity.resource, label: entity.resource, carrierEntity: entity.name || null, kind: 'resource', initial: 0 });
      }
    });
  });
  var seen = {};
  return resources.filter(function(resource) {
    resource.id = normalizeEntityId(resource.id, 'Resource');
    if (resource.carrierEntity) resource.carrierEntity = normalizeEntityId(resource.carrierEntity, resource.id);
    if (!resource.id || seen[resource.id]) return false;
    seen[resource.id] = true;
    return true;
  });
}

function compileEntities(input, specs, resources) {
  var base = [];
  safeArray(input.entities).forEach(function(entity) {
    if (!entity) return;
    var id = normalizeEntityId(entity.id || entity.name, 'Entity' + (base.length + 1));
    base.push({
      id: id,
      label: entity.label || entity.chineseName || entity.name || id,
      kind: entity.kind || entity.type || null,
      visual: entity.visual || null,
      template: entity.template || '',
    });
  });
  collectRequiredEntityRefs(specs).forEach(function(ref) {
    if (!ref) return;
    var id = normalizeEntityId(ref, 'Entity' + (base.length + 1));
    if (!base.some(function(entity) { return entity.id === id; })) {
      base.push({ id: id, label: ref, kind: null, visual: null, template: '' });
    }
  });
  safeArray(resources).forEach(function(resource) {
    if (!resource || !resource.carrierEntity) return;
    var id = normalizeEntityId(resource.carrierEntity, resource.id || 'Resource');
    if (!base.some(function(entity) { return entity.id === id; })) {
      base.push({
        id: id,
        label: resource.label || resource.id || id,
        kind: 'resource',
        visual: { primitive: 'box', color: '#ffd34d' },
        template: 'Collectible',
      });
    }
  });
  if (!base.some(function(entity) { return isPlayerId(entity.id, entity); })) {
    base.unshift({ id: 'Player', label: 'Player', kind: 'player', visual: { primitive: 'capsule', color: '#66ccff' }, template: 'PlayerController' });
  }
  if (!base.some(function(entity) { return isCtaId(entity.id); })) {
    base.push({ id: 'CtaButton', label: 'Install', kind: 'cta', visual: { primitive: 'box', color: '#25d67b' }, template: 'UI' });
  }
  var resourceCarriers = {};
  safeArray(resources).forEach(function(resource) {
    if (resource.carrierEntity) resourceCarriers[resource.carrierEntity] = true;
  });
  var layoutOrdinal = 0;
  var positioned = base.map(function(entity) {
    var kind = entity.kind;
    if (!kind) {
      if (isPlayerId(entity.id, entity)) kind = 'player';
      else if (isCtaId(entity.id)) kind = 'cta';
      else if (resourceCarriers[entity.id] || /resource|coin|gem|gold|wood|corn|ice|水|金币|木|玉米/.test(entity.id + ' ' + entity.label)) kind = 'resource';
      else if (/enemy|monster|怪|敌/.test(entity.id + ' ' + entity.label)) kind = 'enemy';
      else kind = 'prop';
    }
    var isAnchored = isPlayerId(entity.id, entity) || isCtaId(entity.id);
    var position = layoutPositionForEntity(entity, layoutOrdinal, kind);
    if (!isAnchored) layoutOrdinal += 1;
    var fallbackVisual = { primitive: kind === 'resource' ? 'sphere' : (kind === 'player' ? 'capsule' : 'box'), color: kind === 'enemy' ? '#e85d75' : (kind === 'resource' ? '#ffd34d' : '#5db7ff') };
    return {
      id: entity.id,
      label: entity.label || entity.id,
      kind: kind,
      position: position,
      visual: entity.visual || fallbackVisual,
    };
  });
  return positioned;
}

function interactionSteps(item, resources, isFinal) {
  var parts = splitInteraction(item);
  var verb = parts[0] || '';
  var target = normalizeEntityId(parts[1], '');
  var amount = Number(parts[2] || 1) || 1;
  var resourceSpec = resources.filter(function(r) { return r.id === target; })[0] || null;
  var resource = resourceSpec ? target : '';
  if (verb === 'move_to' && target) return [{ kind: 'move_to', target: target, radius: 1.6 }];
  if (verb === 'click' && target) {
    if (isFinal) return [{ kind: 'cta_finish', ctaId: isCtaId(target) ? target : 'CtaButton' }];
    if (isCtaId(target)) return [{ kind: 'wait', seconds: 1 }];
    return [{ kind: 'move_to', target: target, radius: 1.6 }];
  }
  if (verb === 'collect' && target) {
    var carrier = resourceSpec && resourceSpec.carrierEntity || '';
    return carrier
      ? [{ kind: 'move_to', target: carrier, radius: 1.6 }, { kind: 'collect', resource: target, amount: amount, target: carrier, from: carrier }]
      : [{ kind: 'collect', resource: target, amount: amount }];
  }
  if (verb === 'deliver' || verb === 'transfer') {
    var deliverResource = target;
    var deliverTarget = normalizeEntityId(parts[2], 'Target');
    var deliverAmount = Number(parts[3] || 1) || 1;
    return [{ kind: 'move_to', target: deliverTarget, radius: 1.8 }, { kind: verb, resource: deliverResource, amount: deliverAmount, target: deliverTarget, to: deliverTarget }];
  }
  if (verb === 'select' && target) return [{ kind: 'move_to', target: target, radius: 1.5 }, { kind: 'select', target: target }];
  if (verb === 'combine') {
    var combineTarget = normalizeEntityId(parts[2], 'UpgradePoint');
    var combineAmount = Number(parts[3] || 1) || 1;
    return [{ kind: 'move_to', target: combineTarget, radius: 1.8 }, { kind: 'combine', resource: target, target: combineTarget, entity: combineTarget, amount: combineAmount, state: 2 }];
  }
  if (verb === 'produce' && target) return [{ kind: 'produce', resource: target, amount: amount, target: resourceSpec && resourceSpec.carrierEntity || 'Producer' }];
  if (verb === 'reward' && target) return [{ kind: 'reward', resource: target, amount: amount, target: resourceSpec && resourceSpec.carrierEntity || 'Reward' }];
  if (verb === 'unlock' && target) return [{ kind: 'move_to', target: target, radius: 1.8 }, { kind: 'unlock', entity: target, target: target, state: 1 }];
  if (verb === 'show' && target) return [{ kind: 'show', entity: target, target: target, state: 1 }];
  if (verb === 'build' && target) return [{ kind: 'move_to', target: target, radius: 1.8 }, { kind: 'build', entity: target, state: 2 }];
  if (verb === 'upgrade' && target) return [{ kind: 'move_to', target: target, radius: 1.8 }, { kind: 'upgrade', entity: target, level: amount }];
  if (verb === 'attack' && target) return [{ kind: 'move_to', target: target, radius: 2.2 }, { kind: 'attack', target: target, state: 0 }];
  if (verb === 'wait') return [{ kind: 'wait', seconds: amount }];
  return [];
}

function stepRefs(step) {
  if (!step || step.kind === 'cta_finish') return [];
  return [step.target, step.from, step.to, step.entity].filter(Boolean);
}

function phaseFallbackTarget(spec) {
  var refs = [];
  safeArray(spec && spec.visibleEntities).forEach(function(name) { refs.push(name); });
  safeArray(spec && spec.phaseEntities).forEach(function(name) { refs.push(name); });
  safeArray(spec && spec.entitiesRequired).forEach(function(entity) {
    refs.push(typeof entity === 'string' ? entity : entity && entity.name);
  });
  safeArray(spec && spec.requiredInteractions).forEach(function(item) {
    var parts = splitInteraction(item);
    if (parts[0] !== 'wait' && parts[1]) refs.push(parts[1]);
  });
  return uniqueStrings(refs).filter(function(ref) {
    return ref && !isPlayerId(ref, { id: ref }) && !isCtaId(ref);
  })[0] || '';
}

function fallbackManualStepForSpec(spec) {
  var target = normalizeEntityId(phaseFallbackTarget(spec), '');
  return target ? { kind: 'move_to', target: target, radius: 1.8, fallback: 'storyboard-visible-entity' } : null;
}

function unresolvedSemanticBlockStepForSpec() {
  return { kind: 'wait', seconds: UNRESOLVED_SEMANTIC_WAIT_SECONDS, fallback: 'storyboard-unresolved-semantic-block' };
}

function interactionStepsForSpec(spec, resources, isFinal) {
  var steps = [];
  safeArray(spec && spec.requiredInteractions).forEach(function(item) {
    steps = steps.concat(interactionSteps(item, resources, isFinal));
  });
  return steps;
}

function phaseSemanticText(spec) {
  return [
    spec && spec.playerInstruction,
    spec && spec.guideText,
    spec && spec.autoModeHint,
    spec && spec.phaseName,
    spec && spec.title,
  ].map(stringValue).filter(Boolean)[0] || '';
}

function labelIndexFromLists(resources, entities) {
  var labels = {};
  safeArray(resources).forEach(function(resource) {
    var id = normalizeEntityId(resource && (resource.id || resource.name), '');
    if (id) labels[id] = stringValue(resource.label || resource.name || resource.id) || id;
    var carrier = normalizeEntityId(resource && resource.carrierEntity, '');
    if (carrier && !labels[carrier]) labels[carrier] = labels[id] || carrier;
  });
  safeArray(entities).forEach(function(entity) {
    var id = normalizeEntityId(entity && (entity.id || entity.name), '');
    if (id) labels[id] = stringValue(entity.label || entity.chineseName || entity.name || entity.id) || id;
  });
  return labels;
}

function basePhaseTargetId(id) {
  return stringValue(id).replace(/__phase\d+_target$/i, '');
}

function humanLabelForId(id, labels, fallback) {
  var text = stringValue(id);
  if (!text) return fallback || '目标';
  var direct = stringValue(labels && labels[text]);
  var base = basePhaseTargetId(text);
  var baseLabel = stringValue(labels && labels[base]);
  var label = direct || baseLabel || fallback || text;
  label = label.replace(/\s*P\d+\s+target\s*$/i, '').trim();
  if (!label || /^Item$/i.test(label)) return '物品';
  if (/^Target$/i.test(label)) return '目标';
  if (/^Consumer$/i.test(label)) return '顾客';
  if (/^Producer$/i.test(label)) return '生产点';
  if (/^UpgradePoint$/i.test(label)) return '升级点';
  if (/^Reward$/i.test(label)) return '奖励';
  if (/^CtaButton$/i.test(label)) return '下载按钮';
  return label;
}

function firstStepOfKind(steps, kinds) {
  kinds = safeArray(kinds);
  for (var i = 0; i < safeArray(steps).length; i += 1) {
    var step = steps[i];
    if (step && kinds.indexOf(step.kind) >= 0) return step;
  }
  return null;
}

function uniqueActionKinds(steps) {
  return uniqueStrings(safeArray(steps).map(function(step) {
    return step && step.kind;
  }).filter(function(kind) {
    return kind && kind !== 'move_to' && kind !== 'wait';
  }));
}

function actionKindLabel(kind) {
  return {
    select: '选中',
    combine: '合成',
    unlock: '解锁',
    produce: '产出',
    collect: '收集',
    deliver: '送达',
    transfer: '放入',
    upgrade: '升级',
    build: '建造',
    show: '查看提示',
    reward: '领取奖励',
    attack: '消灭目标',
    cta_finish: '下载',
  }[kind] || '';
}

function joinedActionKindLabels(kinds) {
  var labels = safeArray(kinds).map(actionKindLabel).filter(Boolean);
  if (labels.length <= 1) return labels[0] || '';
  if (labels.length === 2) return labels[0] + '和' + labels[1];
  return labels.slice(0, -1).join('、') + '和' + labels[labels.length - 1];
}

function compactGuideText(text) {
  var out = stringValue(text).replace(/\s+/g, '');
  if (!out) return '';
  if (!/[。！？]$/.test(out)) out += '。';
  if (out.length <= 58) return out;
  return out.slice(0, 57).replace(/[，、：；:;]$/g, '') + '。';
}

function showGuideTextForSpec(spec, step, labels, phaseIndex, isContinuation) {
  var semanticText = phaseSemanticText(spec);
  var target = humanLabelForId(step && (step.target || step.entity), labels, '目标');
  if (/第一个符合订单|符合订单|配菜出现|所需配菜/.test(semanticText)) {
    return compactGuideText('看到符合订单的配菜出现时，按订单选择它');
  }
  if (/订单|小票/.test(semanticText)) {
    return compactGuideText('查看订单小票，确认当前订单需要什么');
  }
  if (/剩余|金额|资金|价格|资产/.test(semanticText)) {
    return compactGuideText('查看剩余金额，确认还差多少才能解锁');
  }
  if (/倒计时|计时|圆环|超时/.test(semanticText)) {
    return compactGuideText('查看倒计时提示，尽快完成当前目标');
  }
  if (/发光|闪烁/.test(semanticText) && /摇摆|镜头|拉远|转场|播放/.test(semanticText)) {
    return compactGuideText('观察目标发光和镜头变化，准备进入下一步');
  }
  if (/发光|闪烁/.test(semanticText)) {
    return compactGuideText('观察目标发光提示，准备继续下一步');
  }
  if (/摇摆|镜头|拉远|转场|播放/.test(semanticText)) {
    return compactGuideText('看完这段镜头表现，准备进入下一步');
  }
  if (/画面|呈现|场景|整体|背景/.test(semanticText)) {
    return compactGuideText('观察当前场景，确认接下来要处理的目标');
  }
  if (/显示|展示|出现|高亮/.test(semanticText)) {
    return compactGuideText('查看' + target + '的提示，确认它已经出现');
  }
  if (isContinuation) {
    return compactGuideText('第' + (phaseIndex + 1) + '步：继续查看' + target + '提示');
  }
  return compactGuideText('查看' + target + '提示，确认这一步已出现');
}

function plainGuideTextForSpec(spec, steps, resources, entities, isFinal, phaseIndex) {
  var labels = labelIndexFromLists(resources, entities);
  var semanticText = phaseSemanticText(spec);
  var actions = uniqueActionKinds(steps);
  function label(id, fallback) {
    return humanLabelForId(id, labels, fallback);
  }
  function resourceLabel(step, fallback) {
    return label(step && step.resource || step && step.target, fallback || '物品');
  }
  function targetLabel(step, fallback) {
    return label(step && (step.target || step.to || step.entity || step.from), fallback || '目标');
  }
  function producerLabel(step) {
    var current = targetLabel(step, '生产点');
    var resource = resourceLabel(step);
    return current === resource ? label('Producer', '生产点') : current;
  }
  if (isFinal || actions.indexOf('cta_finish') >= 0) {
    return compactGuideText('本关完成，点击下载按钮继续体验完整游戏');
  }
  if (/错误|点错|红叉|扣除|惩罚/.test(semanticText)) {
    return compactGuideText('避开错误' + label('Item', '物品') + '，只选订单里真正需要的内容');
  }
  if (/倒计时|计时|圆环|超时/.test(semanticText)) {
    return compactGuideText('注意倒计时，尽快按当前目标完成操作');
  }
  if (actions.length >= 3) {
    var selectStep = firstStepOfKind(steps, ['select']);
    var combineStep = firstStepOfKind(steps, ['combine']);
    var unlockStep = firstStepOfKind(steps, ['unlock']);
    var produceStep = firstStepOfKind(steps, ['produce']);
    var collectStep = firstStepOfKind(steps, ['collect']);
    if (selectStep && combineStep && unlockStep && produceStep && collectStep) {
      return compactGuideText('先选中' + targetLabel(selectStep, '物品') + '，再合成升级，解锁' + targetLabel(unlockStep) + '后收集产出的' + resourceLabel(collectStep));
    }
    return compactGuideText('依次完成' + joinedActionKindLabels(actions));
  }
  var step = firstStepOfKind(steps, ['deliver']);
  if (step) return compactGuideText('把' + resourceLabel(step) + '送到' + targetLabel(step, '顾客') + '处，完成订单');
  step = firstStepOfKind(steps, ['transfer']);
  if (step) return compactGuideText('把' + resourceLabel(step) + '放到' + targetLabel(step) + '处，完成这一步');
  step = firstStepOfKind(steps, ['select']);
  if (step) return compactGuideText('移动到' + targetLabel(step, '物品') + '旁，选中订单需要的' + targetLabel(step, '内容'));
  step = firstStepOfKind(steps, ['combine']);
  if (step) return compactGuideText('把两个' + resourceLabel(step) + '合在一起，升成更高级的' + resourceLabel(step));
  step = firstStepOfKind(steps, ['collect']);
  if (step) return compactGuideText('移动到' + targetLabel(step, resourceLabel(step)) + '旁，收集' + resourceLabel(step));
  step = firstStepOfKind(steps, ['produce']);
  if (step) return compactGuideText('观察' + producerLabel(step) + '自动产出' + resourceLabel(step));
  step = firstStepOfKind(steps, ['reward']);
  if (step) return compactGuideText('完成这一步后领取' + resourceLabel(step, '奖励') + '，让计数增加');
  step = firstStepOfKind(steps, ['unlock']);
  if (step) return compactGuideText('移动到' + targetLabel(step) + '，解锁新的区域或功能');
  step = firstStepOfKind(steps, ['upgrade']);
  if (step) return compactGuideText('移动到' + targetLabel(step, '升级点') + '，把它升级到下一档');
  step = firstStepOfKind(steps, ['build']);
  if (step) return compactGuideText('移动到' + targetLabel(step) + '，把建筑修好');
  step = firstStepOfKind(steps, ['attack']);
  if (step) return compactGuideText('移动到' + targetLabel(step) + '旁，消灭它');
  step = firstStepOfKind(steps, ['show']);
  if (step) return showGuideTextForSpec(spec, step, labels, phaseIndex, false);
  step = firstStepOfKind(steps, ['move_to']);
  if (step) return compactGuideText('拖动摇杆，移动到' + targetLabel(step) + '旁');
  if (safeArray(steps).some(function(item) { return item && item.kind === 'wait'; })) {
    return compactGuideText('稍等一下，看完这段演示后继续');
  }
  return compactGuideText(semanticText || ('第' + (phaseIndex + 1) + '步，按提示继续'));
}

function continuationGuideText(guide, phaseIndex, steps, resources, entities, spec) {
  var labels = labelIndexFromLists(resources, entities);
  var step = firstStepOfKind(steps, ['combine', 'deliver', 'transfer', 'select', 'collect', 'produce', 'unlock', 'upgrade', 'build', 'reward', 'show', 'attack']);
  var label = step ? humanLabelForId(step.resource || step.target || step.to || step.entity || step.from, labels, '目标') : '目标';
  if (step && step.kind === 'combine') return compactGuideText('第' + (phaseIndex + 1) + '步：继续合成更高级的' + label);
  if (step && step.kind === 'transfer') return compactGuideText('第' + (phaseIndex + 1) + '步：继续把' + label + '放到目标处');
  if (step && step.kind === 'deliver') return compactGuideText('第' + (phaseIndex + 1) + '步：继续把' + label + '送到顾客处');
  if (step && step.kind === 'select') return compactGuideText('第' + (phaseIndex + 1) + '步：继续按订单选择正确内容');
  if (step && step.kind === 'produce') return compactGuideText('第' + (phaseIndex + 1) + '步：继续观察自动产出' + label);
  if (step && step.kind === 'unlock') return compactGuideText('第' + (phaseIndex + 1) + '步：继续解锁新的区域或功能');
  if (step && step.kind === 'upgrade') return compactGuideText('第' + (phaseIndex + 1) + '步：继续升级当前目标');
  if (step && step.kind === 'build') return compactGuideText('第' + (phaseIndex + 1) + '步：继续把建筑修好');
  if (step && step.kind === 'collect') return compactGuideText('第' + (phaseIndex + 1) + '步：继续收集' + label);
  if (step && step.kind === 'reward') return compactGuideText('第' + (phaseIndex + 1) + '步：看奖励或计数继续增加');
  if (step && step.kind === 'show') return showGuideTextForSpec(spec || {}, step, labels, phaseIndex, true);
  if (step && step.kind === 'attack') return compactGuideText('第' + (phaseIndex + 1) + '步：继续消灭当前目标');
  return compactGuideText('第' + (phaseIndex + 1) + '步：继续按提示处理当前目标');
}

function semanticFallbackDiagnosticForSpec(spec, index, phaseCount, resources) {
  var isFinal = index === phaseCount - 1;
  if (isFinal) return null;
  if (interactionStepsForSpec(spec, resources, isFinal).length > 0) return null;
  var fallbackTarget = normalizeEntityId(phaseFallbackTarget(spec), '');
  var base = {
    phaseId: spec && spec.phaseId || ('phase' + (index + 1)),
    phaseIndex: index + 1,
    phaseName: spec && (spec.phaseName || spec.title) || ('phase' + (index + 1)),
    requiredInteractions: safeArray(spec && spec.requiredInteractions),
    visibleEntities: safeArray(spec && spec.visibleEntities),
    semanticText: phaseSemanticText(spec),
    ruleAction: 'add_or_adjust_storyboard_semantic_rule',
  };
  if (fallbackTarget) {
    return Object.assign(base, {
      code: 'storyboard_semantic_fallback_visible_entity',
      severity: 'warning',
      fallbackTarget: fallbackTarget,
      fallbackInteraction: 'move_to:' + fallbackTarget,
      message: 'No canonical storyboard action was parsed; SourceIR used a visible entity as a manual movement gate and queued this phrase for rule expansion.',
    });
  }
  return Object.assign(base, {
    code: 'storyboard_semantic_unresolved_no_target',
    severity: 'error',
    blocking: true,
    fallbackInteraction: 'wait:' + UNRESOLVED_SEMANTIC_WAIT_SECONDS,
    message: 'No canonical storyboard action or usable visible target was parsed; SourceIR emitted a long blocking wait instead of a short auto-advance timer.',
  });
}

function semanticFallbackDiagnosticsForSpecs(specs, resources) {
  var list = [];
  safeArray(specs).forEach(function(spec, index, allSpecs) {
    var diagnostic = semanticFallbackDiagnosticForSpec(spec, index, allSpecs.length, resources);
    if (diagnostic) list.push(diagnostic);
  });
  return list;
}

function gateFromSpec(spec, steps, resources, isFinal) {
  var interactions = safeArray(spec.requiredInteractions);
  var nonCtaInteractions = interactions.filter(function(item) {
    var parts = splitInteraction(item);
    return !(parts[0] === 'click' && isCtaId(parts[1]));
  });
  var lastInteraction = (isFinal ? interactions : nonCtaInteractions).slice(-1)[0] || '';
  var parts = splitInteraction(lastInteraction);
  var verb = parts[0] || '';
  var target = normalizeEntityId(parts[1], '');
  var amount = Number(parts[2] || 1) || 1;
  if (isFinal) return { kind: 'cta_arrival', ctaId: target && isCtaId(target) ? target : 'CtaButton' };
  if (verb === 'collect' && target) return { kind: 'resource', resource: target, threshold: amount };
  if (verb === 'deliver' || verb === 'transfer') return { kind: 'near_entity', entity: normalizeEntityId(parts[2], 'Target'), radius: 1.8 };
  if (verb === 'select') return { kind: 'near_entity', entity: target, radius: 1.5 };
  if (verb === 'combine') return { kind: 'entity_state', entity: normalizeEntityId(parts[2], 'UpgradePoint'), state: 2 };
  if (verb === 'produce' || verb === 'reward') return { kind: 'resource', resource: target, threshold: amount };
  if (verb === 'unlock' && target) return { kind: 'entity_state', entity: target, state: 1 };
  if (verb === 'show' && target) return { kind: 'entity_state', entity: target, state: 1 };
  if ((verb === 'build' || verb === 'upgrade') && target) return { kind: 'entity_state', entity: target, state: verb === 'upgrade' ? amount : 2 };
  if (verb === 'attack' && target) return { kind: 'entity_state', entity: target, state: 0 };
  if (verb === 'wait') return { kind: 'timer', seconds: amount };
  if (safeArray(steps).some(function(step) { return step && step.fallback === 'storyboard-unresolved-semantic-block'; })) {
    return { kind: 'timer', seconds: UNRESOLVED_SEMANTIC_WAIT_SECONDS };
  }
  var move = safeArray(steps).filter(function(step) { return step.target || step.entity; })[0];
  if (move) return { kind: 'near_entity', entity: move.target || move.entity, radius: move.radius || 1.8 };
  target = normalizeEntityId(phaseFallbackTarget(spec), '');
  if (target) return { kind: 'near_entity', entity: target, radius: 1.8 };
  return { kind: 'timer', seconds: 1 };
}

function moduleHintsForSpec(spec, isFinal) {
  var modules = ['guide_ui', 'visual_binding'];
  safeArray(spec.requiredInteractions).forEach(function(item) {
    var verb = splitInteraction(item)[0];
    if (['move_to', 'collect', 'build', 'upgrade', 'attack'].indexOf(verb) >= 0) {
      modules.push('player_input_joystick', 'move_to_target', 'proximity_trigger');
    }
    if (['deliver', 'transfer', 'select', 'combine', 'unlock'].indexOf(verb) >= 0) {
      modules.push('player_input_joystick', 'move_to_target', 'proximity_trigger');
    }
    if (verb === 'collect') modules.push('collect_on_near', 'inventory_wallet');
    if (verb === 'produce' || verb === 'reward') modules.push('inventory_wallet');
    if (verb === 'deliver' || verb === 'transfer') modules.push('inventory_wallet');
    if (verb === 'select') modules.push('player_input_tap');
    if (verb === 'combine') modules.push('upgrade_progress');
    if (verb === 'unlock') modules.push('build_progress');
    if (verb === 'show') modules.push('spawn_once');
    if (verb === 'build') modules.push('build_progress');
    if (verb === 'upgrade') modules.push('upgrade_progress');
    if (verb === 'attack') modules.push('target_acquire', 'damageable', 'apply_damage');
    if (verb === 'click') modules.push(isFinal ? 'cta_finish' : 'player_input_tap');
  });
  if (!isFinal && !safeArray(spec && spec.requiredInteractions).length && phaseFallbackTarget(spec)) {
    modules.push('player_input_joystick', 'move_to_target', 'proximity_trigger');
  }
  if (isFinal) modules.push('cta_finish');
  return uniqueStrings(modules);
}

function compilePhases(specs, resources, entities) {
  var usedGuideTexts = {};
  return safeArray(specs).map(function(spec, index) {
    var isFinal = index === specs.length - 1;
    var steps = interactionStepsForSpec(spec, resources, isFinal);
    if (!steps.length) {
      var fallbackStep = !isFinal ? fallbackManualStepForSpec(spec) : null;
      steps = fallbackStep ? [fallbackStep] : [unresolvedSemanticBlockStepForSpec()];
    }
    var refs = ['Player'];
    refs = refs.concat(safeArray(spec.visibleEntities));
    refs = refs.concat(safeArray(spec.phaseEntities));
    steps.forEach(function(step) {
      refs = refs.concat(stepRefs(step));
      if (step.kind === 'collect') {
        var carrier = resources.filter(function(resource) { return resource.id === step.resource; })[0];
        if (carrier && carrier.carrierEntity) {
          step.from = carrier.carrierEntity;
          refs.push(carrier.carrierEntity);
        }
      }
    });
    if (isFinal) refs.push('CtaButton');
    var guideText = plainGuideTextForSpec(spec, steps, resources, entities, isFinal, index);
    if (usedGuideTexts[guideText]) {
      guideText = continuationGuideText(guideText, index, steps, resources, entities, spec);
    }
    usedGuideTexts[guideText] = true;
    return {
      id: spec.phaseId || ('phase' + (index + 1)),
      title: spec.phaseName || spec.title || ('phase' + (index + 1)),
      guideText: guideText,
      showEntities: uniqueStrings(refs),
      plannedModuleIds: moduleHintsForSpec(spec, isFinal),
      steps: steps,
      gate: gateFromSpec(spec, steps, resources, isFinal),
      duration: spec.duration || { min: 10, max: 15 },
    };
  });
}

function defaultDomHudContract(resources, phaseCount) {
  var resourceLabel = safeArray(resources).map(function(resource) {
    return (resource.label || resource.id) + ': ' + Number(resource.initial || 0);
  }).join('   ');
  return {
    present: true,
    ids: {
      tip: 'tip',
      targetHint: 'targetHint',
      goldBox: 'resourceBar',
      phaseBadge: 'phaseLabel',
      joystick: 'joystick',
      stickThumb: 'joystick-knob',
      victory: 'source-ir-cta-overlay',
      victoryTitle: 'source-ir-cta-title',
      ctaDom: 'source-ir-cta-btn',
    },
    initialText: {
      tip: '',
      targetHint: '',
      goldBox: resourceLabel || 'Resource: 0',
      phaseBadge: 'Phase 1/' + Math.max(1, Number(phaseCount) || 1),
      ctaDom: '安装完整游戏',
      victory: '立即下载，解锁更多内容！',
    },
    css: {
      tip: 'position:absolute;top:16px;left:50%;transform:translateX(-50%);max-width:min(760px,88vw);padding:10px 16px;border-radius:8px;background:rgba(5,16,28,.72);z-index:20;color:#fff;font:700 18px/1.35 system-ui,sans-serif;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,.25)',
      targetHint: 'position:absolute;left:50%;bottom:18px;transform:translateX(-50%);padding:8px 14px;border-radius:6px;background:rgba(5,16,28,.72);z-index:20;color:#ffe45c;font:700 15px/1.3 system-ui,sans-serif',
      goldBox: 'position:absolute;right:16px;top:16px;padding:9px 14px;border-radius:7px;background:rgba(10,24,36,.82);z-index:20;color:#fff;font:800 16px/1.3 system-ui,sans-serif',
      phaseBadge: 'position:absolute;left:16px;top:18px;padding:8px 10px;border-radius:6px;background:rgba(5,16,28,.72);z-index:20;color:#cbd5e1;font:700 14px/1.3 system-ui,sans-serif',
      joystick: 'position:fixed;left:24px;bottom:24px;width:96px;height:96px;border-radius:50%;border:2px solid rgba(255,255,255,.45);background:rgba(8,16,32,.38);z-index:30;opacity:.86',
      stickThumb: 'position:absolute;left:31px;top:31px;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.85)',
      victory: 'position:fixed;inset:0;display:none;place-items:center;background:rgba(0,0,0,.58);z-index:25;color:#fff;text-align:center',
      victoryTitle: 'font:900 34px/1.18 system-ui,sans-serif;text-shadow:0 3px 14px rgba(0,0,0,.45)',
      ctaDom: 'display:inline-block;margin-top:24px;padding:16px 34px;border-radius:8px;background:#26d67b;color:#06151d;font:900 22px/1.1 system-ui,sans-serif;box-shadow:0 10px 28px rgba(38,214,123,.35)',
    },
  };
}

function compileSourceSceneIrFromStoryboard(input, options) {
  options = options || {};
  input = input || {};
  var ir = input.storyboardIr && input.storyboardIr.kind === 'blueprint.storyboardIr'
    ? input.storyboardIr
    : storyboardIrMod.normalizeStoryboardIr(input, {
      projectName: input.projectName || options.projectName,
      theme: input.themeHint || options.theme,
      entities: input.entities,
    });
  var specs = safeArray(input.specs);
  if (specs.length === 0) {
    var compiledSpecs = storyboardSpecCompiler.compileSpecsFromStoryboardIr(ir, {
      projectName: input.projectName || options.projectName,
      entities: input.entities,
      minActionCoverage: 0,
    });
    specs = compiledSpecs.specs;
  }
  var resources = collectResourceSpecs(input, specs);
  var entities = compileEntities(input, specs, resources);
  var layout = sceneLayoutForEntities(entities);
  var phases = compilePhases(specs, resources, entities);
  var semanticFallbacks = semanticFallbackDiagnosticsForSpecs(specs, resources);
  var diagnostics = semanticFallbacks.length > 0 ? {
    storyboardSemanticFallbacks: semanticFallbacks,
    storyboardRuleLearningQueue: semanticFallbacks.map(function(item) {
      return {
        code: item.code,
        severity: item.severity,
        phaseId: item.phaseId,
        phaseIndex: item.phaseIndex,
        semanticText: item.semanticText,
        fallbackInteraction: item.fallbackInteraction,
        fallbackTarget: item.fallbackTarget || null,
        ruleAction: item.ruleAction,
      };
    }),
  } : null;
  var raw = {
    schemaVersion: sourceSceneIr.SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: 'blueprint.sourceSceneIR',
    project: { name: input.projectName || options.projectName || ir.project && ir.project.name || 'storyboard2html', theme: input.themeHint || options.theme || ir.project && ir.project.theme || 'default' },
    scene: {
      backgroundColor: input.themeHint === 'farming' ? '#16351f' : '#101820',
      camera: layout.camera,
      ground: { kind: 'plane', size: [layout.mapSize, layout.mapSize], width: layout.mapSize, height: layout.mapSize, color: input.themeHint === 'farming' ? '#315c2d' : '#203040' },
    },
    entities: entities,
    resources: resources,
    phases: phases,
    hud: {
      tip: { source: 'phase.guideText' },
      resourceBar: resources.map(function(resource) { return resource.id; }),
      cta: { entity: 'CtaButton', arrivalGated: true },
      domHudContract: defaultDomHudContract(resources, phases.length),
    },
    runtimeContract: { requiresJoystick: phases.length > 1, requiresArrivalGate: phases.length > 1, forbidAutoplayProgress: true },
    diagnostics: diagnostics,
  };
  return sourceSceneIr.normalizeSourceSceneIr(raw, {
    generatedAt: options.generatedAt,
    sourceHtmlPath: options.sourceHtmlPath,
    html: '<div id="joystick"></div>',
  });
}

module.exports = {
  compileSourceSceneIrFromStoryboard: compileSourceSceneIrFromStoryboard,
  _internals: {
    compileEntities: compileEntities,
    collectResourceSpecs: collectResourceSpecs,
    compilePhases: compilePhases,
    plainGuideTextForSpec: plainGuideTextForSpec,
    showGuideTextForSpec: showGuideTextForSpec,
    defaultDomHudContract: defaultDomHudContract,
    phaseFallbackTarget: phaseFallbackTarget,
    fallbackManualStepForSpec: fallbackManualStepForSpec,
    semanticFallbackDiagnosticsForSpecs: semanticFallbackDiagnosticsForSpecs,
    UNRESOLVED_SEMANTIC_WAIT_SECONDS: UNRESOLVED_SEMANTIC_WAIT_SECONDS,
    sceneLayoutForEntities: sceneLayoutForEntities,
  },
};
