import { useState, useCallback, useRef, useEffect } from 'react';
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

function placeholderSvg(frameId, description) {
  const desc = (description || '').slice(0, 40).replace(/[<>&"]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150">
    <rect width="200" height="150" fill="#1a1a2e"/>
    <rect x="1" y="1" width="198" height="148" fill="none" stroke="#333" stroke-width="1" rx="8"/>
    <text x="100" y="60" text-anchor="middle" fill="#555" font-size="36" font-family="sans-serif">#${frameId}</text>
    <text x="100" y="90" text-anchor="middle" fill="#444" font-size="11" font-family="sans-serif">${desc}</text>
    <text x="100" y="130" text-anchor="middle" fill="#333" font-size="10" font-family="sans-serif">待生成</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export default function StoryboardPanel({ projectId, onConvertToBlueprint, hasExistingNodes, showAlert, showConfirm }) {
  const [text, setText] = useState('');
  const [frames, setFrames] = useState([]);
  const [loading, setLoading] = useState(false);
  const [parseProgress, setParseProgress] = useState(null);
  const [parseStage, setParseStage] = useState('');
  const progressTimer = useRef(null);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(false);

  // Frame editing
  const [editingFrameId, setEditingFrameId] = useState(null);
  const [editInstruction, setEditInstruction] = useState('');
  const [editingLoading, setEditingLoading] = useState(false);

  const [docFiles, setDocFiles] = useState([]);
  const [refImages, setRefImages] = useState([]);
  const docInputRef = useRef(null);
  const imgInputRef = useRef(null);
  const [orientation, setOrientation] = useState('landscape');
  const [cameraAngle, setCameraAngle] = useState('isometric45');
  const [perspective, setPerspective] = useState('third');
  const [style, setStyle] = useState('');

  useEffect(() => {
    return () => { if (progressTimer.current) clearInterval(progressTimer.current); };
  }, []);

  const handleDocFiles = useCallback((files) => {
    const valid = Array.from(files).filter((f) => /\.(doc|docx|xls|xlsx|csv|txt)$/i.test(f.name));
    if (valid.length) setDocFiles((prev) => [...prev, ...valid]);
  }, []);
  const removeDoc = useCallback((idx) => setDocFiles((prev) => prev.filter((_, i) => i !== idx)), []);

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

  const handleDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    const files = e.dataTransfer.files;
    const docs = [], imgs = [];
    Array.from(files).forEach((f) => {
      if (/\.(doc|docx|xls|xlsx|csv|txt)$/i.test(f.name)) docs.push(f);
      else if (f.type.startsWith('image/')) imgs.push(f);
    });
    if (docs.length) handleDocFiles(docs);
    if (imgs.length) handleImageFiles(imgs);
  }, [handleDocFiles, handleImageFiles]);
  const handleDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation(); }, []);

  const startProgress = useCallback(() => {
    setParseProgress(0); setParseStage('准备中...');
    let p = 0;
    const stages = [
      { at: 10, text: '上传文件中...' },
      { at: 30, text: '上传完成，AI 解析中...' },
      { at: 60, text: 'AI 解析中...' },
      { at: 85, text: '处理结果中...' },
    ];
    if (progressTimer.current) clearInterval(progressTimer.current);
    progressTimer.current = setInterval(() => {
      p += Math.random() * 8 + 2;
      if (p > 90) p = 90;
      const stage = [...stages].reverse().find((s) => p >= s.at);
      if (stage) setParseStage(stage.text);
      setParseProgress(Math.round(p));
    }, 400);
  }, []);

  const finishProgress = useCallback(() => {
    if (progressTimer.current) { clearInterval(progressTimer.current); progressTimer.current = null; }
    setParseProgress(100); setParseStage('完成！');
    setTimeout(() => { setParseProgress(null); setParseStage(''); }, 1200);
  }, []);

  const handleParse = useCallback(async () => {
    if (!text.trim() && docFiles.length === 0) return;
    setLoading(true); setGenerated(false);
    startProgress();
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
      const parsedFrames = Array.isArray(data) ? data : data.frames || [];
      setFrames(parsedFrames.map((f) => ({ ...f, imageUrl: f.imageUrl || null })));
      finishProgress();
    } catch (err) {
      finishProgress();
      await showAlert('⚠️ 分镜解析失败: ' + err.message);
    }
    setLoading(false);
  }, [text, docFiles, refImages, orientation, cameraAngle, perspective, style, projectId, showAlert, startProgress, finishProgress]);

  const handleGenerate = useCallback(async () => {
    if (frames.length === 0) return;
    setGenerating(true);
    try {
      const resp = await fetch(`${API_BASE}/api/projects/${projectId}/generate-storyboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frames }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      setFrames(data.frames || frames);
      setGenerated(true);
    } catch (err) {
      console.warn('Generate API failed, using placeholders:', err.message);
      setFrames((prev) => prev.map((f) => ({
        ...f, imageUrl: f.imageUrl || placeholderSvg(f.id, f.interaction || f.title),
      })));
      setGenerated(true);
    }
    setGenerating(false);
  }, [frames, projectId]);

  // Edit frame with natural language
  const handleEditFrame = useCallback(async (frameId) => {
    if (!editInstruction.trim()) return;
    const frame = frames.find((f) => f.id === frameId);
    if (!frame) return;
    setEditingLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/projects/${projectId}/edit-frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frameIndex: frames.indexOf(frame),
          instruction: editInstruction,
          frame,
        }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      setFrames((prev) => prev.map((f) => f.id === frameId ? { ...data.frame, imageUrl: f.imageUrl } : f));
      setEditingFrameId(null);
      setEditInstruction('');
    } catch (err) {
      await showAlert('⚠️ 编辑失败: ' + err.message);
    }
    setEditingLoading(false);
  }, [editInstruction, frames, projectId, showAlert]);

  const handleConvert = useCallback(async () => {
    if (frames.length === 0) return;
    if (hasExistingNodes) {
      const yes = await showConfirm(`画布已有内容。转为蓝图将追加 ${frames.length} 个镜头节点到画布，确认继续？`);
      if (!yes) return;
    }
    const { nodes, edges } = framesToNodesEdges(frames);
    onConvertToBlueprint(nodes, edges);
  }, [frames, onConvertToBlueprint, hasExistingNodes, showConfirm]);

  const handleClearFrames = useCallback(() => { setFrames([]); setGenerated(false); }, []);

  const handleUpdateFrame = useCallback((frameId, field, value) => {
    setFrames((prev) => prev.map((f) => (f.id === frameId ? { ...f, [field]: value } : f)));
  }, []);

  const toggleEdit = useCallback((frameId) => {
    if (editingFrameId === frameId) {
      setEditingFrameId(null);
      setEditInstruction('');
    } else {
      setEditingFrameId(frameId);
      setEditInstruction('');
    }
  }, [editingFrameId]);

  return (
    <div className="storyboard-panel" onDrop={handleDrop} onDragOver={handleDragOver}>
      {/* Document Upload */}
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">📎 文档上传</h3>
        <div className="sb-upload-zone" onClick={() => docInputRef.current?.click()}>
          <input ref={docInputRef} type="file" accept={ACCEPTED_DOCS} multiple style={{ display: 'none' }}
            onChange={(e) => { handleDocFiles(e.target.files); e.target.value = ''; }} />
          <span className="sb-upload-icon">📄</span>
          <span className="sb-upload-text">点击或拖拽上传文档</span>
          <span className="sb-upload-hint">支持 doc, docx, xls, xlsx, csv, txt</span>
        </div>
        {docFiles.length > 0 && (
          <div className="sb-file-list">
            {docFiles.map((f, i) => (
              <div key={i} className="sb-file-tag"><span>📄 {f.name}</span><button onClick={() => removeDoc(i)}>×</button></div>
            ))}
          </div>
        )}
      </div>

      {/* Text Input */}
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">📝 策划文案</h3>
        <textarea className="storyboard-textarea" placeholder="粘贴策划文案，每段之间空一行分隔不同帧..."
          value={text} onChange={(e) => setText(e.target.value)} rows={8} />
      </div>

      {/* Reference Images */}
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">🖼 参考图片</h3>
        <p className="storyboard-hint">上传的参考图片会用 AI 解析内容和风格，融入分镜生成</p>
        <div className="sb-images-area">
          {refImages.map((img, i) => (
            <div key={i} className="sb-image-thumb-wrap">
              <img src={img.preview} alt="" className="sb-image-thumb" />
              <button className="sb-image-remove" onClick={() => removeImage(i)}>×</button>
            </div>
          ))}
          <div className="sb-image-add" onClick={() => imgInputRef.current?.click()}>
            <input ref={imgInputRef} type="file" accept={ACCEPTED_IMAGES} multiple style={{ display: 'none' }}
              onChange={(e) => { handleImageFiles(e.target.files); e.target.value = ''; }} />
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
              <input type="radio" name="orientation" value="landscape" checked={orientation === 'landscape'} onChange={() => setOrientation('landscape')} /> 横屏
            </label>
            <label className={'sb-radio' + (orientation === 'portrait' ? ' sb-radio-active' : '')}>
              <input type="radio" name="orientation" value="portrait" checked={orientation === 'portrait'} onChange={() => setOrientation('portrait')} /> 竖屏
            </label>
          </div>
        </div>
        <div className="sb-option-row">
          <span className="sb-option-label">相机角度</span>
          <select className="sb-select" value={cameraAngle} onChange={(e) => setCameraAngle(e.target.value)}>
            {CAMERA_ANGLES.map((a) => (<option key={a.value} value={a.value}>{a.label}</option>))}
          </select>
        </div>
        <div className="sb-option-row">
          <span className="sb-option-label">视角</span>
          <div className="sb-radio-group">
            <label className={'sb-radio' + (perspective === 'third' ? ' sb-radio-active' : '')}>
              <input type="radio" name="perspective" value="third" checked={perspective === 'third'} onChange={() => setPerspective('third')} /> 第三人称
            </label>
            <label className={'sb-radio' + (perspective === 'first' ? ' sb-radio-active' : '')}>
              <input type="radio" name="perspective" value="first" checked={perspective === 'first'} onChange={() => setPerspective('first')} /> 第一人称
            </label>
          </div>
        </div>
        <div className="sb-option-row">
          <span className="sb-option-label">额外风格</span>
          <input className="sb-style-input" type="text" placeholder="可选：如「卡通风」「写实」..." value={style} onChange={(e) => setStyle(e.target.value)} />
        </div>
      </div>

      {/* Parse Button + Progress */}
      <div className="storyboard-input-section">
        <button className="storyboard-btn storyboard-btn-parse" onClick={handleParse}
          disabled={loading || (!text.trim() && docFiles.length === 0)}>
          {loading ? '⏳ 解析中...' : '🎬 解析分镜'}
        </button>
        {parseProgress !== null && (
          <div className="parse-progress-bar">
            <div className="parse-progress-fill" style={{ width: `${parseProgress}%` }} />
            <span className="parse-progress-text">{parseProgress}% {parseStage}</span>
          </div>
        )}
      </div>

      {/* Generate Storyboard Button */}
      {frames.length > 0 && !generated && (
        <div className="storyboard-input-section">
          <button className="storyboard-btn generate-storyboard-btn" onClick={handleGenerate} disabled={generating}>
            {generating ? '⏳ 生成中...' : '🎨 生成分镜'}
          </button>
          <p className="storyboard-hint">为每帧生成 AI 配图，排版成分镜板</p>
        </div>
      )}

      {/* Frames Preview */}
      {frames.length > 0 && (
        <div className="storyboard-frames-section">
          <div className="storyboard-frames-header">
            <h3 className="storyboard-section-title">🎞 分镜预览 ({frames.length} 帧)</h3>
          </div>
          <div className="storyboard-frames-list">
            {frames.map((frame) => (
              <div key={frame.id} className="storyboard-frame-card">
                <div className="storyboard-frame-header">
                  <span className="storyboard-frame-number">#{frame.id}</span>
                  <input className="storyboard-frame-title-input" value={frame.title}
                    onChange={(e) => handleUpdateFrame(frame.id, 'title', e.target.value)} placeholder="帧标题" />
                  <button className="storyboard-frame-edit-btn" onClick={() => toggleEdit(frame.id)}
                    title="用自然语言编辑此帧">✏️</button>
                </div>
                {/* AI Edit Bar */}
                {editingFrameId === frame.id && (
                  <div className="storyboard-frame-edit-bar">
                    <input
                      className="storyboard-frame-edit-input"
                      placeholder="描述修改需求，如「把场景改成室内」「增加一个 NPC」..."
                      value={editInstruction}
                      onChange={(e) => setEditInstruction(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditFrame(frame.id); } }}
                      disabled={editingLoading}
                      autoFocus
                    />
                    <button className="storyboard-btn storyboard-frame-edit-apply"
                      onClick={() => handleEditFrame(frame.id)}
                      disabled={editingLoading || !editInstruction.trim()}>
                      {editingLoading ? '⏳' : '✨ 应用'}
                    </button>
                  </div>
                )}
                <div className="storyboard-frame-body">
                  {/* Left: Image */}
                  <div className="storyboard-frame-image">
                    {frame.imageUrl ? (
                      <img src={frame.imageUrl} alt={frame.title} />
                    ) : (
                      <div className="storyboard-frame-placeholder">
                        <span className="placeholder-number">#{frame.id}</span>
                        <span className="placeholder-text">待生成</span>
                      </div>
                    )}
                  </div>
                  {/* Right: Content */}
                  <div className="storyboard-frame-content">
                    <div className="storyboard-frame-field">
                      <span className="storyboard-field-label">🎮 交互</span>
                      <textarea className="storyboard-frame-edit" value={frame.interaction || ''}
                        onChange={(e) => handleUpdateFrame(frame.id, 'interaction', e.target.value)}
                        placeholder="描述交互行为..." rows={3} />
                    </div>
                    <div className="storyboard-frame-field">
                      <span className="storyboard-field-label">🖥 UI</span>
                      <textarea className="storyboard-frame-edit" value={frame.ui || ''}
                        onChange={(e) => handleUpdateFrame(frame.id, 'ui', e.target.value)}
                        placeholder="描述 UI 元素..." rows={2} />
                    </div>
                    {frame.description && (
                      <div className="storyboard-frame-field">
                        <span className="storyboard-field-label">📝 描述</span>
                        <p style={{ margin: 0, color: '#ccc', fontSize: 13, lineHeight: 1.5 }}>{frame.description}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* Bottom Action Bar */}
          <div className="storyboard-bottom-bar">
            <button className="storyboard-btn storyboard-bottom-btn storyboard-btn-clear" onClick={handleClearFrames}>
              🗑 清空帧
            </button>
            {!generated && (
              <button className="storyboard-btn storyboard-bottom-btn generate-storyboard-btn" onClick={handleGenerate} disabled={generating}>
                {generating ? '⏳ 生成中...' : '🎨 生成分镜'}
              </button>
            )}
            <button className="storyboard-btn storyboard-bottom-btn storyboard-btn-convert" onClick={handleConvert}
              disabled={!generated} title={!generated ? '请先点击"生成分镜"' : ''}>
              🗺 转为蓝图
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
