import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

const TEMPLATE_EMOJI = {
  'Static': '🌲',
  'PlayerController': '🧍',
  'Buildable': '🔨',
  'Shooter': '🏹',
  'Mover': '🚶',
  'Mover+Damageable': '👹',
  'Spawner': '♻️',
  'Collectible': '💰',
  'Draggable': '✋',
  'Damageable': '❤️',
  'Upgradeable': '⬆️',
  'Buildable+Shooter': '🏗️',
  'Projectile': '🎯',
  'UI': '💬',
};

const TEMPLATE_COLOR = {
  'Static': '#4a5568',
  'PlayerController': '#2b6cb0',
  'Buildable': '#b7791f',
  'Shooter': '#9b2c2c',
  'Mover': '#2f855a',
  'Mover+Damageable': '#c53030',
  'Spawner': '#6b46c1',
  'Collectible': '#d69e2e',
  'Draggable': '#dd6b20',
  'Damageable': '#e53e3e',
  'Upgradeable': '#38a169',
  'Buildable+Shooter': '#975a16',
  'Projectile': '#c05621',
  'UI': '#3182ce',
};

function EntityNode({ data, selected }) {
  const template = data.template || 'Static';
  const emoji = TEMPLATE_EMOJI[template] || '📦';
  const borderColor = selected ? '#fff' : (TEMPLATE_COLOR[template] || '#4a5568');
  const bgColor = TEMPLATE_COLOR[template] || '#4a5568';

  // Parse spawn condition for display
  const spawnCond = data.spawn?.condition || '';
  let spawnLabel = '';
  if (spawnCond === 'runtime') {
    spawnLabel = '🔄 对象池';
  } else if (spawnCond.startsWith('phase:')) {
    spawnLabel = '📍 Phase ' + spawnCond.split(':')[1];
  } else if (spawnCond.startsWith('entity:')) {
    spawnLabel = '⚡ ' + spawnCond.split(':')[1];
  } else if (spawnCond) {
    spawnLabel = '⚡ ' + spawnCond;
  }

  // Key behavior info
  const bh = data.behavior || {};
  let behaviorLine = '';
  if (bh.hp) behaviorLine += `HP:${bh.hp} `;
  if (bh.moveSpeed) behaviorLine += `速:${bh.moveSpeed} `;
  if (bh.fireRate) behaviorLine += `射速:${bh.fireRate}s `;
  if (bh.buildTime) behaviorLine += `建造:${bh.buildTime}s `;
  if (bh.spawnEntity) behaviorLine += `生成:${bh.spawnEntity} `;
  if (bh.damage) behaviorLine += `伤害:${bh.damage} `;

  return (
    <div
      style={{
        background: '#1a1a2e',
        border: `2px solid ${borderColor}`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 160,
        maxWidth: 220,
        fontSize: 12,
        color: '#e2e8f0',
        boxShadow: selected ? '0 0 12px rgba(255,255,255,0.3)' : '0 2px 8px rgba(0,0,0,0.3)',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: '#7c5cfc' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#7c5cfc' }} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 16 }}>{emoji}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {data.name || '未命名'}
          </div>
          {data.label && data.label !== data.name && (
            <div style={{ color: '#a0aec0', fontSize: 10 }}>{data.label}</div>
          )}
        </div>
        <span
          style={{
            background: bgColor,
            color: '#fff',
            padding: '1px 6px',
            borderRadius: 4,
            fontSize: 9,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {template}
        </span>
      </div>

      {/* Visual */}
      {data.visual && (
        <div style={{ color: '#a0aec0', fontSize: 10, marginBottom: 2 }}>
          {data.visual.shape}({data.visual.scale})
          {data.visual.color && (
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                marginLeft: 4,
                verticalAlign: 'middle',
                background: parseColor(data.visual.color),
              }}
            />
          )}
        </div>
      )}

      {/* Spawn condition */}
      {spawnLabel && (
        <div style={{ color: '#81e6d9', fontSize: 10, marginBottom: 2 }}>{spawnLabel}</div>
      )}

      {/* Behavior summary */}
      {behaviorLine && (
        <div style={{ color: '#fbd38d', fontSize: 10 }}>{behaviorLine.trim()}</div>
      )}
    </div>
  );
}

function parseColor(colorStr) {
  if (!colorStr) return '#888';
  const m = colorStr.match(/\(([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\)/);
  if (!m) return '#888';
  const r = Math.round(parseFloat(m[1]) * 255);
  const g = Math.round(parseFloat(m[2]) * 255);
  const b = Math.round(parseFloat(m[3]) * 255);
  return `rgb(${r},${g},${b})`;
}

export default memo(EntityNode);
