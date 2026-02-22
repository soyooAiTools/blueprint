import { useState } from 'react';

export default function TaskPanel({ nodes, onUpdateNode }) {
  const shotNodes = nodes.filter((n) => n.type === 'shotNode');
  const [expandedId, setExpandedId] = useState(null);
  const [showPicker, setShowPicker] = useState(false);

  // feedbackShotIds: which shots are in the feedback list
  // Stored as a set of node IDs in each shot's data.inFeedbackList
  const feedbackShots = shotNodes.filter((n) => n.data.inFeedbackList);

  const addShotToFeedback = (nodeId) => {
    onUpdateNode(nodeId, { inFeedbackList: true });
    setShowPicker(false);
  };

  const removeShotFromFeedback = (nodeId) => {
    onUpdateNode(nodeId, { inFeedbackList: false });
    if (expandedId === nodeId) setExpandedId(null);
  };

  const updateRevisions = (nodeId, revisions) => {
    onUpdateNode(nodeId, { revisions });
  };

  const addFeedback = (nodeId, currentRevisions) => {
    updateRevisions(nodeId, [...(currentRevisions || []), {
      id: Date.now(),
      type: 'behavior',
      priority: 'high',
      instruction: '',
      status: 'pending',
    }]);
  };

  const updateFeedback = (nodeId, revisions, ri, field, value) => {
    const newRevs = [...revisions];
    newRevs[ri] = { ...newRevs[ri], [field]: value };
    updateRevisions(nodeId, newRevs);
  };

  const removeFeedback = (nodeId, revisions, ri) => {
    const newRevs = [...revisions];
    newRevs.splice(ri, 1);
    updateRevisions(nodeId, newRevs);
  };

  // Export feedback-only JSON
  const exportFeedbackJSON = () => {
    const feedbackData = {
      type: 'feedback',
      exportedAt: new Date().toISOString(),
      shots: [],
    };

    feedbackShots.forEach((node) => {
      const idx = shotNodes.indexOf(node);
      const pending = (node.data.revisions || []).filter((r) => r.status === 'pending');
      if (pending.length === 0) return;

      feedbackData.shots.push({
        shotId: 'shot_' + (idx + 1),
        shotName: node.data.name || node.data.label || '镜头' + (idx + 1),
        context: {
          scene: node.data.scene || '',
          behavior: node.data.behavior || '',
          controlMethod: node.data.controlMethod || '',
        },
        feedback: pending.map((r) => ({
          type: r.type,
          priority: r.priority,
          instruction: r.instruction,
        })),
      });
    });

    if (feedbackData.shots.length === 0) {
      alert('没有待修的反馈指令');
      return;
    }

    const blob = new Blob([JSON.stringify(feedbackData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'feedback-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const pendingCount = feedbackShots.reduce((sum, n) =>
    sum + (n.data.revisions || []).filter((r) => r.status === 'pending').length, 0);

  const truncate = (text, max = 60) => {
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '…' : text;
  };

  // Shots not yet in feedback list
  const availableShots = shotNodes.filter((n) => !n.data.inFeedbackList);

  return (
    <div className="task-panel">
      <div className="task-panel-header">
        <div>
          <h2>💬 镜头反馈</h2>
          <div className="task-panel-desc">选择需要反馈的镜头，添加修改指令，导出后 Coding Agent 只关注增量部分</div>
        </div>
        <div className="task-panel-actions">
          {pendingCount > 0 && (
            <button className="task-export-btn" onClick={exportFeedbackJSON}>
              📤 导出反馈 JSON（{pendingCount}条待修）
            </button>
          )}
        </div>
        {pendingCount > 0 && (
          <div className="task-panel-pending-hint">
            🔴 {pendingCount} 条待修，通过顶栏「📤 导出 JSON」一起导出
          </div>
        )}
      </div>

      {/* Feedback shot list */}
      <div className="task-list">
        {feedbackShots.length === 0 && (
          <div className="task-list-empty">
            <div className="task-empty-icon">💬</div>
            <div className="task-empty-text">暂无反馈镜头</div>
            <div className="task-empty-hint">点击下方「+ 添加镜头」选择要反馈的镜头</div>
          </div>
        )}

        {feedbackShots.map((node) => {
          const d = node.data;
          const idx = shotNodes.indexOf(node);
          const revisions = d.revisions || [];
          const pending = revisions.filter((r) => r.status === 'pending').length;
          const done = revisions.filter((r) => r.status === 'done').length;
          const isExpanded = expandedId === node.id;

          return (
            <div key={node.id} className={`task-card ${isExpanded ? 'task-card-expanded' : ''}`}>
              <div className="task-card-header" onClick={() => setExpandedId(isExpanded ? null : node.id)}>
                <div className="task-card-left">
                  <span className="task-card-index">#{idx + 1}</span>
                  <span className="task-card-name">{d.name || d.label || '未命名镜头'}</span>
                  {d.scene && <span className="task-card-scene">{truncate(d.scene)}</span>}
                </div>
                <div className="task-card-right">
                  {pending > 0 && <span className="task-mini-badge task-mini-pending">{pending}</span>}
                  {done > 0 && <span className="task-mini-badge task-mini-done">{done}</span>}
                  <button
                    className="task-card-remove-btn"
                    onClick={(e) => { e.stopPropagation(); removeShotFromFeedback(node.id); }}
                    title="从反馈列表移除"
                  >✕</button>
                  <span className="task-expand-icon">{isExpanded ? '▾' : '▸'}</span>
                </div>
              </div>

              {isExpanded && (
                <div className="task-revisions">
                  {revisions.length === 0 && (
                    <div className="task-rev-empty">暂无反馈，点击下方按钮添加</div>
                  )}

                  {revisions.map((rev, ri) => (
                    <div key={rev.id || ri} className={`task-rev-item task-rev-${rev.status}`}>
                      <div className="task-rev-top">
                        <select className="task-rev-type" value={rev.type}
                          onChange={(e) => updateFeedback(node.id, revisions, ri, 'type', e.target.value)}>
                          <option value="visual">🎨 视觉</option>
                          <option value="behavior">⚙️ 行为</option>
                          <option value="value">📊 数值</option>
                          <option value="bug">🐛 Bug</option>
                          <option value="add">➕ 新增</option>
                          <option value="remove">➖ 移除</option>
                        </select>
                        <select className="task-rev-priority" value={rev.priority}
                          onChange={(e) => updateFeedback(node.id, revisions, ri, 'priority', e.target.value)}>
                          <option value="high">🔴 高</option>
                          <option value="medium">🟡 中</option>
                          <option value="low">🟢 低</option>
                        </select>
                        <select className="task-rev-status" value={rev.status}
                          onChange={(e) => updateFeedback(node.id, revisions, ri, 'status', e.target.value)}>
                          <option value="pending">🔴 待修</option>
                          <option value="done">🟢 完成</option>
                        </select>
                      </div>
                      <textarea className="task-rev-text" rows={3} value={rev.instruction}
                        onChange={(e) => updateFeedback(node.id, revisions, ri, 'instruction', e.target.value)}
                        placeholder="具体修改指令：什么问题 → 改成什么样"
                      />
                      <div className="task-rev-bottom">
                        <button className="task-rev-delete-btn"
                          onClick={() => removeFeedback(node.id, revisions, ri)}>
                          🗑 删除此反馈
                        </button>
                      </div>
                    </div>
                  ))}

                  <button className="task-add-rev-btn" onClick={() => addFeedback(node.id, revisions)}>
                    + 添加反馈
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add shot picker */}
      {showPicker ? (
        <div className="task-picker">
          <div className="task-picker-title">选择要反馈的镜头：</div>
          {availableShots.length === 0 ? (
            <div className="task-picker-empty">所有镜头都已在反馈列表中</div>
          ) : (
            availableShots.map((node) => {
              const idx = shotNodes.indexOf(node);
              return (
                <div key={node.id} className="task-picker-item" onClick={() => addShotToFeedback(node.id)}>
                  <span className="task-card-index">#{idx + 1}</span>
                  <span className="task-card-name">{node.data.name || node.data.label || '未命名镜头'}</span>
                </div>
              );
            })
          )}
          <button className="task-picker-cancel" onClick={() => setShowPicker(false)}>取消</button>
        </div>
      ) : (
        <button className="task-add-shot-btn" onClick={() => setShowPicker(true)}>
          + 添加镜头
        </button>
      )}
    </div>
  );
}
