# Codex Tasks — Batch 2: Core Interaction Templates

8 templates targeting TODO_CUSTOM and TODO_UPDATE coverage.
All produce C# code fragments from schema data.

## Convention
- ES5 only: `var`, no `const`/`let`/arrow functions
- `module.exports = { fn1: fn1, fn2: fn2 };`
- `var { toLowerCamel } = require('../trigger-codegen.cjs');` where entity names needed
- Entity names are PascalCase, toLowerCamel is identity function (keeps PascalCase)
- Output: C# string fragments with proper indentation (8 spaces for Update body, 4 for variables)
- Use `escapeString()` for any user-provided text in C# string literals

## Tasks

### T1: collect-interaction.cjs
Generate resource collection loop: player near source → AddResource → set Done flag.

### T2: deliver-sell.cjs
Generate delivery/sell logic: player near target → TrySpend resources → AddGold → FloatingText.

### T3: cost-gated-click.cjs
Generate click+cost interaction: IsNear + click + gold check → spend → state change.

### T4: inventory-feedback.cjs
Generate inventory capacity check + guideText warning when full.

### T5: form-auto-switch.cjs
Generate entity-state-triggered SwitchForm calls.

### T6: score-display.cjs
Generate scoreText auto-update from gold/resource changes.

### T7: cta-handler.cjs
Generate CTA button click handler for final phase.

### T8: multi-source-collect.cjs
Generate collection from multiple same-type sources (e.g. SpaceJunk1/2/3).
