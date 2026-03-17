import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

function PhaseNode({ id, data, selected }) {
  const activate = data.activate || [];
  const maxShow = 6;
  const entities = data._entities || [];

  const getLabel = (name) => {
    const ent = entities.find(e => e.name === name);
    return ent?.label ? `${name}(${ent.label})` : name;
  };

  const triggerCondition = data.triggerCondition || '';
  const isStart = triggerCondition === 'gameStart' || (!triggerCondition && data.phaseId === 1);

  return (
    <div className={`phase-node ${selected ? 'phase-node-selected' : ''} ${isStart ? 'phase-node-start' : ''}`}>
      <Handle type="target" position={Position.Top} className="shot-handle" isConnectable={true} />
      <Handle type="target" position={Position.Left} id="left-in" className="shot-handle shot-handle-side" isConnectable={true} />

      {/* 触发条件 - 最重要的信息 */}
      <div className="phase-trigger">
        <span className="phase-trigger-icon">{isStart ? '🚀' : '⚡'}</span>
        <span className="phase-trigger-text">
          {isStart ? '游戏开始' : (triggerCondition || '无条件')}
        </span>
      </div>

      <div className="phase-header">
        <span className="phase-name">{data.label || data.name || '事件'}</span>
      </div>

      {/* 动作：激活的实体 */}
      {activate.length > 0 && (
        <div className="phase-activate">
          <div className="phase-activate-label">→ 激活:</div>
          {activate.slice(0, maxShow).map((name, i) => (
            <span key={i} className="phase-entity-tag">{getLabel(name)}</span>
          ))}
          {activate.length > maxShow && <span className="phase-more">+{activate.length - maxShow}</span>}
        </div>
      )}

      {/* 额外动作 */}
      {data.actions && data.actions.length > 0 && (
        <div className="phase-actions">
          {data.actions.map((a, i) => (
            <div key={i} className="phase-action-tag">→ {a.type}({a.params?.target || ''})</div>
          ))}
        </div>
      )}

      {data.guide && (
        <div className="phase-guide">
          💬 {data.guide.length > 35 ? data.guide.slice(0, 35) + '…' : data.guide}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="shot-handle" isConnectable={true} />
      <Handle type="source" position={Position.Right} id="right-out" className="shot-handle shot-handle-side" isConnectable={true} />
    </div>
  );
}

export default memo(PhaseNode);
