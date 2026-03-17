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

function ObjectRegistryEditor({ objectRegistry, onChangeRegistry }) {
  const addObject = () => {
    onChangeRegistry([...objectRegistry, { name: '', label: '', shape: 'Cube', scale: '1×1×1', color: '', initiallyVisible: true, firstStep: 1 }]);
  };
  const removeObject = (i) => {
    const arr = [...objectRegistry];
    arr.splice(i, 1);
    onChangeRegistry(arr);
  };
  const updateObj = (i, field, value) => {
    const arr = [...objectRegistry];
    arr[i] = { ...arr[i], [field]: value };
    onChangeRegistry(arr);
  };

  return (
    <div className="props-registry">
      <div className="props-divider">📦 物件清单 (Object Registry)</div>
      <div className="props-hint">全局游戏物件列表，定义形状、颜色、初始可见性</div>
      {objectRegistry.map((obj, i) => (
        <div key={i} className="props-registry-item">
          <div className="props-registry-row">
            <input className="props-input props-input-sm" type="text" value={obj.name} onChange={(e) => updateObj(i, 'name', e.target.value)} placeholder="英文名 (Player)" />
            <input className="props-input props-input-sm" type="text" value={obj.label || ''} onChange={(e) => updateObj(i, 'label', e.target.value)} placeholder="中文注释 (玩家)" />
            <button className="props-registry-remove" onClick={() => removeObject(i)}>✕</button>
          </div>
          <div className="props-registry-row">
            <select className="props-input props-input-sm" value={obj.shape} onChange={(e) => updateObj(i, 'shape', e.target.value)}>
              {SHAPE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="props-registry-row">
            <input className="props-input props-input-sm" type="text" value={obj.scale} onChange={(e) => updateObj(i, 'scale', e.target.value)} placeholder="比例 1×2×1" />
            <div className="props-color-wrap">
              <input className="props-input props-input-sm" type="text" value={obj.color} onChange={(e) => updateObj(i, 'color', e.target.value)} placeholder="颜色" />
              <select className="props-color-preset" value="" onChange={(e) => { if (e.target.value) updateObj(i, 'color', e.target.value); }}>
                <option value="">预设</option>
                {COLOR_PRESETS.map(c => <option key={c.label} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          </div>
          <div className="props-registry-row">
            <label className="props-checkbox-label">
              <input type="checkbox" checked={obj.initiallyVisible} onChange={(e) => updateObj(i, 'initiallyVisible', e.target.checked)} />
              初始可见
            </label>
            <label className="props-inline-label">
              首现步骤
              <input className="props-input props-input-xs" type="number" min={1} value={obj.firstStep || 1} onChange={(e) => updateObj(i, 'firstStep', parseInt(e.target.value) || 1)} />
            </label>
          </div>
        </div>
      ))}
      <button className="props-image-upload-btn" onClick={addObject}>+ 添加物件</button>
    </div>
  );
}

function GlobalParamsEditor({ globalParams, onChangeParams }) {
  return (
    <div className="props-global-params">
      <div className="props-divider">📊 全局参数表 (Global Params)</div>
      <div className="props-hint">key=value 格式，每行一个，# 开头为注释</div>
      <textarea
        className="props-textarea props-textarea-mono"
        rows={10}
        value={globalParams}
        onChange={(e) => onChangeParams(e.target.value)}
        placeholder={"# === 全局参数 ===\nplayer.moveSpeed = 5\nplayer.gold = 0\nenemy.spawnInterval = 2"}
      />
    </div>
  );
}

export default function PropsPanel({
  selectedNode,
  selectedEdge,
  onUpdateNode,
  onUpdateEdge,
  onDeleteNode,
  objectRegistry = [],
  globalParams = '',
  globalSettings = {},
  onChangeRegistry,
  onChangeParams,
  onChangeGlobalSettings,
}) {
  const [showSceneFallback, setShowSceneFallback] = useState(false);

  if (selectedEdge) {
    return (
      <div className="props-panel">
        <div className="props-title">🔗 连线属性</div>
        <div className="props-form">
          <label className="props-label">
            条件标签
            <input
              className="props-input"
              type="text"
              value={selectedEdge.label || ''}
              onChange={(e) => onUpdateEdge(selectedEdge.id, e.target.value)}
              placeholder="无条件（默认流程）"
            />
          </label>
          <div className="props-hint">留空 = 无条件默认流程</div>
        </div>
      </div>
    );
  }

  if (selectedNode && selectedNode.type === 'joinNode') {
    return (
      <div className="props-panel">
        <div className="props-title">◇ 汇合点</div>
        <div className="props-form">
          <label className="props-label">
            标签
            <input className="props-input" type="text" value={selectedNode.data.label || ''} onChange={(e) => onUpdateNode(selectedNode.id, { label: e.target.value })} />
          </label>
          <button className="props-delete-btn" onClick={() => onDeleteNode(selectedNode.id)}>🗑 删除节点</button>
        </div>
      </div>
    );
  }

  if (selectedNode && selectedNode.type === 'noteNode') {
    return (
      <div className="props-panel">
        <div className="props-title">📝 注释</div>
        <div className="props-form">
          <label className="props-label">
            内容
            <textarea className="props-textarea" rows={5} value={selectedNode.data.text || ''} onChange={(e) => onUpdateNode(selectedNode.id, { text: e.target.value })} />
          </label>
          <button className="props-delete-btn" onClick={() => onDeleteNode(selectedNode.id)}>🗑 删除节点</button>
        </div>
      </div>
    );
  }

  // No selection → Global settings panel
  if (!selectedNode) {
    return (
      <div className="props-panel">
        <div className="props-title">🌐 全局设置</div>
        <div className="props-form">
          <div className="props-divider">🎮 游戏类型</div>
          <select className="props-input" value={globalSettings?.gameType || 'slg'} onChange={(e) => onChangeGlobalSettings({ ...globalSettings, gameType: e.target.value })}>
            <option value="slg">🏰 SLG 建造防守</option>
            <option value="runner">🏃 跑酷</option>
            <option value="shooter">🔫 射击</option>
            <option value="merge">🧩 合成</option>
            <option value="puzzle">🧠 解谜</option>
            <option value="idle">💰 放置</option>
            <option value="match3">💎 三消</option>
            <option value="other">📦 其他</option>
          </select>

          <div className="props-divider">📷 相机设置</div>
          <label className="props-label">
            视角模式
            <select className="props-input" value={globalSettings?.cameraMode || 'topDown45'} onChange={(e) => onChangeGlobalSettings({ ...globalSettings, cameraMode: e.target.value })}>
              <option value="topDown45">🔽 俯视45°（默认）</option>
              <option value="topDown90">⬇️ 正俯视90°</option>
              <option value="sideScroll">➡️ 横版</option>
              <option value="thirdPerson">🧍 第三人称</option>
              <option value="fixed">📌 固定机位</option>
            </select>
          </label>
          <label className="props-label">
            投影方式
            <select className="props-input" value={globalSettings?.cameraProjection || 'orthographic'} onChange={(e) => onChangeGlobalSettings({ ...globalSettings, cameraProjection: e.target.value })}>
              <option value="orthographic">正交 (Orthographic)</option>
              <option value="perspective">透视 (Perspective)</option>
            </select>
          </label>
          <div className="props-registry-row">
            <label className="props-inline-label">
              FOV / Size
              <input className="props-input props-input-xs" type="number" value={globalSettings?.cameraFOV || 60} onChange={(e) => onChangeGlobalSettings({ ...globalSettings, cameraFOV: parseInt(e.target.value) || 60 })} />
            </label>
            <label className="props-inline-label">
              背景色
              <div className="props-color-wrap">
                <input className="props-input props-input-sm" type="text" value={globalSettings?.cameraBgColor || '(0.6,0.8,1)'} onChange={(e) => onChangeGlobalSettings({ ...globalSettings, cameraBgColor: e.target.value })} placeholder="(r,g,b)" />
              </div>
            </label>
          </div>

          <div className="props-divider">🕹️ 默认输入方式</div>
          <select className="props-input" value={globalSettings?.defaultInput || 'virtualJoystick'} onChange={(e) => onChangeGlobalSettings({ ...globalSettings, defaultInput: e.target.value })}>
            <option value="virtualJoystick">🕹️ 虚拟摇杆</option>
            <option value="tap">👆 点击移动</option>
            <option value="drag">✋ 拖拽</option>
            <option value="swipe">👉 滑动</option>
            <option value="none">🚫 无操作（自动播放）</option>
          </select>
          <div className="props-hint">每个步骤可单独覆盖输入方式</div>

          <ObjectRegistryEditor objectRegistry={objectRegistry} onChangeRegistry={onChangeRegistry} />
          <GlobalParamsEditor globalParams={globalParams} onChangeParams={onChangeParams} />
        </div>
      </div>
    );
  }

  // Shot node selected
  const d = selectedNode.data;
  const update = (field, value) => onUpdateNode(selectedNode.id, { [field]: value });
  const isV2 = !!(d.sceneObjects || d.triggerChain || d.params);

  // Parse which objects from registry are mentioned in sceneObjects
  const getSelectedNewObjects = () => {
    if (!d.sceneObjects) return [];
    return objectRegistry
      .filter(obj => d.sceneObjects.includes(obj.name))
      .map(obj => obj.name);
  };

  const toggleNewObject = (name, checked) => {
    const lines = (d.sceneObjects || '').split('\n').filter(l => l.trim());
    if (checked) {
      const obj = objectRegistry.find(o => o.name === name);
      const newLine = `- ${name} | 位置: 待设定 | 状态: ${obj?.initiallyVisible ? 'visible' : 'appear'}`;
      lines.push(newLine);
    } else {
      const idx = lines.findIndex(l => l.match(new RegExp(`^-\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`)));
      if (idx >= 0) lines.splice(idx, 1);
    }
    update('sceneObjects', lines.join('\n'));
  };

  return (
    <div className="props-panel">
      <div className="props-title">📷 镜头属性</div>
      <div className="props-form">
        <label className="props-label">
          镜头标签
          <input className="props-input" type="text" value={d.label || ''} onChange={(e) => update('label', e.target.value)} />
        </label>
        <label className="props-label">
          镜头名称
          <input className="props-input" type="text" value={d.name || ''} onChange={(e) => update('name', e.target.value)} />
        </label>
        <label className="props-label">
          🔑 进入条件
          <input className="props-input" type="text" value={d.entryCondition || ''} onChange={(e) => update('entryCondition', e.target.value)} placeholder="如：收集宇航员≥3 / 无条件" />
        </label>

        {/* V1 fields */}
        {!isV2 && (<>
          <label className="props-label">
            🎬 画面描述
            <textarea className="props-textarea" rows={10} value={d.scene || ''} onChange={(e) => update('scene', e.target.value)} />
          </label>
          <label className="props-label">
            📊 数值设定
            <textarea className="props-textarea" rows={10} value={d.behavior || ''} onChange={(e) => update('behavior', e.target.value)} />
          </label>
          <label className="props-label">
            🎮 操控对象
            <input className="props-input" type="text" value={d.controlTarget || ''} onChange={(e) => update('controlTarget', e.target.value)} />
          </label>
          <label className="props-label">
            🎮 操控方式
            <input className="props-input" type="text" value={d.controlMethod || ''} onChange={(e) => update('controlMethod', e.target.value)} />
          </label>
          <label className="props-label">
            ⚡ 触发行为
            <textarea className="props-textarea" rows={10} value={d.triggers || ''} onChange={(e) => update('triggers', e.target.value)} />
          </label>
        </>)}

        <label className="props-label">
          ✅ 结束条件
          <input className="props-input" type="text" value={d.endCondition || ''} onChange={(e) => update('endCondition', e.target.value)} />
        </label>

        {/* V2 fields */}
        {isV2 && (<>
          <div className="props-divider">🏗️ 场景变更</div>
          <div className="props-hint">之前步骤的所有对象默认保持可见</div>

          {objectRegistry.length > 0 && (
            <div className="props-scene-delta">
              <div className="props-sub-label">新增显示</div>
              <div className="props-obj-checkboxes">
                {objectRegistry.map((obj) => {
                  const checked = getSelectedNewObjects().includes(obj.name);
                  return (
                    <label key={obj.name} className="props-obj-check">
                      <input type="checkbox" checked={checked} onChange={(e) => toggleNewObject(obj.name, e.target.checked)} />
                      {obj.name}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="props-scene-fallback-toggle">
            <button className="props-link-btn" onClick={() => setShowSceneFallback(!showSceneFallback)}>
              {showSceneFallback ? '▼ 隐藏原始文本' : '▶ 编辑原始文本'}
            </button>
          </div>
          {showSceneFallback && (
            <textarea className="props-textarea props-textarea-mono" rows={8} value={d.sceneObjects || ''} onChange={(e) => update('sceneObjects', e.target.value)}
              placeholder={"# 场景对象列表\n- PlayerCharacter | 位置: 屏幕下方中央 | 状态: idle"} />
          )}

          <div className="props-divider">🎮 玩家操作</div>
          <label className="props-label">
            输入类型
            <select className="props-input" value={d.inputType || 'virtualJoystick'} onChange={(e) => update('inputType', e.target.value)}>
              <option value="virtualJoystick">🕹️ 虚拟摇杆</option>
              <option value="tap">👆 点击移动</option>
              <option value="drag">✋ 拖拽</option>
              <option value="swipe">👉 滑动</option>
              <option value="none">🚫 无操作（自动播放）</option>
            </select>
          </label>
          <textarea className="props-textarea props-textarea-mono" rows={3} value={d.inputConfig || ''} onChange={(e) => update('inputConfig', e.target.value)}
            placeholder={"position: 屏幕左下角\nsize: 屏幕宽度的 15%"} />

          <div className="props-divider">⚡ 逻辑步骤</div>
          <div className="props-hint">按顺序：事件 → 条件 → 动作</div>
          <textarea className="props-textarea props-textarea-mono" rows={12} value={d.triggerChain || ''} onChange={(e) => update('triggerChain', e.target.value)}
            placeholder={"1. 场景初始化\n   → 显示引导箭头\n2. 玩家进入交互区\n   → 条件: player.gold >= cost"} />

          <div className="props-divider">📊 参数表</div>
          <div className="props-hint">Key-Value 数值参数，带中文注释</div>
          <textarea className="props-textarea props-textarea-mono" rows={12} value={d.params || ''} onChange={(e) => update('params', e.target.value)}
            placeholder={"# === 玩家参数 ===\nplayer.gold = 1          # 初始金币"} />

          <div className="props-divider">📦 资源清单</div>
          <textarea className="props-textarea props-textarea-mono" rows={6} value={(typeof d.assets === 'string' ? d.assets : '') || ''} onChange={(e) => update('assets', e.target.value)}
            placeholder={"- Prefab: PlayerCharacter（玩家角色）"} />
        </>)}

        {/* V1 branch conditions */}
        {!isV2 && (<>
          <div className="props-divider">🔀 条件分支 1</div>
          <label className="props-label">
            判断条件
            <input className="props-input" type="text" value={d.branchCondition || ''} onChange={(e) => update('branchCondition', e.target.value)} placeholder="如：收集宇航员 ≥ 3" />
          </label>
          <label className="props-label">
            ✅ 满足 → 进入镜头
            <input className="props-input" type="text" value={d.branchTrue || ''} onChange={(e) => update('branchTrue', e.target.value)} />
          </label>
          <label className="props-label">
            ❌ 不满足 → 进入镜头
            <input className="props-input" type="text" value={d.branchFalse || ''} onChange={(e) => update('branchFalse', e.target.value)} />
          </label>

          <div className="props-divider">🔀 条件分支 2</div>
          <label className="props-label">
            判断条件
            <input className="props-input" type="text" value={d.branchCondition2 || ''} onChange={(e) => update('branchCondition2', e.target.value)} />
          </label>
          <label className="props-label">
            ✅ 满足 → 进入镜头
            <input className="props-input" type="text" value={d.branchTrue2 || ''} onChange={(e) => update('branchTrue2', e.target.value)} />
          </label>
          <label className="props-label">
            ❌ 不满足 → 进入镜头
            <input className="props-input" type="text" value={d.branchFalse2 || ''} onChange={(e) => update('branchFalse2', e.target.value)} />
          </label>

          <div className="props-divider">🎯 素材配置</div>
          <div className="props-hint">为每个游戏对象配置名称和素材</div>
          {(Array.isArray(d.assets) ? d.assets : []).map((asset, ai) => (
            <div key={ai} className="props-asset-card">
              <div className="props-asset-header">
                <input className="props-asset-name-input" type="text" value={asset.targetName || ''}
                  onChange={(e) => { const a = [...(d.assets || [])]; a[ai] = { ...a[ai], targetName: e.target.value }; update('assets', a); }}
                  placeholder="目标名称" />
                <button className="props-asset-remove-btn"
                  onClick={() => { const a = [...(d.assets || [])]; a.splice(ai, 1); update('assets', a); }}>✕</button>
              </div>
              <div className="props-asset-files">
                {(asset.models || []).map((m, mi) => (
                  <div key={mi} className="props-asset-file-tag">
                    <span>📦 {m.name}</span>
                    <button onClick={() => { const a = [...(d.assets || [])]; const mm = [...(a[ai].models || [])]; mm.splice(mi, 1); a[ai] = { ...a[ai], models: mm }; update('assets', a); }}>✕</button>
                  </div>
                ))}
              </div>
              <div className="props-asset-upload-row">
                <label className="props-asset-upload-small">
                  + 模型
                  <input type="file" accept=".fbx,.obj,.glb,.gltf,.blend" multiple style={{ display: 'none' }}
                    onChange={(e) => {
                      const files = Array.from(e.target.files); if (!files.length) return;
                      Promise.all(files.map(f => new Promise(r => { const rd = new FileReader(); rd.onload = ev => r({ name: f.name, size: f.size, data: ev.target.result }); rd.readAsDataURL(f); }))).then(models => {
                        const a = [...(d.assets || [])]; a[ai] = { ...a[ai], models: [...(a[ai].models || []), ...models] }; update('assets', a);
                      }); e.target.value = '';
                    }} />
                </label>
              </div>
            </div>
          ))}
          {!isV2 && (
            <button className="props-image-upload-btn"
              onClick={() => update('assets', [...(Array.isArray(d.assets) ? d.assets : []), { targetName: '', models: [], images: [] }])}>
              + 添加素材目标
            </button>
          )}

          <div className="props-divider">💬 反馈修改</div>
          <div className="props-hint">标注问题和修改意见</div>
          {(d.feedback || []).map((fb, fi) => (
            <div key={fi} className={`props-feedback-card props-feedback-${fb.status || 'open'}`}>
              <div className="props-feedback-header">
                <select className="props-feedback-type" value={fb.type || 'bug'}
                  onChange={(e) => { const f = [...(d.feedback || [])]; f[fi] = { ...f[fi], type: e.target.value }; update('feedback', f); }}>
                  <option value="bug">🐛 Bug</option>
                  <option value="visual">🎨 视觉</option>
                  <option value="behavior">⚙️ 行为</option>
                  <option value="value">📊 数值</option>
                  <option value="suggestion">💡 建议</option>
                </select>
                <select className="props-feedback-status" value={fb.status || 'open'}
                  onChange={(e) => { const f = [...(d.feedback || [])]; f[fi] = { ...f[fi], status: e.target.value }; update('feedback', f); }}>
                  <option value="open">🔴 待修</option>
                  <option value="wip">🟡 修改中</option>
                  <option value="fixed">🟢 已修</option>
                </select>
                <button className="props-asset-remove-btn"
                  onClick={() => { const f = [...(d.feedback || [])]; f.splice(fi, 1); update('feedback', f); }}>✕</button>
              </div>
              <textarea className="props-feedback-text" rows={3} value={fb.text || ''}
                onChange={(e) => { const f = [...(d.feedback || [])]; f[fi] = { ...f[fi], text: e.target.value }; update('feedback', f); }}
                placeholder="描述问题或修改意见..." />
            </div>
          ))}
          <button className="props-image-upload-btn"
            onClick={() => update('feedback', [...(d.feedback || []), { type: 'bug', status: 'open', text: '' }])}>
            + 添加反馈
          </button>
        </>)}

        <div className="props-divider">🖼 参考图片</div>
        <div className="props-hint">上传效果参考图</div>
        <div className="props-images">
          {(d.images || []).map((img, i) => (
            <div key={i} className="props-image-item">
              <img src={img} className="props-image-preview" alt={'参考图' + (i + 1)} />
              <button className="props-image-remove" onClick={() => { const im = [...(d.images || [])]; im.splice(i, 1); update('images', im); }}>✕</button>
            </div>
          ))}
        </div>
        <label className="props-image-upload-btn">
          + 添加参考图
          <input type="file" accept="image/*" multiple style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files); if (!files.length) return;
              Promise.all(files.map(f => new Promise(r => { const rd = new FileReader(); rd.onload = ev => r(ev.target.result); rd.readAsDataURL(f); }))).then(urls => {
                update('images', [...(d.images || []), ...urls]);
              }); e.target.value = '';
            }} />
        </label>
        <label className="props-label">
          📝 参考说明
          <textarea className="props-textarea" rows={3} value={d.referenceNote || ''} onChange={(e) => update('referenceNote', e.target.value)}
            placeholder="说明参考图片的哪些内容..." />
        </label>

        <button className="props-delete-btn" onClick={() => onDeleteNode(selectedNode.id)}>🗑 删除节点</button>
      </div>
    </div>
  );
}
