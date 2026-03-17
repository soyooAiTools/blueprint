import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

function PhaseNode({ id, data, selected }) {
  const activate = data.activate || [];
  const maxShow = 6;
  const entities = data._entities || [];

  // 查找实体的中文标签
  const getLabel = (name) => {
    const ent = entities.find(e => e.name === name);
    return ent?.label ? `${name}(${ent.label})` : name;
  };

  return (
    <div className={`phase-node ${selected ? 'phase-node-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="shot-handle" isConnectable={true} />
      <Handle type="target" position={Position.Left} id="left-in" className="shot-handle shot-handle-side" isConnectable={true} />

      <div className="phase-header">
        <span className="phase-id">P{data.phaseId || '?'}</span>
        <span className="phase-name">{data.label || data.name || '阶段'}</span>
      </div>

      {activate.length > 0 && (
        <div className="phase-activate">
          {activate.slice(0, maxShow).map((name, i) => (
            <span key={i} className="phase-entity-tag">+{getLabel(name)}</span>
          ))}
          {activate.length > maxShow && <span className="phase-more">+{activate.length - maxShow} more</span>}
        </div>
      )}

      {data.endCondition && (
        <div className="phase-end-condition">
          ✅ {data.endCondition.length > 40 ? data.endCondition.slice(0, 40) + '…' : data.endCondition}
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
