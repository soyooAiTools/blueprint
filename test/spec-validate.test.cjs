const specValidate = require('../engine/stages/spec-validate.cjs');

function makeCtx(blueprint) {
  var logs = [];
  return {
    blueprint: blueprint,
    addLog: function(stage, msg) { logs.push(stage + ': ' + msg); },
    reportStatus: function() {},
    _logs: logs,
  };
}

describe('spec-validate entity name resolution', () => {
  test('exact match passes', () => {
    var ctx = makeCtx({
      specs: [{
        phaseId: 'collectGems',
        entitiesRequired: [{ name: 'GemStone' }],
        requiredInteractions: ['collect:gem'],
        triggerNext: { condition: 'gemsCollected >= 5' },
        duration: { min: 10, max: 20 },
      }],
      entities: [{ name: 'GemStone' }],
    });
    return specValidate.execute(ctx).then(function() {
      expect(ctx.blueprint.specs[0].entitiesRequired[0].name).toBe('GemStone');
    });
  });

  test('case-insensitive match auto-corrects', () => {
    var ctx = makeCtx({
      specs: [{
        phaseId: 'collectGems',
        entitiesRequired: [{ name: 'gemstone' }],
        requiredInteractions: ['collect:gem'],
        triggerNext: { condition: 'gemsCollected >= 5' },
        duration: { min: 10, max: 20 },
      }],
      entities: [{ name: 'GemStone' }],
    });
    return specValidate.execute(ctx).then(function() {
      expect(ctx.blueprint.specs[0].entitiesRequired[0].name).toBe('GemStone');
    });
  });

  test('substring single match auto-corrects', () => {
    var ctx = makeCtx({
      specs: [{
        phaseId: 'collectGems',
        entitiesRequired: [{ name: 'gem' }],
        requiredInteractions: ['collect:gem'],
        triggerNext: { condition: 'gemsCollected >= 5' },
        duration: { min: 10, max: 20 },
      }],
      entities: [{ name: 'GemStone' }],
    });
    return specValidate.execute(ctx).then(function() {
      expect(ctx.blueprint.specs[0].entitiesRequired[0].name).toBe('GemStone');
    });
  });

  test('phase-context disambiguates multi-match (drill → TripleDrill when phaseId=upgradeTripleDrill)', () => {
    var ctx = makeCtx({
      specs: [{
        phaseId: 'upgradeTripleDrill',
        entitiesRequired: [{ name: 'drill' }],
        requiredInteractions: ['upgrade:drill'],
        triggerNext: { condition: 'drillUpgraded' },
        duration: { min: 10, max: 20 },
      }],
      entities: [
        { name: 'BasicDrill' },
        { name: 'TripleDrill' },
        { name: 'MegaDrill' },
      ],
    });
    return specValidate.execute(ctx).then(function() {
      expect(ctx.blueprint.specs[0].entitiesRequired[0].name).toBe('TripleDrill');
    });
  });

  test('phase-context disambiguates (forge → ForgeWorkshop when phaseId=buildForgeWorkshop)', () => {
    var ctx = makeCtx({
      specs: [{
        phaseId: 'buildForgeWorkshop',
        entitiesRequired: [{ name: 'forge' }],
        requiredInteractions: ['build:forge'],
        triggerNext: { condition: 'forgeBuilt' },
        duration: { min: 10, max: 20 },
      }],
      entities: [
        { name: 'ForgeWorkshop' },
        { name: 'ForgeHammer' },
      ],
    });
    return specValidate.execute(ctx).then(function() {
      expect(ctx.blueprint.specs[0].entitiesRequired[0].name).toBe('ForgeWorkshop');
    });
  });

  test('unknown entity with no match is stripped + warned (does not hard-fail pipeline)', () => {
    // Contract change (engine/stages/spec-validate.cjs:178-184): a fully hallucinated
    // entity name used to throw, but that created a permanent dead-end requiring a
    // full pipeline restart. The current contract strips the entry and logs a warning
    // so the rest of the pipeline can proceed.
    var ctx = makeCtx({
      specs: [{
        phaseId: 'collectGems',
        entitiesRequired: [{ name: 'Dragon' }],
        requiredInteractions: ['collect:gem'],
        triggerNext: { condition: 'gemsCollected >= 5' },
        duration: { min: 10, max: 20 },
      }],
      entities: [{ name: 'GemStone' }],
    });
    return Promise.resolve(specValidate.execute(ctx)).then(function() {
      expect(ctx.blueprint.specs[0].entitiesRequired).toEqual([]);
      var warned = ctx._logs.some(function(l) { return l.indexOf('Dragon') >= 0; });
      expect(warned).toBe(true);
    });
  });
});

describe('spec-validate review shot duration policy', () => {
  function makeDurationCtx(duration) {
    return makeCtx({
      specs: [{
        phaseId: 'reviewPacing',
        entitiesRequired: [],
        requiredInteractions: ['click:StartButton'],
        triggerNext: { condition: 'reviewPacingDone' },
        duration: duration,
      }],
      entities: [],
    });
  }

  test('short storyboard timing is expanded to readable review pacing', () => {
    var ctx = makeDurationCtx({ min: 3, max: 8 });
    return specValidate.execute(ctx).then(function(result) {
      expect(ctx.blueprint.specs[0].duration).toEqual({ min: 10, max: 12 });
      expect(result.autoFixes.join('\n')).toMatch(/review shot duration normalized/);
    });
  });

  test('overlong storyboard timing is capped at 15 seconds', () => {
    var ctx = makeDurationCtx({ min: 12, max: 30 });
    return specValidate.execute(ctx).then(function() {
      expect(ctx.blueprint.specs[0].duration).toEqual({ min: 12, max: 15 });
    });
  });

  test('missing duration falls back to the 10-15 second review window', () => {
    var ctx = makeDurationCtx(undefined);
    return specValidate.execute(ctx).then(function() {
      expect(ctx.blueprint.specs[0].duration).toEqual({ min: 10, max: 15 });
    });
  });
});

describe('complexity-gate parseSimplifyResponse', () => {
  const cg = require('../engine/stages/complexity-gate.cjs');
  const VALID = '{"specs":[{"phaseId":"a"}],"entities":[{"name":"X"}]}';

  test('normal fenced JSON', () => {
    var r = cg.parseSimplifyResponse('```json\n' + VALID + '\n```');
    expect(r.specs).toHaveLength(1);
    expect(r.entities).toHaveLength(1);
  });

  test('truncated fence (no closing ```)', () => {
    var r = cg.parseSimplifyResponse('```json\n' + VALID);
    expect(r.specs).toHaveLength(1);
  });

  test('no fence at all', () => {
    var r = cg.parseSimplifyResponse(VALID);
    expect(r.specs).toHaveLength(1);
  });

  test('preamble text before fence', () => {
    var r = cg.parseSimplifyResponse('Here is the simplified JSON:\n```json\n' + VALID + '\n```');
    expect(r.specs).toHaveLength(1);
  });

  test('trailing comma repair', () => {
    var r = cg.parseSimplifyResponse('{"specs":[{"phaseId":"a"},],"entities":[]}');
    expect(r.specs).toHaveLength(1);
  });

  test('4-backtick fence', () => {
    var r = cg.parseSimplifyResponse('````json\n' + VALID + '\n````');
    expect(r.specs).toHaveLength(1);
  });

  test('missing specs array throws', () => {
    expect(() => cg.parseSimplifyResponse('{"entities":[]}')).toThrow(/specs/);
  });
});

describe('complexity-gate scoring', () => {
  const cg = require('../engine/stages/complexity-gate.cjs');

  test('computeScore basic', () => {
    var result = cg.computeScore(
      [{ requiredInteractions: ['move_to:a'] }, { requiredInteractions: ['click:b'] }],
      [{ terminalState: 2 }]
    );
    expect(result.total).toBe(2*10 + 1*40 + 0*20 + 1*5 + 0*15);
    expect(result.breakdown.codePhases).toBe(2);
    expect(result.breakdown.statefulEntities).toBe(1);
  });

  test('countEconLayers with collect+deliver+spend', () => {
    var specs = [
      { requiredInteractions: ['collect:wood', 'deliver:base', 'deliver:forge', 'spend:gold'] },
    ];
    expect(cg.countEconLayers(specs)).toBe(2);
  });

  test('countControlModes walk+vehicle', () => {
    var specs = [
      { requiredInteractions: ['move_to:a', 'drive:car'] },
    ];
    expect(cg.countControlModes(specs)).toBe(2);
  });
});
