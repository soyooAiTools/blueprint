# Assembly-First Registry Pack v1

**Date**: 2026-04-23  
**Status**: Draft — Companion to `2026-04-23-assembly-first-entity-module-spec.md`  
**Branch**: `spec/entity-assembly-pipeline`

---

## 1. 目的

这份文档把主 spec 里的抽象方案收敛成三张可执行注册表：

1. `StoryboardAtom registry`
2. `Runtime module registry`
3. `atom -> module -> CUA assertion` 映射表

目标不是一次性覆盖所有玩法，而是先定义一套 **与现有仓库命名、模板引擎、GFM runtime 能力兼容** 的 v1 词汇体系，作为后续实现和迁移的基础。

这份 registry pack 主要对齐以下现有资产：

- `worker/interaction-verbs.json`
- `adapters/templates/interactions/*`
- `adapters/templates/npc-behaviors/*`
- `worker/GFM_AutoPlay.cs`
- `worker/GFM_CameraController.cs`
- `engine/stages/method-check.cjs` 中的 skeleton-safe API 集

---

## 2. 设计原则

### 2.1 Atom 与 Module 必须分层

- `StoryboardAtom` 是分镜和交互语义层
- `Runtime module` 是运行时装配层

例如：

- `attack_target` 是 atom
- `target_acquire + projectile_emit + apply_damage` 是 module combo

### 2.2 v1 优先贴近现有实现资产

如果仓库已经有：

- interaction template
- npc behavior template
- GFM runtime helper
- skeleton-safe API

则优先沿用现有命名，不新发明术语。

### 2.3 只收高复用原子

分镜里很多修辞性描述不进入 registry。  
v1 只收满足这三个条件的原子：

1. 能稳定解析
2. 能映射到 runtime module
3. 能提供 CUA 可观察价值

### 2.4 每个 registry 条目都必须带验证信息

v1 的每个条目都至少要回答：

1. 输入参数是什么
2. 落到哪些 module
3. 会产生哪些 observable feedback
4. CUA 应该断言什么

---

## 3. 命名规范

### 3.1 StoryboardAtom 命名

- 使用 `snake_case`
- 用语义动作名，不带实现细节

例子：

- `move_to`
- `collect_nearby`
- `camera_lift`
- `show_floating_text`

### 3.2 Runtime module 命名

- 使用 `snake_case`
- 尽量体现运行时职责，而不是分镜描述

例子：

- `move_to_target`
- `collect_on_near`
- `projectile_emit`
- `guide_ui`

### 3.3 Archetype 命名

- 使用 `snake_case`
- 是 L2 组合，不是单能力

例子：

- `buildable_station`
- `basic_enemy`
- `tap_shooter`
- `carry_deliver_loop`

---

## 4. StoryboardAtom Registry v1

### 4.1 Interaction Atoms

| Atom | 参数 | 语义 | 主要映射 module | 主要 CUA 断言 | 对齐现有资产 |
|---|---|---|---|---|---|
| `move_to` | `actor,target,range?` | 角色移动到目标附近 | `player_input_joystick` / `move_to_target` / `proximity_trigger` | 角色位置变化；接近目标 | `interaction-verbs.move_to` |
| `tap_target` | `actor,target` | 点击目标 | `player_input_tap` / `click_trigger` | 点击后目标状态变化或反馈出现 | `interaction-verbs.click` |
| `drag_to_target` | `actor,from,to` | 把对象从 A 拖到 B | `drag_trigger` / `deliver_to_target` | 被拖动物体位移；目标进入完成态 | `interaction-verbs.drag` |
| `hold_target` | `actor,target,duration` | 长按目标 | `hold_trigger` | 长按持续到阈值；目标反馈出现 | `interaction-verbs.hold` |
| `collect_nearby` | `actor,target,item,count?` | 靠近后收集资源/物件 | `collect_on_near` / `inventory_wallet` | 资源增加；物体隐藏/移动 | `collect-interaction.cjs` |
| `deliver_to` | `actor,item,target` | 把物品送到建筑/卖点 | `deliver_to_target` / `inventory_wallet` / `score_feedback` | 资源减少；金币/分数增加；目标反馈 | `deliver-sell.cjs` |
| `spend_resource` | `resource,amount,target?` | 消耗资源执行动作 | `cost_gate` / `inventory_wallet` | 钱/资源减少；动作开始 | `interaction-verbs.spend` |
| `build_entity` | `actor,target` | 建造目标 | `build_progress` / `activate_targets` | 建造态推进；目标显现 | `interaction-verbs.build` |
| `upgrade_entity` | `actor,target,level?` | 升级目标 | `upgrade_progress` / `cost_gate` | 等级变化；外观或数值变化 | `interaction-verbs.upgrade` |
| `attack_target` | `actor,target,mode?` | 主动攻击目标 | `target_acquire` / `projectile_emit` / `apply_damage` | 攻击发生；目标受伤或死亡 | `interaction-verbs.attack` |
| `defeat_target` | `target` | 敌人被击败 | `damageable` / `on_death_drop` | hp 归零；目标消失/掉落 | `interaction-verbs.defeat` |
| `defend_duration` | `duration` | 防守持续一段时间 | `spawn_interval` / `damageable` / `phase_gate_timer` | 若干敌人刷出并被清掉/计时完成 | `interaction-verbs.defend` |

### 4.2 State Atoms

| Atom | 参数 | 语义 | 主要映射 module | 主要 CUA 断言 | 备注 |
|---|---|---|---|---|---|
| `activate_entity` | `entity` | 实体激活/出现 | `visual_binding` / `spawn_rule` | 实体进入视野 | 对应 `appear` |
| `deactivate_entity` | `entity` | 实体隐藏/移除 | `visual_binding` | 实体移出视野/隐藏位 | 对应 `disappear` |
| `set_state` | `entity,field,value` | 写业务状态 | `state_owner` dependent | 状态推进导致 phase 可达 | 必须受 `stateOwners` 约束 |
| `add_resource` | `resource,amount` | 增加资源 | `inventory_wallet` | UI/变量变化 | 对应 `AddResource` |
| `remove_resource` | `resource,amount` | 减少资源 | `inventory_wallet` | UI/变量变化 | 对应 `TrySpend` |
| `add_score` | `amount` | 增加得分/金币 | `score_feedback` / `inventory_wallet` | 飘字/scoreText 更新 | 对应 `AddGold` |
| `change_color` | `entity,variant` | 切换颜色/视觉态 | `visual_variant_swap` | 目标颜色/外观明显变化 | 不能默认 runtime 改材质 |
| `spawn_entity` | `entity,source?` | 刷出新实体 | `spawn_interval` / `spawn_once` | 新对象出现 | 对应 `Spawner` |
| `apply_damage` | `entity,amount` | 对实体造成伤害 | `damageable` | hp 下降/死亡 | 与 `attack_target` 分层 |
| `drop_loot` | `entity,item,count?` | 死亡或完成后掉落 | `on_death_drop` / `collectible_spawn` | 掉落物出现 | 对应 `onDeathDrop` |
| `switch_form` | `formId` | 切换玩家形态 | `form_switch` | 玩家外观/能力变化 | 对应 `form-auto-switch.cjs` |

### 4.3 Presentation Atoms

| Atom | 参数 | 语义 | 主要映射 module | 主要 CUA 断言 | 对齐现有资产 |
|---|---|---|---|---|---|
| `camera_focus` | `target` | 镜头看向目标 | `camera_focus` | 目标保持在画面中心/主视野 | `GFM_CameraController.LookAt()` |
| `camera_lift` | `amount,duration` | 镜头抬高/拉远 | `camera_lift` | 视野抬升或可见范围扩大 | 需扩展 camera runtime |
| `camera_zoom` | `value,duration` | 镜头缩放 | `camera_zoom` | orthographicSize/等效视野变化 | 需扩展 camera runtime |
| `highlight_target` | `target,style?` | 高亮目标 | `highlight_target` | 目标被圈出/描边/闪烁 | 默认走 UI overlay 或 variant |
| `show_guide` | `text` | 显示引导文案 | `guide_ui` | guideText 出现/变化 | 对应 skeleton `guideText` |
| `show_floating_text` | `text,color?,anchor?` | 飘字反馈 | `floating_text_feedback` | 飘字出现 | 对应 `ShowFloatingText` |
| `show_score_feedback` | `amount,label?` | 分数/金币反馈 | `score_feedback` | scoreText 变化 | 对应 `score-display.cjs` |
| `play_pop_animation` | `target,intensity?` | 弹出/缩放反馈 | `pop_animation` | 目标位置/scale 有明显变化 | 可用可见位移替代 |
| `show_world_label` | `target,text` | 头顶标签/世界标签 | `world_label` | 标签可见 | 对应 `GFM_Billboard` |

### 4.4 暂不纳入 v1 的原子

这些能力先不进 v1 registry：

- 复杂镜头运动（轨道、摇臂、转场剪辑）
- 多目标群体战术命令
- 高级粒子/后处理表现
- 需要复杂骨骼动画的表演

原因：

- 当前 runtime 没有稳定承接
- CUA 也难以稳定断言

---

## 5. Runtime Module Registry v1

### 5.1 Core Interaction / State Modules

| Module | 层级 | 主要参数 | 写入状态 | owner file | autoplay | 主要 observable |
|---|---|---|---|---|---|---|
| `visual_binding` | L1 | `pool,position,scale,spawnStyle` | `<entity>.visibleState` | `Scene.cs` | N/A | 实体显示/隐藏/位置变化 |
| `player_input_joystick` | L1 | `speed` | `player.position` | `Input.cs` | mirrored | 玩家移动 |
| `player_input_tap` | L1 | `raycastLayer?` | `input.tapState` | `Input.cs` | mirrored | 点击触发 |
| `move_to_target` | L1 | `target,speed,stopRange` | `<entity>.position` | `Flow.cs` | yes | 目标移动 |
| `proximity_trigger` | L1 | `target,radius` | `<entity>.triggered` | `Flow.cs` | yes | 接近后触发 |
| `click_trigger` | L1 | `target` | `<entity>.clicked` | `Input.cs` | mirrored | 点击后触发 |
| `drag_trigger` | L1 | `from,to,dropRadius` | `<entity>.dragState` | `Input.cs` | limited | 拖拽物体移动 |
| `hold_trigger` | L1 | `target,duration` | `<entity>.holdState` | `Input.cs` | mirrored | 长按持续到阈值 |
| `cost_gate` | L1 | `resource,amount` | `economy.*` | `Resource.cs` | yes | 资源减少 |
| `inventory_wallet` | L1 | `resourceKinds[]` | `economy.*` | `Resource.cs` | yes | 库存/金币变化 |
| `build_progress` | L1 | `buildTime` | `<entity>.buildState, <entity>.buildTimer` | `Flow.cs` | yes | 建造态变化 |
| `upgrade_progress` | L1 | `levels,costs` | `<entity>.upgradeLevel` | `Flow.cs` | yes | 等级变化 |
| `collect_on_near` | L1 | `resource,item,count,range` | `economy.*` | `Resource.cs` | yes | 资源增长；采集物隐藏 |
| `deliver_to_target` | L1 | `resource,target,reward` | `economy.*` | `Resource.cs` | yes | 资源减少；金币增加 |
| `spawn_once` | L1 | `entity,position` | `<entity>.spawnState` | `Scene.cs` | yes | 新对象出现 |
| `spawn_interval` | L1 | `entity,interval,maxAlive,position` | `spawn.*` | `Flow.cs` | yes | 定时刷怪/刷物 |
| `target_acquire` | L1 | `targetTag,range` | `<entity>.currentTarget` | `Flow.cs` | yes | 目标锁定 |
| `projectile_emit` | L1 | `projectile,speed,damage,cooldown` | `projectile.*` | `Flow.cs` | yes | 投射物出现并移动 |
| `cooldown` | L1 | `seconds` | `<entity>.cooldownTimer` | `Flow.cs` | yes | 冷却节奏 |
| `damageable` | L1 | `hp,maxHp?` | `<entity>.hp` | `Flow.cs` | yes | 受击/死亡 |
| `apply_damage` | L1 | `amount,source?` | `<entity>.hp` | `Flow.cs` | yes | hp 变化 |
| `on_death_drop` | L1 | `item,count` | `<entity>.deathState` | `Flow.cs` | yes | 掉落物出现 |
| `activate_targets` | L1 | `targets[]` | `<target>.visibleState` | `Flow.cs` | yes | 下游实体被激活 |
| `form_switch` | L1 | `formId` | `player.formId` | `Flow.cs` | yes | 玩家形态变化 |
| `phase_gate_timer` | L1 | `seconds` | `phase.timerState` | `Flow.cs` | yes | 时间门推进 |
| `cta_finish` | L1 | `target?` | `game.endState` | `UI.cs` | yes | CTA 出现 |

### 5.2 Presentation Modules

| Module | 层级 | 主要参数 | owner file | autoplay | observable | 对齐现有资产 |
|---|---|---|---|---|---|---|
| `guide_ui` | L1 | `text` | `UI.cs` | yes | guideText 更新 | skeleton `guideText` |
| `floating_text_feedback` | L1 | `text,color,anchor` | `UI.cs` | yes | 飘字出现 | `ShowFloatingText` |
| `score_feedback` | L1 | `resource,label?` | `UI.cs` | yes | scoreText 更新 | `score-display.cjs` |
| `world_label` | L1 | `text,target` | `UI.cs` | N/A | 世界标签可见 | `GFM_Billboard` |
| `camera_focus` | L1 | `target` | `Scene.cs` or `Flow.cs` | yes | 镜头看向目标 | `GFM_CameraController.LookAt()` |
| `camera_lift` | L1 | `amount,duration` | `Scene.cs` or `Flow.cs` | yes | 视野抬升 | 需扩展 `GFM_CameraController` |
| `camera_zoom` | L1 | `value,duration` | `Scene.cs` or `Flow.cs` | yes | 镜头缩放 | 需扩展 `GFM_CameraController` |
| `highlight_target` | L1 | `target,style` | `UI.cs` | yes | 圈选/闪烁/高亮 | 默认不直接改材质 |
| `visual_variant_swap` | L1 | `entity,variantId` | `Scene.cs` | yes | 外观明显切换 | 走 pool variant/object swap |
| `pop_animation` | L1 | `target,intensity,duration` | `Flow.cs` | yes | scale/position 产生可见变化 | 可用最小位移替代 |

### 5.3 Archetypes v1

| Archetype | 组合 modules | 说明 |
|---|---|---|
| `buildable_station` | `visual_binding + proximity_trigger/click_trigger + cost_gate + build_progress + activate_targets` | 建造型建筑 |
| `collectible_pickup` | `visual_binding + collect_on_near` | 靠近采集物 |
| `carry_deliver_loop` | `collect_on_near + inventory_wallet + deliver_to_target + score_feedback` | 搬运/售卖闭环 |
| `tap_shooter` | `click_trigger + target_acquire + projectile_emit + cooldown` | 点击触发射击点 |
| `basic_enemy` | `visual_binding + move_to_target + damageable + on_death_drop` | 常规敌人 |
| `enemy_spawner` | `spawn_interval + activate_targets?` | 刷怪点 |
| `upgradeable_building` | `click_trigger + cost_gate + upgrade_progress + visual_variant_swap` | 升级建筑 |
| `cta_terminal` | `guide_ui + cta_finish` | 收尾 CTA |

### 5.4 模块与现有仓库对齐关系

| 当前资产 | 对应 v1 模块 |
|---|---|
| `collect-interaction.cjs` | `collect_on_near` |
| `deliver-sell.cjs` | `deliver_to_target + score_feedback` |
| `cost-gated-click.cjs` | `click_trigger + cost_gate + upgrade_progress/build_progress` |
| `inventory-feedback.cjs` | `inventory_wallet + floating_text_feedback` |
| `score-display.cjs` | `score_feedback` |
| `cta-handler.cjs` | `cta_finish` |
| `npc-behaviors/spawner.cjs` | `spawn_interval` |
| `npc-behaviors/chase-attack.cjs` | `move_to_target + target_acquire + apply_damage + damageable` |
| `npc-behaviors/ranged-shooter.cjs` | `target_acquire + projectile_emit + cooldown + damageable` |
| `GFM_AutoPlay` | autoplay mirror contract carrier |
| `GFM_CameraController` | `camera_focus` 的现有最小实现基础 |

---

## 6. Atom -> Module -> CUA Assertion Mapping v1

### 6.1 基础映射表

| Atom | Module Combo | Required Signals | CUA Assertions |
|---|---|---|---|
| `move_to` | `player_input_joystick` or `move_to_target` | 位置变化、接近目标 | `player_position_changed`, `distance_to_target_below_threshold` |
| `tap_target` | `player_input_tap + click_trigger` | 点击命中、目标进入 clicked/done | `tap_registered`, `target_state_changed` |
| `drag_to_target` | `drag_trigger + deliver_to_target` | 被拖物体移动、目标接收 | `drag_path_completed`, `target_received_item` |
| `collect_nearby` | `collect_on_near + inventory_wallet` | 资源增加、物体隐藏 | `resource_incremented`, `source_hidden_or_moved` |
| `deliver_to` | `deliver_to_target + inventory_wallet + score_feedback` | 库存减少、奖励增加、反馈出现 | `inventory_decremented`, `reward_incremented`, `floating_or_score_feedback_visible` |
| `build_entity` | `cost_gate + build_progress + activate_targets` | 扣费、建造态推进、下游激活 | `resource_decremented`, `entity_state_equals_built`, `downstream_entity_visible` |
| `upgrade_entity` | `click_trigger + cost_gate + upgrade_progress + visual_variant_swap` | 扣费、等级上升、外观变化 | `resource_decremented`, `upgrade_level_changed`, `visual_variant_changed` |
| `attack_target` | `target_acquire + projectile_emit + apply_damage` | 发射物、受击 | `projectile_visible`, `target_hp_decreased_or_target_dead` |
| `defeat_target` | `damageable + on_death_drop` | 死亡、掉落 | `target_removed_or_hidden`, `loot_visible` |
| `camera_focus` | `camera_focus` | 镜头看向目标 | `target_remains_in_view`, `camera_orientation_changed` |
| `camera_lift` | `camera_lift` | 视野抬升 | `camera_height_changed_or_view_widened` |
| `camera_zoom` | `camera_zoom` | 视野缩放 | `camera_zoom_changed` |
| `highlight_target` | `highlight_target` | 高亮显示 | `highlight_overlay_visible` |
| `show_guide` | `guide_ui` | guide 更新 | `guide_text_visible` |
| `show_floating_text` | `floating_text_feedback` | 飘字出现 | `floating_text_visible` |
| `change_color` | `visual_variant_swap` | 外观切换 | `visual_variant_changed` |

### 6.2 CUA Assertion Vocabulary v1

建议统一以下 assertion ID，供 `CUAPlan` 使用：

| Assertion ID | 含义 |
|---|---|
| `player_position_changed` | 玩家位置发生变化 |
| `distance_to_target_below_threshold` | 玩家与目标距离进入阈值 |
| `tap_registered` | 一次点击被系统接受 |
| `drag_path_completed` | 拖拽从起点到终点完成 |
| `resource_incremented` | 指定资源增加 |
| `resource_decremented` | 指定资源减少 |
| `inventory_decremented` | 背包/库存减少 |
| `reward_incremented` | 奖励/金币/分数增加 |
| `entity_state_changed` | 指定状态字段变化 |
| `entity_state_equals_built` | 构建态达到 built |
| `upgrade_level_changed` | 升级等级变化 |
| `target_hp_decreased_or_target_dead` | 血量下降或目标死亡 |
| `target_removed_or_hidden` | 目标被隐藏或移出 |
| `source_hidden_or_moved` | 源对象被隐藏或明显位移 |
| `downstream_entity_visible` | 下游实体出现 |
| `projectile_visible` | 投射物出现 |
| `loot_visible` | 掉落物可见 |
| `guide_text_visible` | guide 文案可见 |
| `floating_text_visible` | 飘字可见 |
| `score_text_changed` | 分数文本发生变化 |
| `highlight_overlay_visible` | 高亮/圈选层可见 |
| `visual_variant_changed` | 对象外观版本发生切换 |
| `camera_orientation_changed` | 相机朝向发生变化 |
| `camera_height_changed_or_view_widened` | 相机抬高或视野明显扩大 |
| `camera_zoom_changed` | 镜头缩放发生变化 |
| `phase_advanced` | phase 成功推进 |

### 6.3 每个 Module 需要补充的 CUA 元数据

建议每个 runtime module 在 registry 中新增：

```json
{
  "type": "collect_on_near",
  "affordances": ["approach_target"],
  "expectedSignals": ["resource_incremented", "source_hidden_or_moved"],
  "observableFeedback": ["target_hidden", "score_or_floating_feedback"],
  "autoplayMirror": "supported",
  "failureFingerprints": [
    "resource_not_incremented",
    "collect_source_not_hidden",
    "phase_not_advanced_after_collect"
  ]
}
```

这样 CUA 就可以：

- 根据 `affordances` 生成动作
- 根据 `expectedSignals` 和 `observableFeedback` 做断言
- 根据 `failureFingerprints` 做更稳定的归因

---

## 7. 数据结构建议

### 7.1 Registry Manifest

建议最终 registry 在项目内以 manifest 形式落盘：

```json
{
  "version": "registry-pack-v1",
  "storyboardAtoms": [],
  "runtimeModules": [],
  "archetypes": [],
  "assertions": [],
  "mappings": []
}
```

### 7.2 Project Plan References

各 plan 只引用 registry id，不内嵌重复定义：

```json
{
  "storyboardAtomPlan": {
    "beats": [
      {
        "interactionAtoms": [
          { "type": "move_to", "target": "ConveyorBeltGhost" }
        ]
      }
    ]
  },
  "entityPlan": {
    "entities": [
      {
        "archetype": "buildable_station",
        "modules": [
          { "type": "build_progress", "params": { "buildTime": 1.5 } }
        ]
      }
    ]
  }
}
```

---

## 8. v1 边界与待补项

### 8.1 v1 明确覆盖

- 收集
- 交付/售卖
- 建造
- 升级
- 简单点击触发
- 简单近战/远程攻击
- 刷怪
- 死亡掉落
- guide / 飘字 / score / 高亮
- 相机对准 / 抬高 / 缩放
- CTA 收尾

### 8.2 v1 不承诺

- 多编队战术控制
- 真拖尾弹道 / 复杂曲线投射
- 复杂过场镜头
- 动画树级别角色表演
- 高级 shader/材质特效

### 8.3 v1 最大实现风险

风险最高的 3 个点：

1. `change_color`
   - 当前 Luna 规则限制下不能默认走材质改色
2. `camera_lift / camera_zoom`
   - 当前 `GFM_CameraController` 只有最小 `LookAt` 能力，需要扩 runtime API
3. `drag_to_target`
   - 当前模板基础存在，但还没被显式抽成稳定模块合同

---

## 9. 建议下一步

当前已经落成的机器可读文件：

1. `adapters/schema/assembly-registry-v1/storyboard-atoms.v1.json`
2. `adapters/schema/assembly-registry-v1/runtime-modules.v1.json`
3. `adapters/schema/assembly-registry-v1/atom-module-mapping.v1.json`
4. `adapters/schema/assembly-registry-v1/cua-assertions.v1.json`
5. `adapters/schema/assembly-registry-v1/registry-pack.v1.json`

然后再依次做：

1. parser 输出 `StoryboardAtomPlan`
2. validator 校验 atom/module/mapping
3. emitter 按 mapping 装配
4. PlayableAgent 改成消费 `CUAPlan`

这样 implementation 才不会在命名和边界上反复返工。
