const assert = require('assert');
const { staticCheckProject } = require('../engine/static-check.cjs');

{
  const longCommentBlock = Array.from({ length: 80 }, (_, i) => '        // contract metadata line ' + i).join('\n');
  const code = [
    'public partial class GameFlowManagerMain',
    '{',
    '    // Phase init with long machine-readable contract comments.',
    '    void Phase_intro_Init()',
    '    {',
    longCommentBlock,
    '        PlaceObj(player, 0f, 0.6f, 0f);',
    '        SetGuideText("go");',
    '    }',
    '}',
  ].join('\n');
  const result = staticCheckProject(code, { extraFiles: {} });
  assert.ok(!result.issues.some(i => i.rule === 'method-too-long'), 'comment-only contract lines should not count as method length');
}

{
  const entityLines = Array.from({ length: 70 }, (_, i) => '        json += SerializeEntityStateJson(Entity' + i + ', Entity' + i + 'State);');
  const code = [
    'public partial class GameFlowManagerMain',
    '{',
    '    // Generated state exporter can grow with entity count.',
    '    string BuildEntityStatesJson()',
    '    {',
    '        string json = "{";',
    entityLines.join('\n'),
    '        return json + "}";',
    '    }',
    '}',
  ].join('\n');
  const result = staticCheckProject(code, { extraFiles: {} });
  assert.ok(!result.issues.some(i => i.rule === 'method-too-long'), 'generated entity state exporter should be exempt');
}

console.log('static-check method length tests passed');
