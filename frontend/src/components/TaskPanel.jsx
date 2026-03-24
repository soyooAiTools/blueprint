import { useState } from 'react';

export default function TaskPanel({ nodes, onUpdateNode, feedbackSubmitted }) {
  const entityNodes = nodes.filter((n) => n.type === 'entityNode' || n.type === 'phaseNode');
  const [expandedId, setExpandedId] = useState(null);
  const [showPicker, setShowPicker] = useState(false);

  const feedbackNodes = entityNodes.filter((n) => n.data.inFeedbackList);

  const addToFeedback = (nodeId) => {
    onUpdateNode(nodeId, { inFeedbackList: true });
    setShowPicker(false);
  };

  const removeFromFeedback = (nodeId) => {
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

  const exportFeedbackJSON = () => {
    const feedbackData = {
      type: 'feedback',
      version: 4,
      exportedAt: new Date().toISOString(),
      items: [],
    };

    feedbackNodes.forEach((node) => {
      const pending = (node.data.revisions || []).filter((r) => r.status === 'pending');
      if (pending.length === 0) return;

      feedbackData.items.push({
        entityId: node.data.name || node.id,
        entityLabel: node.data.label || node.data.name || node.id,
        type: node.type === 'phaseNode' ? 'phase' : 'entity',
        template: node.data.template || '',
        feedback: pending.map((r) => ({
          type: r.type,
          priority: r.priority,
          instruction: r.instruction,
        })),
      });
    });

    if (feedbackData.items.length === 0) {
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

  const pendingCount = feedbackNodes.reduce((sum, n) =>
    sum + (n.data.revisions || []).filter((r) => r.status === 'pending').length, 0);

  const truncate = (text, max = 60) => {
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '…' : text;
  };

  const availableNodes = entityNodes.filter((n) => !n.data.inFeedbackList);

  return (
    <div className="task-panel">
      <div className="task-panel-header">
        <div>
          <h2>💬 实体反馈</h2>
          <div className="task-panel-desc">选择需要反馈的实体或阶段，添加修改指令</div>
        </div>
      </div>

      <div className="task-list">
        {feedbackNodes.length === 0 && (
          <div className="task-list-empty">
            <div className="task-empty-icon">💬</div>
            <div className="task-empty-text">暂无反馈</div>
            <div className="task-empty-hint">点击下方「+ 添加实体」选择要反馈的实体</div>
          </div>
        )}

        {feedbackNodes.map((node) => {
          const d = node.data;
          const revisions = d.revisions || [];
          const pending = revisions.filter((r) => r.status === 'pending').length;
          const done = revisions.filter((r) => r.status === 'done').length;
          const isExpanded = expandedId === node.id;
          const allSubmitted = feedbackSubmitted && revisions.length > 0 && pending === 0;
          const icon = node.type === 'phaseNode' ? '🔄' : '📦';

          return (
            <div key={node.id} className={`task-card ${isExpanded ? 'task-card-expanded' : ''}${allSubmitted ? ' task-card-submitted' : ''}`}>
              <div className="task-card-header" onClick={() => setExpandedId(isExpanded ? null : node.id)}>
                <div className="task-card-left">
                  <span className="task-card-index">{icon}</span>
                  <span className="task-card-name">{d.label || d.name || node.id}</span>
                  {d.template && <span className="task-card-scene">{d.template}</span>}
                  {allSubmitted && <span className="task-submitted-badge">✅ 已提交</span>}
                </div>
                <div className="task-card-right">
                  {pending > 0 && <span className="task-mini-badge task-mini-pending">{pending}</span>}
                  {done > 0 && <span className="task-mini-badge task-mini-done">{done}</span>}
                  {!allSubmitted && (
                    <button className="task-card-remove-btn"
                      onClick={(e) => { e.stopPropagation(); removeFromFeedback(node.id); }}
                      title="从反馈列表移除">✕</button>
                  )}
                  <span className="task-expand-icon">{isExpanded ? '▾' : '▸'}</span>
                </div>
              </div>

              {isExpanded && (
                <div className="task-revisions">
                  {revisions.length === 0 && (
                    <div className="task-rev-empty">暂无反馈，点击下方按钮添加</div>
                  )}
                  {revisions.map((rev, ri) => {
                    const isSubmitted = rev.status === 'done' && allSubmitted;
                    return (
                      <div key={rev.id || ri} className={`task-rev-item task-rev-${rev.status}${isSubmitted ? ' task-rev-readonly' : ''}`}>
                        <div className="task-rev-top">
                          <select className="task-rev-type" value={rev.type} disabled={isSubmitted}
                            onChange={(e) => updateFeedback(node.id, revisions, ri, 'type', e.target.value)}>
                            <option value="visual">🎨 视觉</option>
                            <option value="behavior">⚙️ 行为</option>
                            <option value="value">📊 数值</option>
                            <option value="bug">🐛 Bug</option>
                            <option value="add">➕ 新增</option>
                            <option value="remove">➖ 移除</option>
                          </select>
                          <select className="task-rev-priority" value={rev.priority} disabled={isSubmitted}
                            onChange={(e) => updateFeedback(node.id, revisions, ri, 'priority', e.target.value)}>
                            <option value="high">🔴 高</option>
                            <option value="medium">🟡 中</option>
                            <option value="low">🟢 低</option>
                          </select>
                          {isSubmitted ? (
                            <span className="task-rev-status-label">🟢 已提交</span>
                          ) : (
                            <select className="task-rev-status" value={rev.status}
                              onChange={(e) => updateFeedback(node.id, revisions, ri, 'status', e.target.value)}>
                              <option value="pending">🔴 待修</option>
                              <option value="done">🟢 完成</option>
                            </select>
                          )}
                        </div>
                        <textarea className="task-rev-text" rows={3} value={rev.instruction}
                          readOnly={isSubmitted}
                          onChange={(e) => updateFeedback(node.id, revisions, ri, 'instruction', e.target.value)}
                          placeholder="具体修改指令：什么问题 → 改成什么样"
                        />
                        {!isSubmitted && (
                          <div className="task-rev-bottom">
                            <button className="task-rev-delete-btn"
                              onClick={() => removeFeedback(node.id, revisions, ri)}>
                              🗑 删除此反馈
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!allSubmitted && (
                    <button className="task-add-rev-btn" onClick={() => addFeedback(node.id, revisions)}>
                      + 添加反馈
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showPicker ? (
        <div className="task-picker">
          <div className="task-picker-title">选择要反馈的实体/阶段：</div>
          {availableNodes.length === 0 ? (
            <div className="task-picker-empty">所有实体都已在反馈列表中</div>
          ) : (
            availableNodes.map((node) => {
              const icon = node.type === 'phaseNode' ? '🔄' : '📦';
              return (
                <div key={node.id} className="task-picker-item" onClick={() => addToFeedback(node.id)}>
                  <span className="task-card-index">{icon}</span>
                  <span className="task-card-name">{node.data.label || node.data.name || node.id}</span>
                </div>
              );
            })
          )}
          <button className="task-picker-cancel" onClick={() => setShowPicker(false)}>取消</button>
        </div>
      ) : (
        <button className="task-add-shot-btn" onClick={() => setShowPicker(true)}>
          + 添加实体
        </button>
      )}
    </div>
  );
}
