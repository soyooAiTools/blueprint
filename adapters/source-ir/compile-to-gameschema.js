'use strict';

var {
  normalizeSourceSceneIr,
  projectSourceSceneIrToLegacy,
  validateSourceSceneIr,
} = require('../../engine/source-scene-ir.cjs');
var schemaValidator = require('../schema/validate-schema.cjs');

var POOL_LIMITS = { Cube: 5, Sphere: 5, Cylinder: 3, Plane: 3 };
var POOL_COLORS = ['Red', 'Blue', 'Green', 'Yellow', 'Orange', 'Purple', 'White', 'Brown', 'Cyan', 'Pink'];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function rgb01FromColor(color, fallback) {
  var text = String(color == null ? '' : color).trim();
  if (/^0x[0-9a-f]{6}$/i.test(text)) text = '#' + text.slice(2);
  if (/^[0-9]+$/.test(text)) {
    var numeric = Number(text);
    if (Number.isFinite(numeric)) text = '#' + numeric.toString(16).padStart(6, '0').slice(-6);
  }
  if (!/^#[0-9a-f]{6}$/i.test(text)) return fallback;
  return [
    Number((parseInt(text.slice(1, 3), 16) / 255).toFixed(4)),
    Number((parseInt(text.slice(3, 5), 16) / 255).toFixed(4)),
    Number((parseInt(text.slice(5, 7), 16) / 255).toFixed(4)),
  ];
}

function colorNameFromHex(hex) {
  var text = String(hex || '').replace(/^#/, '').trim();
  if (!/^[0-9a-f]{6}$/i.test(text)) return 'White';
  var r = parseInt(text.slice(0, 2), 16);
  var g = parseInt(text.slice(2, 4), 16);
  var b = parseInt(text.slice(4, 6), 16);
  var max = Math.max(r, g, b);
  var min = Math.min(r, g, b);
  if (max < 80) return 'Brown';
  if (max - min < 35) return max > 180 ? 'White' : 'Brown';
  if (r > 210 && g > 140 && b < 120) return 'Orange';
  if (r > 200 && g > 180 && b < 130) return 'Yellow';
  if (r > g + 45 && r > b + 45) return 'Red';
  if (g > r + 35 && g > b + 20) return 'Green';
  if (b > r + 35 && b > g + 15) return 'Blue';
  if (g > 160 && b > 160) return 'Cyan';
  if (r > 170 && b > 150) return 'Purple';
  return 'White';
}

function poolSpecForEntity(entity) {
  var kind = String(entity && entity.kind || entity && entity.visual && entity.visual.primitive || '').toLowerCase();
  var color = colorNameFromHex(entity && entity.visual && entity.visual.color);
  if (/player|hero|astronaut|character|avatar/.test(kind)) return { shape: 'Cylinder', color: color === 'White' ? 'Cyan' : color, scale: 0.65, showLabel: false };
  if (/cta|button|install|download/.test(kind) || /cta|button/i.test(entity && entity.id)) return { shape: 'Cube', color: 'Green', scale: 0.55, showLabel: false };
  if (/ship|base|station|gate|tower|machine|counter|pad/.test(kind)) return { shape: /pad|gate/.test(kind) ? 'Cylinder' : 'Cube', color: color, scale: 0.7, showLabel: true };
  if (/coin|gold|resource|collect|crystal|gem|ice|debris|scrap|bullet|ore/.test(kind)) return { shape: /coin|gold/.test(kind) ? 'Cylinder' : (/crystal|gem|ice/.test(kind) ? 'Sphere' : 'Cube'), color: color, scale: 0.6, showLabel: true };
  if (/enemy|alien|monster|boss/.test(kind)) return { shape: 'Sphere', color: color === 'White' ? 'Red' : color, scale: 0.75, showLabel: true };
  return { shape: 'Cube', color: color, scale: 0.65, showLabel: true };
}

function isHudOnlyOrCtaEntity(entity) {
  var kind = String(entity && entity.kind || '');
  var id = String(entity && entity.id || '');
  return /\b(ui_marker|hud|hud_marker|ui_overlay|screen_ui|cta|install|download)\b/i.test(kind + ' ' + id) ||
    /^(CtaButton|CTAButton|CTAPopup|InstallButton|DownloadButton)$/i.test(id) ||
    /(?:^|_)(?:GoldUI|JoystickUI|HUD|Hud|GuideText|PhaseLabel)$/i.test(id);
}

function makePoolAllocator() {
  var counters = {};
  function normalizeShape(shape) {
    var value = String(shape || 'Cube').replace(/[^A-Za-z]/g, '');
    return POOL_LIMITS[value] ? value : 'Cube';
  }
  function normalizeColor(color) {
    var value = String(color || 'White').replace(/[^A-Za-z]/g, '');
    return POOL_COLORS.indexOf(value) >= 0 ? value : 'White';
  }
  return function nextPool(shape, color) {
    var preferredShape = normalizeShape(shape);
    var preferredColor = normalizeColor(color);
    var shapes = [preferredShape].concat(Object.keys(POOL_LIMITS).filter(function(item) { return item !== preferredShape; }));
    var colors = [preferredColor].concat(POOL_COLORS.filter(function(item) { return item !== preferredColor; }));
    for (var i = 0; i < shapes.length; i += 1) {
      for (var j = 0; j < colors.length; j += 1) {
        var key = shapes[i] + '_' + colors[j];
        var next = (counters[key] || 0) + 1;
        if (next <= POOL_LIMITS[shapes[i]]) {
          counters[key] = next;
          return '__Pool_' + shapes[i] + '_' + colors[j] + '_' + String(next).padStart(2, '0');
        }
      }
    }
    return '__Pool_Cube_White_01';
  };
}

function vector3(value, fallback) {
  var source = Array.isArray(value) ? value : fallback;
  return [
    Number(source && source[0]) || 0,
    Number(source && source[1]) || 0,
    Number(source && source[2]) || 0,
  ];
}

function scaleNumber(scale) {
  if (Array.isArray(scale)) {
    var values = scale.map(Number).filter(Number.isFinite);
    var max = values.length ? Math.max.apply(Math, values) : 1;
    return Math.max(0.3, Number(max.toFixed(3)));
  }
  var n = Number(scale);
  return Number.isFinite(n) ? Math.max(0.3, Number(n.toFixed(3))) : 1;
}

function compileEntity(entity, index, nextPool) {
  var spec = poolSpecForEntity(entity);
  return {
    name: entity.id,
    chineseName: entity.label || entity.id,
    showLabel: spec.showLabel,
    pool: nextPool(spec.shape, spec.color),
    initPos: vector3(entity.position, [index * 1.5, 0, 0]),
    scale: scaleNumber(entity.scale || spec.scale),
    showInPhase: entity.visibleFromPhase || undefined,
  };
}

function compileResource(resource) {
  return {
    name: resource.id,
    entity: resource.carrierEntity || '',
    convertRatio: 1,
    maxStock: Math.max(0, Number(resource.initial || 0) + 999),
  };
}

function triggerFromGate(gate, phase, isFinal) {
  if (!gate || typeof gate !== 'object') return null;
  if (gate.kind === 'resource') {
    return {
      type: 'resource_collected',
      resource: gate.resource || 'Resource',
      amount: Math.max(1, Math.round(Number(gate.threshold || gate.amount || 1) || 1)),
    };
  }
  if (gate.kind === 'near_entity') {
    return {
      type: 'near_entity',
      entity: gate.entity || gate.target || 'Target',
      range: Number(gate.radius || gate.range || 2) || 2,
    };
  }
  if (gate.kind === 'entity_state') {
    var stateTrigger = {
      type: 'entity_state_reached',
      entity: gate.entity || gate.target || 'Target',
      state: Math.round(Number(gate.state == null ? 1 : gate.state) || 1),
    };
    var arrivalTarget = !isFinal && firstStepTarget(phase);
    if (!arrivalTarget || arrivalTarget === stateTrigger.entity) {
      arrivalTarget = stateTrigger.entity;
    }
    if (!isFinal && arrivalTarget) {
      return {
        type: 'compound',
        operator: 'and',
        triggers: [
          { type: 'near_entity', entity: arrivalTarget, range: Number(gate.radius || gate.range || 2) || 2 },
          stateTrigger,
        ],
      };
    }
    return stateTrigger;
  }
  if (gate.kind === 'entity_count') {
    return {
      type: 'enemy_defeated',
      entity: gate.entity || gate.target || 'Enemy',
      count: Math.max(1, Math.round(Number(gate.count || gate.threshold || 1) || 1)),
    };
  }
  if (gate.kind === 'timer') {
    return {
      type: 'compound',
      operator: 'and',
      triggers: [{ type: 'timer', seconds: Number(gate.seconds || 1) || 1 }],
    };
  }
  if (gate.kind === 'cta_arrival') {
    return {
      type: 'cta_arrival',
      ctaId: gate.ctaId || gate.entity || gate.target || 'CtaButton',
      range: Number(gate.radius || gate.range || 2) || 2,
    };
  }
  if (gate.kind === 'compound_all' || gate.kind === 'compound_any') {
    return {
      type: 'compound',
      operator: gate.kind === 'compound_any' ? 'or' : 'and',
      triggers: safeArray(gate.gates).map(function(child) {
        return triggerFromGate(child, phase, isFinal);
      }).filter(Boolean),
    };
  }
  return null;
}

function firstStepTarget(phase) {
  var found = safeArray(phase && phase.steps).find(function(step) {
    return step && (step.target || step.from || step.to || step.entity);
  });
  return found && (found.target || found.from || found.to || found.entity) || '';
}

function fallbackTriggerForPhase(phase, isFinal) {
  if (isFinal) return { type: 'cta_arrival', ctaId: 'CtaButton', range: 2 };
  var target = firstStepTarget(phase) || safeArray(phase && phase.showEntities).filter(function(name) {
    return !/player|hero|guide|hud|ui/i.test(name);
  })[0] || 'Player';
  return { type: 'near_entity', entity: target, range: 2 };
}

function compileStep(step, index, entityMap) {
  step = step || {};
  if (step.kind === 'cta_finish') {
    return {
      index: index,
      label: step.label || 'cta_finish',
    };
  }
  var target = step.target || step.from || step.to || step.entity || '';
  if (target && entityMap && !entityMap[target]) target = '';
  var out = {
    index: index,
    target: target,
    label: step.label || target || step.resource || step.kind || '',
  };
  if (step.kind === 'collect') out.gain = step.resource || '';
  if (step.kind === 'deliver') out.spend = step.resource || '';
  if (step.kind === 'set_entity_state' || step.kind === 'build' || step.kind === 'upgrade') {
    out.setEntity = entityMap && !entityMap[step.entity || step.target || target] ? '' : (step.entity || step.target || target);
    out.state = Number(step.state == null ? (step.kind === 'upgrade' ? 2 : 1) : step.state) || 1;
  }
  if (step.kind === 'attack') out.damage = true;
  if (step.amount != null) out.amount = Number(step.amount) || 1;
  if (step.cost != null) out.cost = Number(step.cost) || 1;
  Object.keys(out).forEach(function(key) {
    if (out[key] === '' || out[key] === undefined || out[key] === null) delete out[key];
  });
  return out;
}

function compilePhase(phase, index, phaseCount, entityMap) {
  var isFinal = index === phaseCount - 1;
  var trigger = triggerFromGate(phase.gate, phase, isFinal) || fallbackTriggerForPhase(phase, isFinal);
  return {
    phaseId: phase.id || ('phase' + (index + 1)),
    showEntities: safeArray(phase.showEntities).filter(function(id) { return entityMap[id]; }),
    guideText: phase.guideText || phase.title || phase.id || '',
    trigger: trigger,
    steps: safeArray(phase.steps).map(function(step, stepIndex) {
      return compileStep(step, stepIndex, entityMap);
    }),
    onEnter: phase.guideText ? [{ action: 'set_guide', text: phase.guideText }] : [],
  };
}

function compileToGameSchema(sourceIr, options) {
  options = options || {};
  var ir = normalizeSourceSceneIr(sourceIr, options);
  validateSourceSceneIr(ir);
  var nextPool = makePoolAllocator();
  var scene = ir.scene || {};
  var ground = scene.ground || {};
  var gameplayEntities = safeArray(ir.entities).filter(function(entity) {
    return !isHudOnlyOrCtaEntity(entity);
  });
  var gameplayEntityMap = {};
  gameplayEntities.forEach(function(entity) {
    gameplayEntityMap[entity.id] = true;
  });
  var schema = {
    gameConfig: {
      cameraBackground: rgb01FromColor(scene.backgroundColor, [0.04, 0.07, 0.16]),
      groundColor: rgb01FromColor(ground.color, [0.10, 0.16, 0.13]),
      moveSpeed: Number(options.moveSpeed || 5),
      collectRange: Number(options.collectRange || 2.5),
      maxCarry: Number(options.maxCarry || 10),
      collectCooldown: Number(options.collectCooldown || 0.3),
    },
    entities: gameplayEntities.map(function(entity, index) {
      return compileEntity(entity, index, nextPool);
    }),
    resources: safeArray(ir.resources).map(compileResource),
    phases: safeArray(ir.phases).map(function(phase, index, phases) {
      return compilePhase(phase, index, phases.length, gameplayEntityMap);
    }),
    customLogic: [
      'semanticSource=source-scene-ir',
      'legacyJsInferenceUsed=false',
      'sourceSceneIrHash=' + ir.semanticHash,
    ],
  };
  var legacyProjection = projectSourceSceneIrToLegacy(ir);
  schema.sourceIrProjection = legacyProjection;
  delete schema.sourceIrProjection;
  var structErrors = schemaValidator.validateGameSchema(schema);
  var semanticErrors = structErrors.length ? [] : schemaValidator.validateSemantics(schema);
  if ((structErrors.length || semanticErrors.length) && options.validate !== false) {
    throw new Error('SourceSceneIR gameSchema validation failed: ' + JSON.stringify({ structErrors: structErrors, semanticErrors: semanticErrors }));
  }
  return schema;
}

module.exports = {
  compileToGameSchema: compileToGameSchema,
  _internals: {
    rgb01FromColor: rgb01FromColor,
    triggerFromGate: triggerFromGate,
    compileStep: compileStep,
    poolSpecForEntity: poolSpecForEntity,
  },
};
