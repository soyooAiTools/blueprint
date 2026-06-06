const assert = require('assert');
const codegenSchema = require('../engine/stages/codegen-schema.cjs');
const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');
const templateEngine = require('../adapters/codegen-template-engine.cjs');

const sourceSpecs = [
  {
    phaseId: 'chapterOne',
    phaseName: 'Chapter One',
    duration: { min: 10, max: 15 },
    requiredInteractions: ['click:Player'],
    entitiesRequired: [{ name: 'Player', terminalState: 1 }],
    triggerNext: { condition: 'chapterOne_complete', description: '' },
  },
  {
    phaseId: 'chapterTwo',
    phaseName: 'Chapter Two',
    duration: { min: 10, max: 15 },
    requiredInteractions: ['click:Target'],
    entitiesRequired: [{ name: 'Target', terminalState: 1 }],
    triggerNext: { condition: 'chapterTwo_complete', description: '' },
  },
];

const schema = {
  gameConfig: {
    cameraBackground: [0.45, 0.52, 0.62],
    groundColor: [0.75, 0.78, 0.82],
    moveSpeed: 5,
    collectRange: 2,
    maxCarry: 3,
  },
  entities: [
    { name: 'Player', chineseName: '玩家', showLabel: false, pool: '__Pool_Human_Male_01', initPos: [0, 0, 0], scale: 0.6 },
    { name: 'Target', chineseName: '目标', showLabel: true, pool: '__Pool_Item_Box_01', initPos: [2, 0, 0], scale: 0.7 },
    { name: 'CtaButton', chineseName: '按钮', showLabel: false, pool: '__Pool_Item_Gem_01', initPos: [4, 0, 0], scale: 0.7 },
  ],
  resources: [],
  npcs: [],
  phases: [
    { phaseId: 'phase1', showEntities: ['Player', 'Target'], trigger: { type: 'near_entity', entity: 'Target', range: 2 } },
    { phaseId: 'phase2', showEntities: ['Player', 'Target'], trigger: { type: 'click_entity', entity: 'Target' } },
    { phaseId: 'phase3', showEntities: ['Player', 'Target'], trigger: { type: 'near_entity', entity: 'Target', range: 2 } },
    { phaseId: 'phase4', showEntities: ['Player', 'Target'], trigger: { type: 'resource_collected', resource: 'Gold', amount: 1 } },
    { phaseId: 'phase5', showEntities: ['Player', 'CtaButton'], trigger: { type: 'near_entity', entity: 'CtaButton', range: 2 } },
  ],
};

const expanded = codegenSchema._buildSkeletonSpecsForSchema({ specs: sourceSpecs }, schema);
assert.strictEqual(expanded.length, 5);
assert.deepStrictEqual(expanded.map((spec) => spec.phaseId), ['phase1', 'phase2', 'phase3', 'phase4', 'phase5']);
assert.deepStrictEqual(expanded[0].requiredInteractions, ['move_to:Target']);
assert.deepStrictEqual(expanded[1].requiredInteractions, ['click:Target']);

const skeleton = generateSkeleton(expanded, { w1bSplit: true, entities: schema.entities });
assert.strictEqual(skeleton.mode, 'w1b-5partial');
assert.strictEqual((skeleton.flow.match(/TODO_PHASE_\d+_INIT_START/g) || []).length, 5);

const mainFill = templateEngine.fillSkeleton(schema, skeleton.main, { w1bSplit: true });
const flowFill = templateEngine.fillSkeleton(schema, skeleton.flow, { w1bSplit: true });
const combinedMissing = (mainFill.missingMarkers || [])
  .filter((marker) => !/^TODO_PHASE_\d+_INIT$/.test(marker))
  .concat(flowFill.missingMarkers || []);
assert.deepStrictEqual(combinedMissing, []);

const unsafeSchema = JSON.parse(JSON.stringify(schema));
unsafeSchema.phases[3].phaseId = '拖拽扩建_第二房间';
unsafeSchema.phases[4].phaseId = '章节完成_基地扩大';
const unsafeBlueprint = {
  specs: [
    { phaseId: 'phase1', requiredInteractions: [] },
    { phaseId: '拖拽扩建_第二房间', requiredInteractions: [] },
  ],
  plans: {
    cuaPlan: {
      steps: [
        { phaseId: '拖拽扩建_第二房间' },
        { phaseId: '章节完成_基地扩大' },
      ],
    },
    assemblyPlan: {
      phaseBindings: [
        { phaseId: '拖拽扩建_第二房间' },
        { phaseId: '章节完成_基地扩大' },
      ],
    },
    storyboardAtomPlan: {
      unresolved: [
        { phaseId: '章节完成_基地扩大' },
      ],
    },
  },
};
const unsafeCtx = { blueprint: unsafeBlueprint, addLog: function() {} };
const normalization = codegenSchema._normalizeSchemaPhaseIdsForCodegen(unsafeCtx, unsafeSchema);
assert.strictEqual(normalization.count, 2);
assert.deepStrictEqual(unsafeSchema.phases.map((phase) => phase.phaseId), ['phase1', 'phase2', 'phase3', 'phase4', 'phase5']);
assert.strictEqual(unsafeBlueprint.specs[1].phaseId, 'phase4');
assert.strictEqual(unsafeBlueprint.plans.cuaPlan.steps[0].phaseId, 'phase4');
assert.strictEqual(unsafeBlueprint.plans.cuaPlan.steps[1].phaseId, 'phase5');
assert.strictEqual(unsafeBlueprint.plans.assemblyPlan.phaseBindings[0].phaseId, 'phase4');
assert.strictEqual(unsafeBlueprint.plans.storyboardAtomPlan.unresolved[0].phaseId, 'phase5');

const unsafeExpanded = codegenSchema._buildSkeletonSpecsForSchema(unsafeBlueprint, unsafeSchema);
assert.deepStrictEqual(unsafeExpanded.map((spec) => spec.phaseId), ['phase1', 'phase2', 'phase3', 'phase4', 'phase5']);
assert.ok(unsafeExpanded.every((spec) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.phaseId)));
assert.deepStrictEqual(unsafeExpanded[0].duration, { min: 10, max: 15 });

const sameLengthSpecsWithoutDuration = {
  specs: unsafeSchema.phases.map((phase) => ({ phaseId: phase.phaseId, requiredInteractions: [] })),
};
const sameLengthExpanded = codegenSchema._buildSkeletonSpecsForSchema(sameLengthSpecsWithoutDuration, unsafeSchema);
assert.strictEqual(sameLengthExpanded.length, 5);
assert.ok(sameLengthExpanded.every((spec) => spec.duration && typeof spec.duration.min === 'number' && typeof spec.duration.max === 'number'));

console.log('codegen-schema skeleton spec expansion tests passed');
