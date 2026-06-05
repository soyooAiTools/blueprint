const assert = require('assert');

const promptV4 = require('../worker/prompt-v4.js');
const promptV5 = require('../worker/prompt-v5-basetemplate.js');

const blueprint = {
  entities: [
    { name: 'IceBlock', chineseName: '冰块' },
    { name: 'BottlingMachine', chineseName: '装水机' },
  ],
  specs: [
    {
      phaseId: 'initialGuidance',
      phaseName: '初始需求引导',
      playerInstruction: '拖动角色采冰并售水',
      triggerNext: 'collect:water:1',
      entitiesRequired: [{ entity: 'IceBlock' }],
      requiredInteractions: ['collect:ice:1'],
    },
    {
      phaseId: 'sellWaterUpgradeWeapon',
      phaseName: '售水升级武器',
      goal: '卖水获取金币并升级钻头',
      triggerNext: 'upgrade:Drill:2',
      entitiesRequired: [{ entity: 'BottlingMachine' }],
      requiredInteractions: ['sell:water:1', 'upgrade:Drill:2'],
    },
  ],
};

const rules = promptV5.resolvePromptRules(blueprint);
assert.strictEqual(rules.length, 2, 'specs should be converted to prompt rules');
assert.strictEqual(rules[0].id, 'initialGuidance');
assert.strictEqual(rules[1].triggerCondition, null, 'later specs keep trigger derived from previous endCondition');
assert.deepStrictEqual(rules[0].activate, ['IceBlock']);

const v5Prompt = promptV5.parseBlueprintToPromptV5(blueprint);
assert(v5Prompt.includes('Rule initialGuidance: 初始需求引导'), 'v5 prompt should include spec phase name');
assert(v5Prompt.includes('拖动角色采冰并售水'), 'v5 prompt should include player instruction');
assert(v5Prompt.includes('collect:ice:1'), 'v5 prompt should include required interaction DSL');

const v4Prompt = promptV4.parseBlueprintToPromptV4(blueprint);
assert(v4Prompt.includes('Rule initialGuidance: 初始需求引导'), 'v4 prompt should include spec phase name');
assert(v4Prompt.includes('upgrade:Drill:2'), 'v4 prompt should include later required interaction DSL');

console.log('prompt-specs-fallback tests passed');
