import { useState, useCallback } from 'react';
import { useModal } from './ModalProvider';

const API_BASE = import.meta.env.VITE_API_BASE || '';

/**
 * Convert frames → blueprint nodes + edges (mirrors frames-to-blueprint.cjs logic)
 */
function framesToNodesEdges(frames) {
  const Y_SPACING = 400;
  const nodes = [];
  const edges = [];

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const shotId = `shot_${Date.now()}_${i + 1}`;
    nodes.push({
      id: shotId,
      type: 'shotNode',
      position: { x: 300, y: i * Y_SPACING },
      data: {
        label: f.title || `镜头${i + 1}`,
        name: f.title || '',
        scene: f.prompt || '',
        controlTarget: '【待填写】',
        controlMethod: '【待填写】',
        triggers: f.interaction || '',
        endCondition: '',
      },
    });

    if (i > 0) {
      edges.push({
        id: `e_${nodes[i - 1].id}_${shotId}`,
        source: nodes[i - 1].id,
        target: shotId,
        type: 'smoothstep',
        animated: true,
        style: { stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2 },
        markerEnd: { type: 'arrowclosed', color: 'rgba(255,255,255,0.5)' },
      });
    }
  }

  return { nodes, edges };
}

export default function StoryboardPanel({ projectId, onConvertToBlueprint, hasExistingNodes }) {
  const [text, setText] = useState('');
  const [frames, setFrames] = useState([]);
  const [loading, setLoading] = useState(false);
  const { showAlert, showConfirm } = useModal();

  const handleParse = useCallback(async () => {
    if (!text.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/parse-storyboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const data = await res.json();
        setFrames(Array.isArray(data) ? data : data.frames || []);
        setLoading(false);
        return;
      }
    } catch {
      // API not available — show error instead of silent fallback
    }
    await showAlert('⚠️ 分镜解析服务暂不可用，请稍后重试');
    setLoading(false);
  }, [text, projectId, showAlert]);

  const handleConvert = useCallback(async () => {
    if (frames.length === 0) return;
    if (hasExistingNodes) {
      const yes = await showConfirm(
        `画布已有内容。转为蓝图将追加 ${frames.length} 个镜头节点到画布，确认继续？`
      );
      if (!yes) return;
    }
    const { nodes, edges } = framesToNodesEdges(frames);
    onConvertToBlueprint(nodes, edges);
  }, [frames, onConvertToBlueprint, hasExistingNodes, showConfirm]);

  const handleClearFrames = useCallback(() => {
    setFrames([]);
  }, []);

  const handleUpdateFrame = useCallback((frameId, field, value) => {
    setFrames((prev) =>
      prev.map((f) => (f.id === frameId ? { ...f, [field]: value } : f))
    );
  }, []);

  return (
    <div className="storyboard-panel">
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">📝 策划文案</h3>
        <textarea
          className="storyboard-textarea"
          placeholder="粘贴策划文案，每段之间空一行分隔不同帧..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
        />
        <button
          className="storyboard-btn storyboard-btn-parse"
          onClick={handleParse}
          disabled={loading || !text.trim()}
        >
          {loading ? '⏳ 解析中...' : '🎬 解析分镜'}
        </button>
      </div>

      {frames.length > 0 && (
        <div className="storyboard-frames-section">
          <div className="storyboard-frames-header">
            <h3 className="storyboard-section-title">🎞 分镜预览 ({frames.length} 帧)</h3>
            <div className="storyboard-frames-actions">
              <button
                className="storyboard-btn storyboard-btn-clear"
                onClick={handleClearFrames}
              >
                🗑 清空帧
              </button>
              <button
                className="storyboard-btn storyboard-btn-convert"
                onClick={handleConvert}
              >
                🗺 转为蓝图
              </button>
            </div>
          </div>
          <div className="storyboard-frames-list">
            {frames.map((frame) => (
              <div key={frame.id} className="storyboard-frame-card">
                <div className="storyboard-frame-header">
                  <span className="storyboard-frame-number">#{frame.id}</span>
                  <input
                    className="storyboard-frame-title-input"
                    value={frame.title}
                    onChange={(e) => handleUpdateFrame(frame.id, 'title', e.target.value)}
                    placeholder="帧标题"
                  />
                </div>
                <div className="storyboard-frame-field">
                  <span className="storyboard-field-label">🎮 交互</span>
                  <textarea
                    className="storyboard-frame-edit"
                    value={frame.interaction || ''}
                    onChange={(e) => handleUpdateFrame(frame.id, 'interaction', e.target.value)}
                    placeholder="描述交互行为..."
                    rows={3}
                  />
                </div>
                <div className="storyboard-frame-field">
                  <span className="storyboard-field-label">🖥 UI</span>
                  <textarea
                    className="storyboard-frame-edit"
                    value={frame.ui || ''}
                    onChange={(e) => handleUpdateFrame(frame.id, 'ui', e.target.value)}
                    placeholder="描述 UI 元素..."
                    rows={2}
                  />
                </div>
                {frame.prompt && (
                  <div className="storyboard-frame-field storyboard-frame-image-area">
                    <img
                      src={`${API_BASE}/api/projects/${projectId}/frames/frame-${String(frame.id).padStart(2, '0')}.png`}
                      alt={frame.title}
                      className="storyboard-frame-img"
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
