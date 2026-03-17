import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

const INPUT_ICONS = {
  virtualJoystick: '🕹️',
  tap: '👆',
  drag: '✋',
  swipe: '👉',
  none: '🚫',
};

function extractNewObjects(sceneObjects) {
  if (!sceneObjects) return [];
  const names = [];
  for (const line of sceneObjects.split('\n')) {
    const m = line.match(/^-\s*(\S+)\s*\|/);
    if (m) names.push(m[1]);
  }
  return names;
}

function ShotNode({ id, data, selected }) {
  const truncate = (text, max = 50) => {
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '…' : text;
  };

  const isV2 = !!(data.sceneObjects || data.triggerChain || data.params);
  const newObjects = isV2 ? extractNewObjects(data.sceneObjects) : [];
  const inputIcon = INPUT_ICONS[data.inputType] || '';

  return (
    <div className={`shot-node shot-node-compact ${selected ? 'shot-node-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="shot-handle" isConnectable={true} />
      <Handle type="target" position={Position.Left} id="left-in" className="shot-handle shot-handle-side" isConnectable={true} />

      <div className="shot-header">
        <span>📷 {data.label || '镜头'}</span>
        {inputIcon && <span className="shot-input-icon" title={data.inputType}>{inputIcon}</span>}
      </div>

      {data.name && <div className="shot-name">{data.name}</div>}

      {data.images && data.images.length > 0 && (
        <div className="shot-images">
          {data.images.slice(0, 2).map((img, i) => (
            <img key={i} src={img} className="shot-image-thumb" alt={`参考图${i + 1}`} />
          ))}
        </div>
      )}

      {newObjects.length > 0 && (
        <div className="shot-new-objects">
          {newObjects.map((name, i) => (
            <span key={i} className="shot-obj-tag">+{name}</span>
          ))}
        </div>
      )}

      {/* V1 fallback: show brief scene if no V2 data */}
      {!isV2 && data.scene && (
        <div className="shot-section-brief">{truncate(data.scene, 60)}</div>
      )}

      {data.endCondition && (
        <div className="shot-end-condition">✅ {truncate(data.endCondition, 50)}</div>
      )}

      <Handle type="source" position={Position.Bottom} className="shot-handle" isConnectable={true} />
      <Handle type="source" position={Position.Right} id="right-out" className="shot-handle shot-handle-side" isConnectable={true} />
    </div>
  );
}

export default memo(ShotNode);
