const assert = require('assert');

const localizer = require('../lib/csharp-comment-localizer.cjs');

const input = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour',
  '{',
  '    string url = "https://example.com/a//b"; // Dispatch the current phase directly to its dedicated tap handler.',
  '    // TODO_PHASE_1_INIT_START',
  '    // [SKELETON] Phase "intro" enter/init helper.',
  '    // [ASSEMBLY SLOT] ConveyorBelt::build_progress',
  '    // [ASSEMBLY PHASE] phaseId=intro',
  '    // ownerFile: GameFlowManagerMain.Flow.cs',
  '    // phaseEvidenceSchema: [{"signal":"guide_text_visible"}]',
  '    //     "signal": "guide_text_visible",',
  '    bool ok = true /* time-only beat (wait/defend) — timer gate is valid only before autoplay detect or after observer-ready activation */;',
  '    // TODO_PHASE_1_INIT_END',
  '}',
].join('\n');

const result = localizer.localizeCSharpComments(input);

assert.strictEqual(result.changed, true);
assert.match(result.code, /https:\/\/example\.com\/a\/\/b"; \/\/ 将当前阶段直接分发到专用点击处理器。/);
assert.match(result.code, /\/\/ TODO_PHASE_1_INIT_START/);
assert.match(result.code, /\/\/ \[SKELETON\] 阶段 "intro" 的进入\/初始化辅助方法。/);
assert.match(result.code, /\/\/ \[ASSEMBLY SLOT\] ConveyorBelt::build_progress/);
assert.match(result.code, /\/\/ \[ASSEMBLY PHASE\] phaseId=intro/);
assert.doesNotMatch(result.code, /\/\/ \[ASSEMBLY SLOT\] 装配槽/);
assert.match(result.code, /\/\/ ownerFile: GameFlowManagerMain\.Flow\.cs\s+\/\/ 所属文件/);
assert.match(result.code, /\/\/ phaseEvidenceSchema: \[\{"signal":"guide_text_visible"\}\]\s+\/\/ 阶段证据结构/);
assert.match(result.code, /\/\/\s+数据: "signal": "guide_text_visible",/);
assert.match(result.code, /\/\* 纯时间节拍（wait\/defend）：计时器门只在自动播放检测前或 observer-ready 激活后有效 \*\//);

console.log('csharp comment localizer tests passed');
