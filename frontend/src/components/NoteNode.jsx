import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

function NoteNode({ data, selected }) {
  return (
    <div className={`note-node ${selected ? 'note-node-selected' : ''}`}>
      <Handle
        type="target"
        position={Position.Top}
        className="note-handle"
        isConnectable={true}
      />

      <div className="note-icon">📝</div>
      <div className="note-text">{data.text || '双击编辑注释...'}</div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="note-handle"
        isConnectable={true}
      />

      {/* 额外左右连接点，方便横向连线 */}
      <Handle
        type="target"
        position={Position.Left}
        id="left-in"
        className="note-handle note-handle-side"
        isConnectable={true}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right-out"
        className="note-handle note-handle-side"
        isConnectable={true}
      />
    </div>
  );
}

export default memo(NoteNode);
