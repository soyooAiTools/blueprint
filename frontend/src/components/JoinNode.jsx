import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

function JoinNode({ data, selected }) {
  return (
    <div className={`join-node ${selected ? 'join-node-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="join-handle" />
      <div className="join-diamond">
        <span>{data.label || '汇合'}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="join-handle" />
    </div>
  );
}

export default memo(JoinNode);
