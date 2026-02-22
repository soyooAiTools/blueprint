export default function PropsPanel({
  selectedNode,
  selectedEdge,
  onUpdateNode,
  onUpdateEdge,
  onDeleteNode,
}) {
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
          <div className="props-hint">
            留空 = 无条件默认流程
          </div>
        </div>
      </div>
    );
  }

  if (!selectedNode || selectedNode.type === 'joinNode') {
    if (selectedNode && selectedNode.type === 'joinNode') {
      return (
        <div className="props-panel">
          <div className="props-title">◇ 汇合点</div>
          <div className="props-form">
            <label className="props-label">
              标签
              <input
                className="props-input"
                type="text"
                value={selectedNode.data.label || ''}
                onChange={(e) =>
                  onUpdateNode(selectedNode.id, { label: e.target.value })
                }
              />
            </label>
            <button className="props-delete-btn" onClick={() => onDeleteNode(selectedNode.id)}>
              🗑 删除节点
            </button>
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
              <textarea
                className="props-textarea"
                rows={5}
                value={selectedNode.data.text || ''}
                onChange={(e) =>
                  onUpdateNode(selectedNode.id, { text: e.target.value })
                }
              />
            </label>
            <button className="props-delete-btn" onClick={() => onDeleteNode(selectedNode.id)}>
              🗑 删除节点
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="props-panel">
        <div className="props-title">📋 属性面板</div>
        <div className="props-empty">点击节点或连线查看属性</div>
      </div>
    );
  }

  if (selectedNode.type === 'noteNode') {
    return (
      <div className="props-panel">
        <div className="props-title">📝 注释</div>
        <div className="props-form">
          <label className="props-label">
            内容
            <textarea
              className="props-textarea"
              rows={5}
              value={selectedNode.data.text || ''}
              onChange={(e) =>
                onUpdateNode(selectedNode.id, { text: e.target.value })
              }
            />
          </label>
          <button className="props-delete-btn" onClick={() => onDeleteNode(selectedNode.id)}>
            🗑 删除节点
          </button>
        </div>
      </div>
    );
  }

  const d = selectedNode.data;
  const update = (field, value) => onUpdateNode(selectedNode.id, { [field]: value });

  return (
    <div className="props-panel">
      <div className="props-title">📷 镜头属性</div>
      <div className="props-form">
        <label className="props-label">
          镜头标签
          <input
            className="props-input"
            type="text"
            value={d.label || ''}
            onChange={(e) => update('label', e.target.value)}
          />
        </label>

        <label className="props-label">
          镜头名称
          <input
            className="props-input"
            type="text"
            value={d.name || ''}
            onChange={(e) => update('name', e.target.value)}
          />
        </label>

        <label className="props-label">
          🔑 进入条件
          <input
            className="props-input"
            type="text"
            value={d.entryCondition || ''}
            onChange={(e) => update('entryCondition', e.target.value)}
            placeholder="如：收集宇航员≥3 / 无条件"
          />
        </label>

        <label className="props-label">
          🎬 画面描述
          <textarea
            className="props-textarea"
            rows={10}
            value={d.scene || ''}
            onChange={(e) => update('scene', e.target.value)}
          />
        </label>

        <label className="props-label">
          📊 数值设定
          <textarea
            className="props-textarea"
            rows={10}
            value={d.behavior || ''}
            onChange={(e) => update('behavior', e.target.value)}
          />
        </label>

        <label className="props-label">
          🎮 操控对象
          <input
            className="props-input"
            type="text"
            value={d.controlTarget || ''}
            onChange={(e) => update('controlTarget', e.target.value)}
          />
        </label>

        <label className="props-label">
          🎮 操控方式
          <input
            className="props-input"
            type="text"
            value={d.controlMethod || ''}
            onChange={(e) => update('controlMethod', e.target.value)}
          />
        </label>

        <label className="props-label">
          ⚡ 触发行为
          <textarea
            className="props-textarea"
            rows={10}
            value={d.triggers || ''}
            onChange={(e) => update('triggers', e.target.value)}
          />
        </label>

        <label className="props-label">
          ✅ 结束条件
          <input
            className="props-input"
            type="text"
            value={d.endCondition || ''}
            onChange={(e) => update('endCondition', e.target.value)}
          />
        </label>

        <div className="props-divider">🔀 条件分支 1</div>

        <label className="props-label">
          判断条件
          <input
            className="props-input"
            type="text"
            value={d.branchCondition || ''}
            onChange={(e) => update('branchCondition', e.target.value)}
            placeholder="如：收集宇航员 ≥ 3"
          />
        </label>

        <label className="props-label">
          ✅ 满足 → 进入镜头
          <input
            className="props-input"
            type="text"
            value={d.branchTrue || ''}
            onChange={(e) => update('branchTrue', e.target.value)}
            placeholder="如：镜头2a"
          />
        </label>

        <label className="props-label">
          ❌ 不满足 → 进入镜头
          <input
            className="props-input"
            type="text"
            value={d.branchFalse || ''}
            onChange={(e) => update('branchFalse', e.target.value)}
            placeholder="如：镜头2b"
          />
        </label>

        <div className="props-divider">🔀 条件分支 2</div>

        <label className="props-label">
          判断条件
          <input
            className="props-input"
            type="text"
            value={d.branchCondition2 || ''}
            onChange={(e) => update('branchCondition2', e.target.value)}
            placeholder="如：卫星数量 ≥ 7"
          />
        </label>

        <label className="props-label">
          ✅ 满足 → 进入镜头
          <input
            className="props-input"
            type="text"
            value={d.branchTrue2 || ''}
            onChange={(e) => update('branchTrue2', e.target.value)}
            placeholder="如：镜头3"
          />
        </label>

        <label className="props-label">
          ❌ 不满足 → 进入镜头
          <input
            className="props-input"
            type="text"
            value={d.branchFalse2 || ''}
            onChange={(e) => update('branchFalse2', e.target.value)}
            placeholder="如：镜头2b"
          />
        </label>

        <div className="props-divider">🎯 素材配置</div>
        <div className="props-hint">为每个游戏对象配置名称和素材，Agent B 会自动匹配使用</div>

        {(d.assets || []).map((asset, ai) => (
          <div key={ai} className="props-asset-card">
            <div className="props-asset-header">
              <input
                className="props-asset-name-input"
                type="text"
                value={asset.targetName || ''}
                onChange={(e) => {
                  const newAssets = [...(d.assets || [])];
                  newAssets[ai] = { ...newAssets[ai], targetName: e.target.value };
                  update('assets', newAssets);
                }}
                placeholder="目标名称（如：玩家卫星、小冰块、敌方卫星）"
              />
              <button
                className="props-asset-remove-btn"
                onClick={() => {
                  const newAssets = [...(d.assets || [])];
                  newAssets.splice(ai, 1);
                  update('assets', newAssets);
                }}
              >✕</button>
            </div>

            {/* 模型文件 */}
            <div className="props-asset-files">
              {(asset.models || []).map((m, mi) => (
                <div key={mi} className="props-asset-file-tag">
                  <span>📦 {m.name}</span>
                  <button onClick={() => {
                    const newAssets = [...(d.assets || [])];
                    const newModels = [...(newAssets[ai].models || [])];
                    newModels.splice(mi, 1);
                    newAssets[ai] = { ...newAssets[ai], models: newModels };
                    update('assets', newAssets);
                  }}>✕</button>
                </div>
              ))}
              {(asset.images || []).map((img, ii) => (
                <div key={`img-${ii}`} className="props-asset-image-thumb-wrap">
                  <img src={img} className="props-asset-image-thumb" alt="" />
                  <button className="props-asset-thumb-remove" onClick={() => {
                    const newAssets = [...(d.assets || [])];
                    const newImages = [...(newAssets[ai].images || [])];
                    newImages.splice(ii, 1);
                    newAssets[ai] = { ...newAssets[ai], images: newImages };
                    update('assets', newAssets);
                  }}>✕</button>
                </div>
              ))}
            </div>

            <div className="props-asset-upload-row">
              <label className="props-asset-upload-small">
                + 模型
                <input type="file" accept=".fbx,.obj,.glb,.gltf,.blend" multiple style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files);
                    if (!files.length) return;
                    Promise.all(files.map(f => new Promise(resolve => {
                      const reader = new FileReader();
                      reader.onload = ev => resolve({ name: f.name, size: f.size, data: ev.target.result });
                      reader.readAsDataURL(f);
                    }))).then(models => {
                      const newAssets = [...(d.assets || [])];
                      newAssets[ai] = { ...newAssets[ai], models: [...(newAssets[ai].models || []), ...models] };
                      update('assets', newAssets);
                    });
                    e.target.value = '';
                  }}
                />
              </label>
              <label className="props-asset-upload-small">
                + 图片
                <input type="file" accept="image/*" multiple style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files);
                    if (!files.length) return;
                    Promise.all(files.map(f => new Promise(resolve => {
                      const reader = new FileReader();
                      reader.onload = ev => resolve(ev.target.result);
                      reader.readAsDataURL(f);
                    }))).then(imgs => {
                      const newAssets = [...(d.assets || [])];
                      newAssets[ai] = { ...newAssets[ai], images: [...(newAssets[ai].images || []), ...imgs] };
                      update('assets', newAssets);
                    });
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>
        ))}

        <button
          className="props-image-upload-btn"
          onClick={() => update('assets', [...(d.assets || []), { targetName: '', models: [], images: [] }])}
        >
          + 添加素材目标
        </button>

        <div className="props-divider">🖼 参考图片</div>
        <div className="props-hint">上传效果参考图，Agent B 会参考视觉风格</div>

        <div className="props-images">
          {(d.images || []).map((img, i) => (
            <div key={i} className="props-image-item">
              <img src={img} className="props-image-preview" alt={'参考图' + (i + 1)} />
              <button
                className="props-image-remove"
                onClick={() => {
                  const newImages = [...(d.images || [])];
                  newImages.splice(i, 1);
                  update('images', newImages);
                }}
              >✕</button>
            </div>
          ))}
        </div>

        <label className="props-image-upload-btn">
          + 添加图片
          <input
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files);
              if (!files.length) return;
              const promises = files.map((file) => {
                return new Promise((resolve) => {
                  const reader = new FileReader();
                  reader.onload = (ev) => resolve(ev.target.result);
                  reader.readAsDataURL(file);
                });
              });
              Promise.all(promises).then((dataUrls) => {
                update('images', [...(d.images || []), ...dataUrls]);
              });
              e.target.value = '';
            }}
          />
        </label>

        <div className="props-divider">💬 反馈修改</div>
        <div className="props-hint">标注问题和修改意见，导出后 Agent B 会自动参考修复</div>

        {(d.feedback || []).map((fb, fi) => (
          <div key={fi} className={`props-feedback-card props-feedback-${fb.status || 'open'}`}>
            <div className="props-feedback-header">
              <select
                className="props-feedback-type"
                value={fb.type || 'bug'}
                onChange={(e) => {
                  const newFb = [...(d.feedback || [])];
                  newFb[fi] = { ...newFb[fi], type: e.target.value };
                  update('feedback', newFb);
                }}
              >
                <option value="bug">🐛 Bug</option>
                <option value="visual">🎨 视觉</option>
                <option value="behavior">⚙️ 行为</option>
                <option value="value">📊 数值</option>
                <option value="suggestion">💡 建议</option>
              </select>
              <select
                className="props-feedback-status"
                value={fb.status || 'open'}
                onChange={(e) => {
                  const newFb = [...(d.feedback || [])];
                  newFb[fi] = { ...newFb[fi], status: e.target.value };
                  update('feedback', newFb);
                }}
              >
                <option value="open">🔴 待修</option>
                <option value="wip">🟡 修改中</option>
                <option value="fixed">🟢 已修</option>
              </select>
              <button
                className="props-asset-remove-btn"
                onClick={() => {
                  const newFb = [...(d.feedback || [])];
                  newFb.splice(fi, 1);
                  update('feedback', newFb);
                }}
              >✕</button>
            </div>
            <textarea
              className="props-feedback-text"
              rows={3}
              value={fb.text || ''}
              onChange={(e) => {
                const newFb = [...(d.feedback || [])];
                newFb[fi] = { ...newFb[fi], text: e.target.value };
                update('feedback', newFb);
              }}
              placeholder="描述问题或修改意见..."
            />
          </div>
        ))}

        <button
          className="props-image-upload-btn"
          onClick={() => update('feedback', [...(d.feedback || []), { type: 'bug', status: 'open', text: '' }])}
        >
          + 添加反馈
        </button>

        <button className="props-delete-btn" onClick={() => onDeleteNode(selectedNode.id)}>
          🗑 删除节点
        </button>
      </div>
    </div>
  );
}
