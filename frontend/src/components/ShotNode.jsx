import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

function ShotNode({ id, data, selected }) {
  const truncate = (text, max = 80) => {
    if (!text) return '—';
    return text.length > max ? text.slice(0, max) + '…' : text;
  };

  const hasBranch1 = !!data.branchCondition;
  const hasBranch2 = !!data.branchCondition2;
  const hasAnyBranch = hasBranch1 || hasBranch2;

  return (
    <div className={`shot-node ${selected ? 'shot-node-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="shot-handle" isConnectable={true} />
      <Handle type="target" position={Position.Left} id="left-in" className="shot-handle shot-handle-side" isConnectable={true} />

      <div className="shot-header">
        <span>📷 {data.label || '镜头'}</span>
      </div>

      {data.name && (
        <div className="shot-name">
          {data.name}
        </div>
      )}

      {/* 图片展示 */}
      {data.images && data.images.length > 0 && (
        <div className="shot-images">
          {data.images.map((img, i) => (
            <img key={i} src={img} className="shot-image-thumb" alt={`参考图${i + 1}`} />
          ))}
        </div>
      )}

      {data.entryCondition && (
        <div className="shot-section shot-entry-condition">
          <div className="shot-section-title">🔑 进入条件</div>
          <div className="shot-section-content">{truncate(data.entryCondition)}</div>
        </div>
      )}

      <div className="shot-section">
        <div className="shot-section-title">🎬 画面描述</div>
        <div className="shot-section-content">{truncate(data.scene, 120)}</div>
      </div>

      {data.behavior && (
        <div className="shot-section shot-behavior">
          <div className="shot-section-title">📊 数值设定</div>
          <div className="shot-section-content">{truncate(data.behavior, 120)}</div>
        </div>
      )}

      <div className="shot-section">
        <div className="shot-section-title">🎮 操控</div>
        <div className="shot-section-content">
          {data.controlTarget && <div>对象：{data.controlTarget}</div>}
          {data.controlMethod && <div>方式：{data.controlMethod}</div>}
          {!data.controlTarget && !data.controlMethod && <div>—</div>}
        </div>
      </div>

      <div className="shot-section">
        <div className="shot-section-title">⚡ 触发行为</div>
        <div className="shot-section-content">{truncate(data.triggers, 120)}</div>
      </div>

      <div className="shot-section">
        <div className="shot-section-title">✅ 结束条件</div>
        <div className="shot-section-content">{truncate(data.endCondition)}</div>
      </div>

      {hasBranch1 && (
        <div className="shot-section shot-branch">
          <div className="shot-section-title">🔀 条件分支 1</div>
          <div className="shot-section-content">
            <div className="branch-condition">判断：{truncate(data.branchCondition, 60)}</div>
            {data.branchTrue && <div className="branch-true">✅ 满足 → {data.branchTrue}</div>}
            {data.branchFalse && <div className="branch-false">❌ 不满足 → {data.branchFalse}</div>}
          </div>
        </div>
      )}

      {hasBranch2 && (
        <div className="shot-section shot-branch shot-branch-2">
          <div className="shot-section-title">🔀 条件分支 2</div>
          <div className="shot-section-content">
            <div className="branch-condition">判断：{truncate(data.branchCondition2, 60)}</div>
            {data.branchTrue2 && <div className="branch-true">✅ 满足 → {data.branchTrue2}</div>}
            {data.branchFalse2 && <div className="branch-false">❌ 不满足 → {data.branchFalse2}</div>}
          </div>
        </div>
      )}

      {!hasAnyBranch && (
        <div className="shot-footer">
          <span>○ 出口</span>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="shot-handle" isConnectable={true} />
      <Handle type="source" position={Position.Right} id="right-out" className="shot-handle shot-handle-side" isConnectable={true} />
    </div>
  );
}

export default memo(ShotNode);
