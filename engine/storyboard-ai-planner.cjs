'use strict';

var evidenceIr = require('./evidence-ir.cjs');
var storyboardAi = require('./storyboard-ai.cjs');

var TARGET_PHASE_COUNT = 12;
var MIN_PHASE_COUNT = 10;
var MAX_PHASE_COUNT = 13;

var DEFAULT_PHASES = [
  { title: '开局目标', action: '明确第一步目标', interaction: 'move_to:Target' },
  { title: '首次移动', action: '移动到第一个目标', interaction: 'move_to:Target' },
  { title: '首次采集', action: '采集或拾取第一个资源', interaction: 'collect:Resource:1' },
  { title: '首次收益反馈', action: '把资源转化为收益或进度', interaction: 'collect:Reward:1' },
  { title: '建造/解锁', action: '建造或解锁第一个关键设施', interaction: 'build:Facility' },
  { title: '升级工具', action: '升级工具、车辆或角色', interaction: 'upgrade:Tool:2' },
  { title: '第二轮强化操作', action: '用升级后的能力再次完成核心循环', interaction: 'collect:Resource:2' },
  { title: '解锁新区域', action: '打开新区域或新房间', interaction: 'build:NewArea' },
  { title: '冲突/障碍出现', action: '展示敌人、障碍或压力目标', interaction: 'move_to:Obstacle' },
  { title: '处理冲突', action: '攻击、修复、防守或清障', interaction: 'attack:Enemy' },
  { title: '高潮全景', action: '展示完整系统运转和最终成果', interaction: 'observe' },
  { title: 'CTA收口', action: '展示下载按钮和继续游玩动机', interaction: 'click:CtaButton' },
];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function compactText(text) {
  return stringValue(text).replace(/\s+/g, ' ').trim();
}

function factOrderKey(fact) {
  return stringValue(fact.sourceId) + '|' + stringValue(fact.locator) + '|' + stringValue(fact.factId);
}

function factIndex(fact) {
  var match = stringValue(fact && fact.factId).match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function isTextualFact(fact) {
  return fact && ['title', 'core_loop', 'phase_marker', 'row', 'text'].indexOf(fact.factType) >= 0 && stringValue(fact.text);
}

function isVisualFact(fact) {
  return fact && fact.factType === 'visual_reference' && stringValue(fact.text || fact.metadata && fact.metadata.imagePath);
}

function sourceLabel(ir, sourceId) {
  var src = safeArray(ir.sources).filter(function(item) { return item.sourceId === sourceId; })[0];
  return src ? src.fileName : sourceId;
}

function evidenceRef(ir, fact) {
  return sourceLabel(ir, fact.sourceId) + ':' + fact.locator;
}

function groupByPhaseMarkers(ir, facts) {
  var groups = [];
  var current = null;
  facts.forEach(function(fact) {
    if (fact.factType === 'phase_marker') {
      current = { facts: [fact] };
      groups.push(current);
      return;
    }
    if (current) current.facts.push(fact);
  });
  return groups.filter(function(group) {
    return group.facts.length > 0;
  }).map(function(group) {
    return beatFromFacts(ir, group.facts);
  });
}

function rowBeats(ir, facts) {
  return facts.filter(function(fact) {
    return fact.factType === 'row' || fact.factType === 'text' || fact.factType === 'core_loop';
  }).map(function(fact) {
    return beatFromFacts(ir, [fact]);
  });
}

function beatFromFacts(ir, facts) {
  var text = safeArray(facts).map(function(fact) { return fact.text; }).filter(Boolean).join(' ');
  var refs = safeArray(facts).map(function(fact) { return evidenceRef(ir, fact); });
  var visualReferences = safeArray(facts).filter(isVisualFact).map(function(fact) {
    return stringValue(fact.metadata && fact.metadata.imagePath || fact.text);
  }).filter(Boolean);
  return {
    text: compactText(text),
    titleHint: titleHintFromFacts(facts),
    evidence: refs,
    visualReferences: visualReferences,
    imagePath: visualReferences[0] || '',
    confidence: facts.length ? facts.reduce(function(sum, fact) { return sum + Number(fact.confidence || 0); }, 0) / facts.length : 0.5,
  };
}

function visualBeatFromFact(ir, fact) {
  var imagePath = stringValue(fact.metadata && fact.metadata.imagePath || fact.text);
  var label = stringValue(fact.text || sourceLabel(ir, fact.sourceId));
  return {
    text: '图片参考：' + label + '。需要 AI 视觉理解或人工补充文字来确认具体玩法动作。',
    titleHint: '图片参考',
    evidence: [evidenceRef(ir, fact)],
    visualReferences: imagePath ? [imagePath] : [],
    imagePath: imagePath,
    confidence: 0.42,
  };
}

function cleanTitleCandidate(text) {
  return compactText(text)
    .replace(/(?:Phase|phas\s*e)\s*\d+\s*[:：]?/ig, '')
    .replace(/^(玩家看到什么|玩家做什么|操作反馈|UI)[:：]/, '')
    .replace(/^（|）$/g, '')
    .trim();
}

function titleFragments(text) {
  var raw = stringValue(text)
    .replace(/(?:Phase|phas\s*e)\s*\d+\s*[:：]?/ig, '')
    .replace(/^(玩家看到什么|玩家做什么|操作反馈|UI)[:：]/, '')
    .trim();
  var rawParts = raw.split(/\s{2,}/).map(cleanTitleCandidate).filter(Boolean);
  var cleaned = cleanTitleCandidate(text);
  if (!cleaned) return [];
  var fragments = [cleaned].concat(rawParts);
  var withoutParen = cleaned.replace(/（[^）]*）|\([^)]*\)/g, '').trim();
  if (withoutParen && withoutParen !== cleaned) fragments.push(withoutParen);
  return fragments.map(function(item) {
    return item.replace(/[。；，,]+$/g, '').trim();
  }).filter(Boolean);
}

function titleCandidateScore(text, order) {
  var score = 0;
  if (/^(拾取|建造|升级|引导|组成|使用|利用|解锁|继续|采集|售卖|回收)/.test(text)) score += 30;
  if (/(拾取|建造|升级|引导|组成|使用|利用|解锁|采集|售卖|回收|CTA|下载|跳转)/.test(text)) score += 20;
  if (text.length >= 4 && text.length <= 14) score += 18;
  if (text.length >= 2 && text.length <= 20) score += 8;
  if (/[（）()]/.test(text)) score -= 18;
  if (/[，,。；]/.test(text)) score -= 8;
  if (/秒|左右|前方|后方|能够|快速|爽感|玩家|垃圾的时候/.test(text)) score -= 12;
  return score - order * 0.01;
}

function inferredTitleFromAggregate(text) {
  var hay = compactText(text);
  if (/升级液压车/.test(hay)) return '升级液压车';
  if (/升级粉碎车/.test(hay)) return '升级粉碎车';
  if (/建造锻造间/.test(hay)) return '建造锻造间';
  if (/使用粉碎车采集垃圾/.test(hay)) return '使用粉碎车采集垃圾';
  if (/使用液压车收集/.test(hay)) return '使用液压车收集碎块';
  if (/使用新钻头采集垃圾/.test(hay)) return '使用新钻头采集垃圾';
  if (/拾取垃圾/.test(hay) && /换得美金/.test(hay)) return '拾取垃圾换得美金';
  if (/组成完整的空间站/.test(hay)) return '组成完整的空间站';
  return '';
}

function titleHintFromFacts(facts) {
  var inferred = inferredTitleFromAggregate(safeArray(facts).map(function(fact) { return fact && fact.text; }).join(' '));
  if (inferred) return inferred;
  var candidates = [];
  safeArray(facts).forEach(function(fact) {
    titleFragments(fact && fact.text).forEach(function(fragment) {
      candidates.push(fragment);
    });
  });
  candidates = candidates.filter(function(text) {
    return text && !/^(需求描述|序号|文字描述|画面|注释)$/.test(text);
  });
  var preferred = candidates.filter(function(text) {
    return text.length >= 2 && text.length <= 32 && !/^\d+$/.test(text);
  }).map(function(text, index) {
    return { text: text, score: titleCandidateScore(text, index) };
  }).sort(function(a, b) {
    return b.score - a.score;
  })[0];
  preferred = preferred && preferred.text || candidates[0] || '';
  return preferred.length > 20 ? preferred.slice(0, 20) : preferred;
}

function dedupeBeats(beats) {
  var seen = {};
  var out = [];
  safeArray(beats).forEach(function(beat) {
    var key = compactText(beat.text).slice(0, 120);
    if (!key || seen[key]) return;
    seen[key] = true;
    out.push(beat);
  });
  return out;
}

function extractBeats(ir) {
  var sourceOrder = {};
  safeArray(ir.sources).forEach(function(source, index) {
    sourceOrder[source.sourceId] = index;
  });
  var orderedFacts = safeArray(ir.facts).filter(function(fact) {
    return isTextualFact(fact) || isVisualFact(fact);
  }).sort(function(a, b) {
    var sa = sourceOrder[a.sourceId] == null ? 9999 : sourceOrder[a.sourceId];
    var sb = sourceOrder[b.sourceId] == null ? 9999 : sourceOrder[b.sourceId];
    if (sa !== sb) return sa - sb;
    var ia = factIndex(a);
    var ib = factIndex(b);
    if (ia !== ib) return ia - ib;
    return factOrderKey(a).localeCompare(factOrderKey(b));
  });
  var facts = orderedFacts.filter(isTextualFact);
  var visualFacts = orderedFacts.filter(isVisualFact);
  if (!facts.length && visualFacts.length) {
    return visualFacts.map(function(fact) { return visualBeatFromFact(ir, fact); });
  }
  var phaseMarkers = facts.filter(function(fact) { return fact.factType === 'phase_marker'; });
  var beats = phaseMarkers.length >= 2 ? groupByPhaseMarkers(ir, facts) : rowBeats(ir, facts);
  return dedupeBeats(beats).filter(function(beat) {
    return beat.text.length >= 3;
  });
}

function mergeBeats(beats, target) {
  if (beats.length <= target) return beats.slice();
  var out = [];
  for (var i = 0; i < target; i += 1) {
    var start = Math.floor(i * beats.length / target);
    var end = Math.floor((i + 1) * beats.length / target);
    var chunk = beats.slice(start, Math.max(start + 1, end));
    out.push({
      text: chunk.map(function(beat) { return beat.text; }).join('；'),
      titleHint: chunk[0] && chunk[0].titleHint || '',
      evidence: chunk.reduce(function(list, beat) { return list.concat(beat.evidence || []); }, []),
      visualReferences: chunk.reduce(function(list, beat) { return list.concat(beat.visualReferences || []); }, []),
      imagePath: chunk.filter(function(beat) { return beat.imagePath; })[0] && chunk.filter(function(beat) { return beat.imagePath; })[0].imagePath || '',
      confidence: chunk.reduce(function(sum, beat) { return sum + Number(beat.confidence || 0.5); }, 0) / chunk.length,
    });
  }
  return out;
}

function expandBeats(beats, target) {
  var hasFinal = beats.length > 0 && /cta|下载|安装|跳转|结束|收口|完整.*空间站/i.test(beats[beats.length - 1].text || '');
  var finalBeat = hasFinal ? beats[beats.length - 1] : null;
  var out = hasFinal ? beats.slice(0, -1) : beats.slice();
  for (var i = out.length; i < target; i += 1) {
    if (finalBeat && i === target - 1) break;
    var tmpl = DEFAULT_PHASES[i] || DEFAULT_PHASES[DEFAULT_PHASES.length - 1];
    out.push({
      text: tmpl.title + '：' + tmpl.action,
      titleHint: tmpl.title,
      evidence: [],
      confidence: 0.35,
      templateFallback: true,
    });
  }
  if (finalBeat) out.push(finalBeat);
  return out;
}

function fitBeats(beats) {
  var target = TARGET_PHASE_COUNT;
  if (beats.length >= MIN_PHASE_COUNT && beats.length <= MAX_PHASE_COUNT) return beats.slice();
  if (beats.length > MAX_PHASE_COUNT) return mergeBeats(beats, target);
  return expandBeats(beats, target);
}

function titleFromText(text, index, hint) {
  var hintText = cleanTitleCandidate(hint);
  if (hintText) return hintText.length > 20 ? hintText.slice(0, 20) : hintText;
  var compact = compactText(text).replace(/(?:Phase|phas\s*e)\s*\d+\s*[:：]?/ig, ' ');
  var phaseTitle = compact.match(/(?:Phase|phas\s*e)\s*\d+\s*[:：]?\s*([^。；，,|]{2,24})/i);
  if (phaseTitle && phaseTitle[1]) return phaseTitle[1].trim();
  var parts = compact.split(/[。；，,|]/).map(function(part) {
    return compactText(part)
      .replace(/^(玩家看到什么|玩家做什么|操作反馈|UI)[:：]/, '')
      .replace(/^（/, '')
      .replace(/）$/, '');
  }).filter(Boolean);
  var best = parts.filter(function(part) {
    return part.length >= 2 && !/^玩家/.test(part);
  }).sort(function(a, b) {
    var ap = /[（）()]/.test(a) ? 20 : 0;
    var bp = /[（）()]/.test(b) ? 20 : 0;
    return (Math.abs(a.length - 10) + ap) - (Math.abs(b.length - 10) + bp);
  })[0];
  if (best) return best.length > 20 ? best.slice(0, 20) : best;
  return (DEFAULT_PHASES[index] && DEFAULT_PHASES[index].title) || ('Phase ' + (index + 1));
}

function interactionFromText(text, index, total) {
  var hay = compactText(text);
  if (index === total - 1) return /cta|下载|安装|跳转|结束|立即|收口/i.test(hay) ? 'click:CtaButton' : 'click:CtaButton';
  if (/建造|搭建|修建|解锁|建成|build/i.test(hay)) return 'build:Facility';
  if (/升级|强化|upgrade/i.test(hay)) return 'upgrade:Tool:2';
  if (/攻击|消灭|击败|射击|打爆|attack|shoot/i.test(hay)) return 'attack:Enemy';
  if (/采集|收集|拾取|获得|捡|collect|gather/i.test(hay)) return 'collect:Resource:1';
  if (/交付|售卖|卖|投入|兑换|换得|deliver|sell/i.test(hay)) return 'deliver:Resource:Base';
  if (/移动|前往|靠近|引导|move|joystick/i.test(hay)) return 'move_to:Target';
  return DEFAULT_PHASES[index] && DEFAULT_PHASES[index].interaction || 'observe';
}

function targetFromInteraction(interaction) {
  var parts = stringValue(interaction).split(':');
  if (parts[0] === 'collect') return parts[1] || 'Resource';
  if (parts[0] === 'deliver') return parts[2] || parts[1] || 'Base';
  return parts[1] || '';
}

function visualBriefForPhase(phase, beat, index, total) {
  var isFinal = index === total - 1;
    var mustShow = ['玩家', phase.primaryTarget || phase.title].filter(Boolean);
  if (/资源|采集|拾取|收集/.test(phase.title + phase.sceneText)) mustShow.push('资源点');
  if (/建造|设施|解锁/.test(phase.title + phase.sceneText)) mustShow.push('建造地贴或新设施');
  if (/升级|工具|车辆/.test(phase.title + phase.sceneText)) mustShow.push('升级前后变化');
  return {
    mustShow: mustShow,
    mustNotShow: isFinal ? [] : ['CTA按钮', '下载弹窗'],
    camera: '俯视或等距视角，能看清玩家、目标、UI指引和反馈',
    ui: ['黄色箭头或高亮圈指向主目标', phase.uiText || phase.title],
    sourceEvidence: beat.evidence || [],
    referenceImages: beat.visualReferences || [],
    accuracyGoal: '画面必须准确表达本 phase 的玩家动作和结果，不添加未提到的核心玩法。',
  };
}

function sceneTextFromBeat(beat, title) {
  var text = compactText(beat.text);
  if (!text) return title + '阶段的画面。';
  if (text.length <= 120) return text;
  return text.slice(0, 118) + '...';
}

function actionText(interaction, title) {
  var verb = stringValue(interaction).split(':')[0];
  if (verb === 'collect') return '引导玩家完成采集或拾取，获得关键资源。';
  if (verb === 'deliver') return '引导玩家把资源交付到目标点，转化为收益或进度。';
  if (verb === 'build') return '引导玩家建造或解锁关键设施。';
  if (verb === 'upgrade') return '引导玩家升级工具、设施或角色能力。';
  if (verb === 'attack') return '引导玩家处理敌人、障碍或威胁。';
  if (verb === 'move_to') return '引导玩家移动到高亮目标位置。';
  if (verb === 'click') return '引导玩家点击最终 CTA。';
  return '展示“' + title + '”的关键状态。';
}

function feedbackText(interaction) {
  var verb = stringValue(interaction).split(':')[0];
  if (verb === 'collect') return '资源飞向玩家或计数条增加，给出明确获得反馈。';
  if (verb === 'deliver') return '资源扣除并转化为金币、能量或进度，目标点播放反馈动画。';
  if (verb === 'build') return '设施从地贴变成完成状态，出现建成特效。';
  if (verb === 'upgrade') return '目标外观升级，效率或能力变化可见。';
  if (verb === 'attack') return '敌人或障碍受到打击、消失或退场。';
  if (verb === 'move_to') return '角色到达目标，高亮圈或箭头切换到下一步。';
  if (verb === 'click') return '出现下载/安装按钮，完成试玩收口。';
  return '镜头或 UI 明确展示阶段变化。';
}

function coreLoopFromEvidence(ir, phases) {
  var core = safeArray(ir.facts).filter(function(fact) { return fact.factType === 'core_loop'; })[0];
  if (core && core.text) return core.text;
  return phases.slice(0, 7).map(function(phase) { return phase.title; }).join(' -> ') + ' -> CTA';
}

function planStoryboardAiFromEvidence(inputIr, options) {
  options = options || {};
  var ir = inputIr && inputIr.kind === evidenceIr.EVIDENCE_IR_KIND
    ? inputIr
    : evidenceIr.normalizeEvidenceIr(inputIr || {}, options);
  evidenceIr.assertEvidenceIr(ir);
  var rawBeats = extractBeats(ir);
  var fitted = fitBeats(rawBeats);
  var total = fitted.length;
  var phases = fitted.map(function(beat, index) {
    var interaction = interactionFromText(beat.text, index, total);
    var title = titleFromText(beat.text, index, beat.titleHint);
    var phase = {
      phaseId: 'phase' + (index + 1),
      title: title,
      sceneText: sceneTextFromBeat(beat, title),
      playerAction: actionText(interaction, title),
      feedback: feedbackText(interaction),
      uiText: index === total - 1 ? '立即下载' : '跟随箭头完成目标',
      primaryTarget: targetFromInteraction(interaction),
      canonicalInteraction: interaction,
      image: beat.imagePath || '',
      visualPrompt: title,
      sourceEvidence: beat.evidence || [],
      confidence: Math.round(Number(beat.confidence || 0.5) * 100) / 100,
    };
    phase.visualBrief = visualBriefForPhase(phase, beat, index, total);
    return phase;
  });
  var ai = storyboardAi.normalizeStoryboardAi({
    projectName: options.projectName || ir.project && ir.project.name,
    coreLoop: options.coreLoop || coreLoopFromEvidence(ir, phases),
    phases: phases,
  }, {
    projectName: options.projectName || ir.project && ir.project.name,
    coreLoop: options.coreLoop,
  });
  ai.planning = {
    schemaVersion: 'storyboard-ai-planning.v1',
    evidenceHash: ir.semanticHash,
    rawBeatCount: rawBeats.length,
    phaseCount: ai.phases.length,
    phaseCountPolicy: { min: MIN_PHASE_COUNT, max: MAX_PHASE_COUNT, default: TARGET_PHASE_COUNT },
    strategy: rawBeats.length > MAX_PHASE_COUNT ? 'merge_to_12' : (rawBeats.length < MIN_PHASE_COUNT ? 'expand_to_12' : 'use_extracted_count'),
  };
  ai.semanticHash = storyboardAi._internals.semanticHash({
    schemaVersion: ai.schemaVersion,
    project: ai.project,
    phases: ai.phases,
    planning: ai.planning,
  });
  return ai;
}

module.exports = {
  TARGET_PHASE_COUNT: TARGET_PHASE_COUNT,
  MIN_PHASE_COUNT: MIN_PHASE_COUNT,
  MAX_PHASE_COUNT: MAX_PHASE_COUNT,
  planStoryboardAiFromEvidence: planStoryboardAiFromEvidence,
  _internals: {
    extractBeats: extractBeats,
    fitBeats: fitBeats,
    mergeBeats: mergeBeats,
    expandBeats: expandBeats,
    interactionFromText: interactionFromText,
    titleFromText: titleFromText,
    titleHintFromFacts: titleHintFromFacts,
  },
};
