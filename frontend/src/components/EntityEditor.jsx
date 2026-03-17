import { useState } from 'react';

const COLOR_PRESETS = [
  { label: 'Player 蓝色', value: '(0.2,0.4,0.9)' },
  { label: 'Ground 棕色', value: '(0.35,0.25,0.15)' },
  { label: 'Buildings 棕色', value: '(0.85,0.7,0.4)' },
  { label: 'Enemies 红色', value: '(0.85,0.15,0.15)' },
  { label: 'Trees 绿色', value: '(0.1,0.55,0.1)' },
  { label: 'Turrets 灰色', value: '(0.5,0.5,0.55)' },
  { label: 'Wood 木色', value: '(0.6,0.35,0.1)' },
  { label: 'Workers 橙色', value: '(0.9,0.6,0.2)' },
  { label: 'Gold 金色', value: '(1,0.85,0)' },
];

const SHAPE_OPTIONS = ['Cube', 'Sphere', 'Cylinder', 'Ground', 'UI'];

const TEMPLATE_OPTIONS = [
  { value: 'Static', label: '🌲 静态装饰', desc: '无行为' },
  { value: 'PlayerController', label: '🧍 玩家控制', desc: '摇杆移动' },
  { value: 'Buildable', label: '🔨 可建造', desc: '靠近/点击→扣资源→建造' },
  { value: 'Shooter', label: '🏹 射击', desc: '自动/点击射击' },
  { value: 'Mover', label: '🚶 移动者', desc: '朝目标移动' },
  { value: 'Mover+Damageable', label: '👹 敌人', desc: '移动+有血量' },
  { value: 'Spawner', label: '♻️ 生成器', desc: '定时生成子实体' },
  { value: 'Collectible', label: '💰 可拾取', desc: '靠近自动拾取' },
  { value: 'Draggable', label: '✋ 可拖拽', desc: '拖到目标位置' },
  { value: 'Damageable', label: '❤️ 可受伤', desc: '有血量' },
  { value: 'Upgradeable', label: '⬆️ 可升级', desc: '点击→扣资源→升级' },
  { value: 'Buildable+Shooter', label: '🏗️🏹 建造+射击', desc: '建好后自动射击' },
  { value: 'Projectile', label: '🎯 弹药', desc: '飞行+命中检测' },
  { value: 'UI', label: '💬 UI元素', desc: 'HUD/血条等' },
];

const TRIGGER_OPTIONS = [
  { value: 'none', label: '无触发' },
  { value: 'proximity', label: '靠近触发' },
  { value: 'click', label: '点击触发' },
  { value: 'drag', label: '拖拽' },
  { value: 'auto', label: '自动' },
  { value: 'timer', label: '定时器' },
  { value: 'event', label: '事件条件' },
];

const SPAWN_STYLE_OPTIONS = [
  { value: 'instant', label: '立即' },
  { value: 'fadeIn', label: '淡入' },
  { value: 'popUp', label: '弹出' },
  { value: 'blueprint', label: '蓝图(半透明)' },
];

function ColorSwatch({ color }) {
  const m = (color || '').match(/\(?([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\)?/);
  const bg = m ? `rgb(${Math.round(m[1]*255)},${Math.round(m[2]*255)},${Math.round(m[3]*255)})` : '#666';
  return <span className="props-color-swatch" style={{ background: bg }} />;
}

// 根据模板类型返回该模板特有的行为字段
function getBehaviorFields(template) {
  const t = template || 'Static';
  const fields = [];
  if (t.includes('PlayerController')) {
    fields.push({ key: 'moveSpeed', label: '移动速度', type: 'number', default: 5 });
  }
  if (t.includes('Buildable')) {
    fields.push({ key: 'buildTime', label: '建造时间(秒)', type: 'number', default: 1.5 });
  }
  if (t.includes('Shooter')) {
    fields.push({ key: 'fireRate', label: '射击间隔(秒)', type: 'number', default: 1.5 });
    fields.push({ key: 'projectile', label: '弹药实体名', type: 'text', default: 'Arrow' });
    fields.push({ key: 'damage', label: '伤害', type: 'number', default: 1 });
    fields.push({ key: 'range', label: '射程', type: 'number', default: 10 });
    fields.push({ key: 'targetTag', label: '目标标签', type: 'text', default: 'enemy' });
    fields.push({ key: 'autoFire', label: '自动射击', type: 'checkbox', default: false });
  }
  if (t.includes('Mover')) {
    fields.push({ key: 'moveSpeed', label: '移动速度', type: 'number', default: 2 });
    fields.push({ key: 'moveTarget', label: '移动目标实体', type: 'text', default: '' });
  }
  if (t.includes('Damageable')) {
    fields.push({ key: 'hp', label: '生命值', type: 'number', default: 3 });
  }
  if (t.includes('Spawner')) {
    fields.push({ key: 'spawnEntity', label: '生成实体名', type: 'text', default: '' });
    fields.push({ key: 'spawnInterval', label: '生成间隔(秒)', type: 'number', default: 3 });
    fields.push({ key: 'spawnPosition', label: '生成位置', type: 'text', default: '' });
    fields.push({ key: 'maxAlive', label: '最大存活数', type: 'number', default: 5 });
  }
  if (t.includes('Collectible')) {
    fields.push({ key: 'collectRadius', label: '拾取距离', type: 'number', default: 1.5 });
    fields.push({ key: 'rewardType', label: '奖励资源', type: 'text', default: 'gold' });
    fields.push({ key: 'rewardAmount', label: '奖励数量', type: 'number', default: 1 });
  }
  if (t.includes('Draggable')) {
    fields.push({ key: 'dropTarget', label: '放置目标实体', type: 'text', default: '' });
    fields.push({ key: 'dropRadius', label: '放置半径', type: 'number', default: 2 });
  }
  if (t.includes('Projectile')) {
    fields.push({ key: 'speed', label: '飞行速度', type: 'number', default: 12 });
    fields.push({ key: 'lifetime', label: '存活时间(秒)', type: 'number', default: 3 });
  }
  if (t.includes('Upgradeable')) {
    fields.push({ key: 'upgradeCost', label: '升级花费', type: 'text', default: 'gold:10' });
  }
  // 去重 (Mover+Damageable 都有 moveSpeed)
  const seen = new Set();
  return fields.filter(f => { if (seen.has(f.key)) return false; seen.add(f.key); return true; });
}

export default function EntityEditor({ entities, onChangeEntities, allEntityNames }) {
  const [expandedIdx, setExpandedIdx] = useState(-1);

  const addEntity = () => {
    onChangeEntities([...entities, {
      name: '', label: '', template: 'Static',
      visual: { shape: 'Cube', scale: '1×1×1', color: '', position: '' },
      spawn: { condition: 'phase:1', style: 'instant' },
      trigger: { type: 'none', params: {}, once: false },
      behavior: {},
      actions: [],
    }]);
    setExpandedIdx(entities.length);
  };

  const removeEntity = (i) => {
    const arr = [...entities]; arr.splice(i, 1); onChangeEntities(arr);
    if (expandedIdx === i) setExpandedIdx(-1);
    else if (expandedIdx > i) setExpandedIdx(expandedIdx - 1);
  };

  const updateEntity = (i, updates) => {
    const arr = [...entities];
    arr[i] = { ...arr[i], ...updates };
    onChangeEntities(arr);
  };

  const updateVisual = (i, field, value) => {
    const arr = [...entities];
    arr[i] = { ...arr[i], visual: { ...arr[i].visual, [field]: value } };
    onChangeEntities(arr);
  };

  const updateSpawn = (i, field, value) => {
    const arr = [...entities];
    arr[i] = { ...arr[i], spawn: { ...arr[i].spawn, [field]: value } };
    onChangeEntities(arr);
  };

  const updateTrigger = (i, field, value) => {
    const arr = [...entities];
    const trigger = { ...arr[i].trigger, [field]: value };
    if (field === 'type') trigger.params = {};
    arr[i] = { ...arr[i], trigger };
    onChangeEntities(arr);
  };

  const updateTriggerParam = (i, key, value) => {
    const arr = [...entities];
    arr[i] = { ...arr[i], trigger: { ...arr[i].trigger, params: { ...arr[i].trigger.params, [key]: value } } };
    onChangeEntities(arr);
  };

  const updateBehavior = (i, key, value) => {
    const arr = [...entities];
    arr[i] = { ...arr[i], behavior: { ...arr[i].behavior, [key]: value } };
    onChangeEntities(arr);
  };

  const templateLabel = (t) => TEMPLATE_OPTIONS.find(o => o.value === t)?.label || t;

  return (
    <div className="props-registry">
      <div className="props-divider">🎭 实体清单 ({entities.length})</div>
      <div className="props-hint">每个实体定义外观、行为模板、触发条件和动作</div>

      {entities.map((ent, i) => {
        const isExpanded = expandedIdx === i;
        const tpl = ent.template || 'Static';
        const behaviorFields = getBehaviorFields(tpl);

        return (
          <div key={i} className={`entity-item ${isExpanded ? 'entity-item-expanded' : ''}`}>
            {/* 折叠头 */}
            <div className="entity-header" onClick={() => setExpandedIdx(isExpanded ? -1 : i)}>
              <span className="entity-expand-icon">{isExpanded ? '▼' : '▶'}</span>
              <ColorSwatch color={ent.visual?.color} />
              <span className="entity-name">{ent.name || '(未命名)'}</span>
              {ent.label && <span className="entity-label">({ent.label})</span>}
              <span className="entity-template-badge">{templateLabel(tpl)}</span>
              <button className="props-registry-remove" onClick={(e) => { e.stopPropagation(); removeEntity(i); }}>✕</button>
            </div>

            {isExpanded && (
              <div className="entity-body">
                {/* 基础 */}
                <div className="entity-section">
                  <div className="entity-section-title">基础</div>
                  <div className="entity-row">
                    <input className="props-input props-input-sm" value={ent.name} onChange={(e) => updateEntity(i, { name: e.target.value })} placeholder="英文名" />
                    <input className="props-input props-input-sm" value={ent.label || ''} onChange={(e) => updateEntity(i, { label: e.target.value })} placeholder="中文名" />
                  </div>
                  <select className="props-input" value={tpl} onChange={(e) => updateEntity(i, { template: e.target.value })}>
                    {TEMPLATE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>)}
                  </select>
                </div>

                {/* 外观 */}
                {tpl !== 'Spawner' && (
                  <div className="entity-section">
                    <div className="entity-section-title">外观</div>
                    <div className="entity-row">
                      <select className="props-input props-input-sm" value={ent.visual?.shape || 'Cube'} onChange={(e) => updateVisual(i, 'shape', e.target.value)}>
                        {SHAPE_OPTIONS.map(s => <option key={s}>{s}</option>)}
                      </select>
                      <input className="props-input props-input-sm" value={ent.visual?.scale || ''} onChange={(e) => updateVisual(i, 'scale', e.target.value)} placeholder="尺寸 1×2×1" />
                    </div>
                    <div className="entity-row">
                      <ColorSwatch color={ent.visual?.color} />
                      <input className="props-input props-input-sm" value={ent.visual?.color || ''} onChange={(e) => updateVisual(i, 'color', e.target.value)} placeholder="颜色 (r,g,b)" />
                      <select className="props-color-preset" value="" onChange={(e) => { if (e.target.value) updateVisual(i, 'color', e.target.value); }}>
                        <option value="">预设</option>
                        {COLOR_PRESETS.map(c => <option key={c.label} value={c.value}>{c.label}</option>)}
                      </select>
                    </div>
                    <input className="props-input" value={ent.visual?.position || ''} onChange={(e) => updateVisual(i, 'position', e.target.value)} placeholder="位置 (x,y,z)" />
                  </div>
                )}

                {/* 出生条件 */}
                <div className="entity-section">
                  <div className="entity-section-title">出生条件</div>
                  <input className="props-input" value={ent.spawn?.condition || ''} onChange={(e) => updateSpawn(i, 'condition', e.target.value)} placeholder="phase:1 或 entity:X.state==built 或 runtime" />
                  <select className="props-input props-input-sm" value={ent.spawn?.style || 'instant'} onChange={(e) => updateSpawn(i, 'style', e.target.value)}>
                    {SPAWN_STYLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>

                {/* 触发条件 */}
                {tpl !== 'Static' && tpl !== 'Spawner' && (
                  <div className="entity-section">
                    <div className="entity-section-title">触发条件</div>
                    <select className="props-input" value={ent.trigger?.type || 'none'} onChange={(e) => updateTrigger(i, 'type', e.target.value)}>
                      {TRIGGER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {ent.trigger?.type === 'proximity' && (
                      <div className="entity-row">
                        <input className="props-input props-input-sm" type="number" value={ent.trigger.params?.radius || 2} onChange={(e) => updateTriggerParam(i, 'radius', parseFloat(e.target.value))} placeholder="距离" />
                        <input className="props-input props-input-sm" value={ent.trigger.params?.cost ? JSON.stringify(ent.trigger.params.cost) : ''} onChange={(e) => { try { updateTriggerParam(i, 'cost', JSON.parse(e.target.value)); } catch(ex) {} }} placeholder='消耗 {"gold":1}' />
                      </div>
                    )}
                    {ent.trigger?.type === 'drag' && (
                      <div className="entity-row">
                        <input className="props-input props-input-sm" value={ent.trigger.params?.dropTarget || ''} onChange={(e) => updateTriggerParam(i, 'dropTarget', e.target.value)} placeholder="放置目标" />
                        <input className="props-input props-input-sm" type="number" value={ent.trigger.params?.dropRadius || 2} onChange={(e) => updateTriggerParam(i, 'dropRadius', parseFloat(e.target.value))} placeholder="半径" />
                      </div>
                    )}
                    {ent.trigger?.type === 'event' && (
                      <input className="props-input" value={ent.trigger.params?.event || ''} onChange={(e) => updateTriggerParam(i, 'event', e.target.value)} placeholder="条件表达式 (如 wood>=3)" />
                    )}
                    <label className="props-checkbox-label">
                      <input type="checkbox" checked={ent.trigger?.once || false} onChange={(e) => updateTrigger(i, 'once', e.target.checked)} />
                      仅触发一次
                    </label>
                  </div>
                )}

                {/* 行为参数 */}
                {behaviorFields.length > 0 && (
                  <div className="entity-section">
                    <div className="entity-section-title">行为参数</div>
                    {behaviorFields.map(f => (
                      <div key={f.key} className="entity-row">
                        <label className="entity-field-label">{f.label}</label>
                        {f.type === 'checkbox' ? (
                          <input type="checkbox" checked={ent.behavior?.[f.key] || false} onChange={(e) => updateBehavior(i, f.key, e.target.checked)} />
                        ) : (
                          <input className="props-input props-input-sm" type={f.type} value={ent.behavior?.[f.key] ?? f.default} onChange={(e) => updateBehavior(i, f.key, f.type === 'number' ? parseFloat(e.target.value) : e.target.value)} />
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* 建造完成动作 (Buildable) */}
                {tpl.includes('Buildable') && (
                  <div className="entity-section">
                    <div className="entity-section-title">建造完成后</div>
                    <input className="props-input" value={ent.behavior?.onBuilt?.map(a => a.type + '(' + (a.params?.target || '') + ')').join(', ') || ''} onChange={(e) => {
                      const parts = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                      const onBuilt = parts.map(p => {
                        const m = p.match(/(\w+)\(([^)]*)\)/);
                        return m ? { type: m[1], params: { target: m[2] } } : { type: 'activate', params: { target: p } };
                      });
                      updateBehavior(i, 'onBuilt', onBuilt);
                    }} placeholder="activate(EntityName), ..." />
                  </div>
                )}

                {/* 死亡动作 (Damageable) */}
                {tpl.includes('Damageable') && (
                  <div className="entity-section">
                    <div className="entity-section-title">死亡时</div>
                    <input className="props-input" value={ent.actions?.find(a => a.type === 'onDeath')?.params?.drop || ''} onChange={(e) => {
                      const actions = [...(ent.actions || [])].filter(a => a.type !== 'onDeath');
                      if (e.target.value) actions.push({ type: 'onDeath', params: { drop: e.target.value, count: 1 } });
                      updateEntity(i, { actions });
                    }} placeholder="掉落实体名 (如 GoldCoin)" />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      <button className="props-image-upload-btn" onClick={addEntity}>+ 添加实体</button>
    </div>
  );
}
