import { useState, useCallback, useRef } from 'react';
import { parseStoryboard } from '../utils/api';

const API_BASE = import.meta.env.VITE_API_BASE || '';

const ACCEPTED_DOCS = '.doc,.docx,.xls,.xlsx,.csv,.txt';
const ACCEPTED_IMAGES = 'image/png,image/jpeg,image/gif,image/webp';

const CAMERA_ANGLES = [
  { value: 'isometric45', label: '等距45°' },
  { value: 'sidescroll', label: '横版卷轴' },
  { value: 'topdown', label: '俯视' },
  { value: 'threequarter', label: '3/4视角' },
];

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

export default function StoryboardPanel({ projectId, onConvertToBlueprint, hasExistingNodes, showAlert, showConfirm }) {
  const [text, setText] = useState('');
  const [frames, setFrames] = useState([]);
  const [loading, setLoading] = useState(false);

  // File uploads
  const [docFiles, setDocFiles] = useState([]);
  const [refImages, setRefImages] = useState([]); // { file, preview }
  const docInputRef = useRef(null);
  const imgInputRef = useRef(null);

  // Camera options
  const [orientation, setOrientation] = useState('landscape');
  const [cameraAngle, setCameraAngle] = useState('isometric45');
  const [perspective, setPerspective] = useState('third');
  const [style, setStyle] = useState('');

  // Doc file handling
  const handleDocFiles = useCallback((files) => {
    const valid = Array.from(files).filter((f) => /\.(doc|docx|xls|xlsx|csv|txt)$/i.test(f.name));
    if (valid.length) setDocFiles((prev) => [...prev, ...valid]);
  }, []);

  const removeDoc = useCallback((idx) => {
    setDocFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Image handling
  const handleImageFiles = useCallback((files) => {
    const valid = Array.from(files).filter((f) => f.type.startsWith('image/'));
    const newImgs = valid.map((f) => ({ file: f, preview: URL.createObjectURL(f) }));
    setRefImages((prev) => [...prev, ...newImgs]);
  }, []);

  const removeImage = useCallback((idx) => {
    setRefImages((prev) => {
      const removed = prev[idx];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  // Drag & drop
  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer.files;
    const docs = [];
    const imgs = [];
    Array.from(files).forEach((f) => {
      if (/\.(doc|docx|xls|xlsx|csv|txt)$/i.test(f.name)) docs.push(f);
      else if (f.type.startsWith('image/')) imgs.push(f);
    });
    if (docs.length) handleDocFiles(docs);
    if (imgs.length) handleImageFiles(imgs);
  }, [handleDocFiles, handleImageFiles]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleParse = useCallback(async () => {
    if (!text.trim() && docFiles.length === 0) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('text', text);
      formData.append('orientation', orientation);
      formData.append('cameraAngle', cameraAngle);
      formData.append('perspective', perspective);
      if (style.trim()) formData.append('style', style.trim());
      docFiles.forEach((f) => formData.append('files', f));
      refImages.forEach((img) => formData.append('images', img.file));

      const data = await parseStoryboard(projectId, formData);
      setFrames(Array.isArray(data) ? data : data.frames || []);
    } catch (err) {
      await showAlert('⚠️ 分镜解析失败: ' + err.message);
    }
    setLoading(false);
  }, [text, docFiles, refImages, orientation, cameraAngle, perspective, style, projectId, showAlert]);

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
    <div className="storyboard-panel" onDrop={handleDrop} onDragOver={handleDragOver}>
      {/* Document Upload */}
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">📎 文档上传</h3>
        <div
          className="sb-upload-zone"
          onClick={() => docInputRef.current?.click()}
        >
          <input
            ref={docInputRef}
            type="file"
            accept={ACCEPTED_DOCS}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { handleDocFiles(e.target.files); e.target.value = ''; }}
          />
          <span className="sb-upload-icon">📄</span>
          <span className="sb-upload-text">点击或拖拽上传文档</span>
          <span className="sb-upload-hint">支持 doc, docx, xls, xlsx, csv, txt</span>
        </div>
        {docFiles.length > 0 && (
          <div className="sb-file-list">
            {docFiles.map((f, i) => (
              <div key={i} className="sb-file-tag">
                <span>📄 {f.name}</span>
                <button onClick={() => removeDoc(i)}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Text Input */}
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">📝 策划文案</h3>
        <textarea
          className="storyboard-textarea"
          placeholder="粘贴策划文案，每段之间空一行分隔不同帧..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
        />
      </div>

      {/* Reference Images */}
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">🖼 参考图片</h3>
        <div className="sb-images-area">
          {refImages.map((img, i) => (
            <div key={i} className="sb-image-thumb-wrap">
              <img src={img.preview} alt="" className="sb-image-thumb" />
              <button className="sb-image-remove" onClick={() => removeImage(i)}>×</button>
            </div>
          ))}
          <div className="sb-image-add" onClick={() => imgInputRef.current?.click()}>
            <input
              ref={imgInputRef}
              type="file"
              accept={ACCEPTED_IMAGES}
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { handleImageFiles(e.target.files); e.target.value = ''; }}
            />
            <span>+ 添加图片</span>
          </div>
        </div>
      </div>

      {/* Camera Options */}
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">🎥 镜头方式</h3>

        <div className="sb-option-row">
          <span className="sb-option-label">画面方向</span>
          <div className="sb-radio-group">
            <label className={'sb-radio' + (orientation === 'landscape' ? ' sb-radio-active' : '')}>
              <input type="radio" name="orientation" value="landscape" checked={orientation === 'landscape'} onChange={() => setOrientation('landscape')} />
              横屏
            </label>
            <label className={'sb-radio' + (orientation === 'portrait' ? ' sb-radio-active' : '')}>
              <input type="radio" name="orientation" value="portrait" checked={orientation === 'portrait'} onChange={() => setOrientation('portrait')} />
              竖屏
            </label>
          </div>
        </div>

        <div className="sb-option-row">
          <span className="sb-option-label">相机角度</span>
          <select className="sb-select" value={cameraAngle} onChange={(e) => setCameraAngle(e.target.value)}>
            {CAMERA_ANGLES.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </div>

        <div className="sb-option-row">
          <span className="sb-option-label">视角</span>
          <div className="sb-radio-group">
            <label className={'sb-radio' + (perspective === 'third' ? ' sb-radio-active' : '')}>
              <input type="radio" name="perspective" value="third" checked={perspective === 'third'} onChange={() => setPerspective('third')} />
              第三人称
            </label>
            <label className={'sb-radio' + (perspective === 'first' ? ' sb-radio-active' : '')}>
              <input type="radio" name="perspective" value="first" checked={perspective === 'first'} onChange={() => setPerspective('first')} />
              第一人称
            </label>
          </div>
        </div>

        <div className="sb-option-row">
          <span className="sb-option-label">额外风格</span>
          <input
            className="sb-style-input"
            type="text"
            placeholder="可选：如「卡通风」「写实」..."
            value={style}
            onChange={(e) => setStyle(e.target.value)}
          />
        </div>
      </div>

      {/* Parse Button */}
      <div className="storyboard-input-section">
        <button
          className="storyboard-btn storyboard-btn-parse"
          onClick={handleParse}
          disabled={loading || (!text.trim() && docFiles.length === 0)}
        >
          {loading ? '⏳ 解析中...' : '🎬 解析分镜'}
        </button>
      </div>

      {/* Frames Preview */}
      {frames.length > 0 && (
        <div className="storyboard-frames-section">
          <div className="storyboard-frames-header">
            <h3 className="storyboard-section-title">🎞 分镜预览 ({frames.length} 帧)</h3>
            <div className="storyboard-frames-actions">
              <button className="storyboard-btn storyboard-btn-clear" onClick={handleClearFrames}>
                🗑 清空帧
              </button>
              <button className="storyboard-btn storyboard-btn-convert" onClick={handleConvert}>
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
