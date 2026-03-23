import { useState, useCallback, useRef, useEffect } from 'react';
import { parseStoryboard, getProject, updateProject } from '../utils/api';

const API_BASE = import.meta.env.VITE_API_BASE || '';

const ACCEPTED_DOCS_WITH_STORYBOARD = '.pdf,.png,.jpg,.jpeg';
const ACCEPTED_DOCS_WITHOUT_STORYBOARD = '.pdf,.png,.jpg,.jpeg';
const ACCEPTED_IMAGES = 'image/png,image/jpeg';

const CAMERA_ANGLES = [
  { value: 'isometric45', label: '等距45°' },
  { value: 'sidescroll', label: '横版卷轴' },
  { value: 'topdown', label: '俯视' },
  { value: 'threequarter', label: '3/4视角' },
  { value: 'topdown45', label: '俯视斜45°正交' },
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
        entryCondition: i === 0 ? '游戏开始' : '',
        endCondition: '',
        // v2 fields
        sceneObjects: f.prompt || '',
        inputType: 'tap',
        inputConfig: '',
        triggerChain: f.interaction || '',
        params: '',
        assets: '',
        images: [],
        referenceNote: '',
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
  const [genProgress, setGenProgress] = useState(null);
  const [genStage, setGenStage] = useState('');
  const genTimer = useRef(null);

  // Frame editing
  const [editingFrameId, setEditingFrameId] = useState(null);
  const [editInstruction, setEditInstruction] = useState('');
  const [editingLoading, setEditingLoading] = useState(false);

  // Image lightbox
  const [lightboxUrl, setLightboxUrl] = useState(null);
  // Per-frame image generating state
  const [generatingFrameIds, setGeneratingFrameIds] = useState(new Set());

  const [hasStoryboard, setHasStoryboard] = useState(false);
  const [docFiles, setDocFiles] = useState([]);
  const [refImages, setRefImages] = useState([]);
  const docInputRef = useRef(null);
  const imgInputRef = useRef(null);
  const [orientation, setOrientation] = useState('landscape');
  const [cameraAngle, setCameraAngle] = useState('topdown45');
  const [perspective, setPerspective] = useState('third');
  const [style, setStyle] = useState('');
  const [targetFrames, setTargetFrames] = useState(15);
  const [styleRefFile, setStyleRefFile] = useState(null);
  const [styleRefUrl, setStyleRefUrl] = useState(null);
  const [styleRefPreview, setStyleRefPreview] = useState(null);
  const styleRefInputRef = useRef(null);
  const [charRefFile, setCharRefFile] = useState(null);
  const [charRefUrl, setCharRefUrl] = useState(null);
  const [charRefPreview, setCharRefPreview] = useState(null);
  const charRefInputRef = useRef(null);

  useEffect(() => {
    return () => { if (progressTimer.current) clearInterval(progressTimer.current); if (genTimer.current) clearInterval(genTimer.current); };
  }, []);

  // Load saved storyboard frames on mount
  useEffect(() => {
    if (!projectId) return;
    getProject(projectId).then((proj) => {
      if (proj.storyboardFrames && proj.storyboardFrames.length > 0) {
        setFrames(proj.storyboardFrames.map((f) => ({ ...f, imageUrl: f.imageUrl || null })));
        console.log('[Storyboard] Loaded', proj.storyboardFrames.length, 'saved frames');
      }
      if (proj.storyboardConfig) {
        if (proj.storyboardConfig.orientation) setOrientation(proj.storyboardConfig.orientation);
        if (proj.storyboardConfig.cameraAngle) setCameraAngle(proj.storyboardConfig.cameraAngle);
        if (proj.storyboardConfig.perspective) setPerspective(proj.storyboardConfig.perspective);
        if (proj.storyboardConfig.style) setStyle(proj.storyboardConfig.style);
      }
    }).catch(() => {});
  }, [projectId]);

  const isBusy = loading || generating;

  const handleDocFiles = useCallback((files) => {
    const MAX_SIZE = 10 * 1024 * 1024;
    const pattern = /\.(pdf|png|jpg|jpeg)$/i;
    const valid = Array.from(files).filter((f) => pattern.test(f.name));
    const oversized = valid.filter(f => f.size > MAX_SIZE);
    const ok = valid.filter(f => f.size <= MAX_SIZE);
    if (oversized.length) showAlert('⚠️ 以下文件超过 10MB 限制，已跳过：\n' + oversized.map(f => f.name + ' (' + (f.size/1024/1024).toFixed(1) + 'MB)').join('\n'));
    if (ok.length) setDocFiles((prev) => [...prev, ...ok]);
  }, [showAlert, hasStoryboard]);
  const removeDoc = useCallback((idx) => setDocFiles((prev) => prev.filter((_, i) => i !== idx)), []);

  const handleImageFiles = useCallback((files) => {
    const MAX_SIZE = 50 * 1024 * 1024;
    const ALLOWED = /\.(png|jpg|jpeg|mp4|avi|html|htm)$/i;
    const valid = Array.from(files).filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/') || ALLOWED.test(f.name));
    const oversized = valid.filter(f => f.size > MAX_SIZE);
    const ok = valid.filter(f => f.size <= MAX_SIZE);
    if (oversized.length) showAlert('⚠️ 以下文件超过 50MB 限制，已跳过：\n' + oversized.map(f => f.name + ' (' + (f.size/1024/1024).toFixed(1) + 'MB)').join('\n'));
    const newImgs = ok.map((f) => {
      const isImage = f.type.startsWith('image/');
      return { file: f, preview: isImage ? URL.createObjectURL(f) : null };
    });
    setRefImages((prev) => [...prev, ...newImgs]);
  }, [showAlert]);
  const removeImage = useCallback((idx) => {
    setRefImages((prev) => {
      const removed = prev[idx];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    if (loading || generating) return;
    const files = e.dataTransfer.files;
    const docs = [], imgs = [];
    const docPattern = /\.(pdf)$/i;
    const attachPattern = /\.(png|jpg|jpeg|mp4|avi|html|htm)$/i;
    Array.from(files).forEach((f) => {
      if (docPattern.test(f.name)) docs.push(f);
      else if (attachPattern.test(f.name)) imgs.push(f);
    });
    if (docs.length) handleDocFiles(docs);
    if (imgs.length) handleImageFiles(imgs);
  }, [handleDocFiles, handleImageFiles]);
  const handleDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation(); }, []);

  const startProgress = useCallback(() => {
    setParseProgress(0); setParseStage('准备中...');
    let p = 0;
    let elapsed = 0;
    const stages = [
      { at: 10, text: '上传文件中...' },
      { at: 30, text: '上传完成，AI 解析中...' },
      { at: 60, base: 'AI 正在分析文档' },
      { at: 85, base: 'AI 深度分析中，请耐心等待' },
    ];
    if (progressTimer.current) clearInterval(progressTimer.current);
    progressTimer.current = setInterval(() => {
      elapsed++;
      p += Math.random() * 6 + 1;
      if (p > 92) p = 92;
      const stage = [...stages].reverse().find((s) => p >= s.at);
      if (stage) {
        const secs = elapsed;
        if (stage.base) {
          setParseStage(`${stage.base}（已等待 ${secs} 秒）`);
        } else {
          setParseStage(stage.text);
        }
      }
      setParseProgress(Math.round(p));
    }, 1000);
  }, []);

  const finishProgress = useCallback(() => {
    if (progressTimer.current) { clearInterval(progressTimer.current); progressTimer.current = null; }
    setParseProgress(100); setParseStage('完成！');
    setTimeout(() => { setParseProgress(null); setParseStage(''); }, 1200);
  }, []);

  // Generate images for frames via SSE endpoint
  const generateFrameImages = useCallback(async (targetFrames) => {
    if (!targetFrames || targetFrames.length === 0) return;
    setGenerating(true);
    setGenProgress(0); setGenStage('正在生成分镜配图...');
    let completed = 0;
    try {
      const resp = await fetch(`${API_BASE}/api/projects/${projectId}/generate-storyboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frames: targetFrames, orientation, styleRefUrl, charRefUrl }),
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'progress') {
              completed = evt.current;
              setGenProgress(Math.min(99, Math.round((completed / evt.total) * 100)));
              setGenStage(`生成配图中 ${completed}/${evt.total}...`);
            } else if (evt.type === 'done') {
              const updatedFrames = evt.frames || [];
              setFrames((prev) => {
                const map = new Map(updatedFrames.map(f => [f.id, f]));
                return prev.map(f => map.has(f.id) ? { ...f, imageUrl: map.get(f.id).imageUrl || f.imageUrl } : f);
              });
            }
          } catch {}
        }
      }
    } catch (err) {
      console.warn('Generate images failed:', err.message);
    }
    setGenProgress(100); setGenStage('配图生成完成！');
    setTimeout(() => { setGenProgress(null); setGenStage(''); }, 1200);
    setGenerating(false);
  }, [projectId, orientation, styleRefUrl, charRefUrl]);

  // Generate image for a single frame
  const generateSingleFrameImage = useCallback(async (frameId) => {
    const frame = frames.find(f => f.id === frameId);
    if (!frame) return;
    setGeneratingFrameIds(prev => new Set(prev).add(frameId));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000); // 2 min timeout
      const resp = await fetch(`${API_BASE}/api/projects/${projectId}/generate-storyboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frames: [frame], orientation, styleRefUrl }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'done') {
              const updated = evt.frames || [];
              const uf = updated.find(f => f.id === frameId);
              if (uf && uf.imageUrl) {
                setFrames(prev => prev.map(f => f.id === frameId ? { ...f, imageUrl: uf.imageUrl } : f));
              }
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') await showAlert('⚠️ 图片生成失败: ' + err.message);
      else await showAlert('⚠️ 图片生成超时，请重试');
    } finally {
      setGeneratingFrameIds(prev => { const s = new Set(prev); s.delete(frameId); return s; });
    }
  }, [frames, projectId, showAlert, orientation, styleRefUrl]);

  // Regenerate a frame based on feedback: re-generate text fields + image
  const regenerateFrame = useCallback(async (frameId) => {
    const frame = frames.find(f => f.id === frameId);
    if (!frame) return;
    setGeneratingFrameIds(prev => new Set(prev).add(frameId));
    try {
      // Step 1: Use edit-frame API to regenerate text fields based on feedback
      const feedback = frame.feedback || '';
      if (feedback.trim()) {
        const editResp = await fetch(`${API_BASE}/api/projects/${projectId}/edit-frame`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            frameIndex: frames.indexOf(frame),
            instruction: feedback,
            frame,
          }),
        });
        const editData = await editResp.json();
        if (!editData.error && editData.frame) {
          setFrames(prev => prev.map(f => f.id === frameId ? { ...editData.frame, id: frameId, imageUrl: f.imageUrl, feedback: f.feedback, feedbackImage: f.feedbackImage } : f));
        }
      }
      // Step 2: Regenerate image
      const updatedFrame = frames.find(f => f.id === frameId) || frame;
      const resp = await fetch(`${API_BASE}/api/projects/${projectId}/generate-storyboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frames: [updatedFrame] }),
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'done') {
              const uf = (evt.frames || []).find(f => f.id === frameId);
              if (uf && uf.imageUrl) {
                setFrames(prev => prev.map(f => f.id === frameId ? { ...f, imageUrl: uf.imageUrl } : f));
              }
            }
          } catch {}
        }
      }
    } catch (err) {
      await showAlert('⚠️ 重新生成失败: ' + err.message);
    }
    setGeneratingFrameIds(prev => { const s = new Set(prev); s.delete(frameId); return s; });
  }, [frames, projectId, showAlert]);

  // Regenerate a frame based on edited scriptExcerpt
  const regenerateFromScript = useCallback(async (frameId) => {
    const frame = frames.find(f => f.id === frameId);
    if (!frame) return;
    setGeneratingFrameIds(prev => new Set(prev).add(frameId));
    try {
      // Step 1: Use edit-frame API to regenerate all fields based on scriptExcerpt
      const editResp = await fetch(`${API_BASE}/api/projects/${projectId}/edit-frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frameIndex: frames.indexOf(frame),
          instruction: '根据修改后的「原脚本文案」(scriptExcerpt)，重新生成此帧的场景描述(scene)、交互(interaction)、镜头(camera)、动画(animation)、UI描述(ui)、时间(timing)等所有字段，保持与原脚本文案一致。prompt也要根据新的文案重新生成。',
          frame,
        }),
      });
      const editData = await editResp.json();
      if (!editData.error && editData.frame) {
        const updatedFrame = { ...editData.frame, id: frameId, imageUrl: frame.imageUrl, feedback: frame.feedback, feedbackImage: frame.feedbackImage, scriptExcerpt: frame.scriptExcerpt };
        setFrames(prev => prev.map(f => f.id === frameId ? updatedFrame : f));
        // Step 2: Regenerate image with updated prompt
        const resp = await fetch(`${API_BASE}/api/projects/${projectId}/generate-storyboard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frames: [updatedFrame] }),
        });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'done') {
                const uf = (evt.frames || []).find(f => f.id === frameId);
                if (uf && uf.imageUrl) {
                  setFrames(prev => prev.map(f => f.id === frameId ? { ...f, imageUrl: uf.imageUrl } : f));
                }
              }
            } catch {}
          }
        }
      } else {
        throw new Error(editData.error || '编辑失败');
      }
    } catch (err) {
      await showAlert('⚠️ 重新生成失败: ' + err.message);
    }
    setGeneratingFrameIds(prev => { const s = new Set(prev); s.delete(frameId); return s; });
  }, [frames, projectId, showAlert]);

  const handleParse = useCallback(async () => {
    if (docFiles.length === 0 && refImages.length === 0 && !text.trim()) return;
    setLoading(true); setGenerated(false);
    startProgress();
    try {
      const formData = new FormData();
      formData.append('text', text);
      formData.append('orientation', orientation);
      formData.append('cameraAngle', cameraAngle);
      formData.append('perspective', perspective);
      if (style.trim()) formData.append('style', style.trim());
      formData.append('targetFrames', String(targetFrames || 15));
      docFiles.forEach((f) => formData.append('files', f));
      refImages.forEach((img) => formData.append('images', img.file));
      const data = await parseStoryboard(projectId, formData);
      const parsedFrames = Array.isArray(data) ? data : data.frames || [];
      const newFrames = parsedFrames.map((f) => ({ ...f, imageUrl: f.imageUrl || null }));
      setFrames(newFrames);
      finishProgress();
      // Auto-generate images for frames without images
      const needImages = newFrames.filter(f => !f.imageUrl);
      if (needImages.length > 0) {
        setTimeout(() => generateFrameImages(newFrames), 500);
      }
    } catch (err) {
      finishProgress();
      const msg = err.message || '未知错误';
      const isTimeout = msg.includes('超时') || msg.includes('Load failed') || msg.includes('Failed to fetch');
      await showAlert(isTimeout
        ? '⏱️ 分镜解析超时\n\n大文件（>10MB）解析可能需要1-2分钟，请稍后重试。\n如果持续超时，请联系管理员。'
        : '⚠️ 分镜解析失败\n\n' + msg + '\n\n你可以修改文案后重新解析。');
    }
    setLoading(false);
  }, [text, docFiles, refImages, orientation, cameraAngle, perspective, style, targetFrames, projectId, showAlert, startProgress, finishProgress, generateFrameImages]);

  const handleGenerate = useCallback(async () => {
    if (frames.length === 0) return;
    setGenerating(true);
    setGenProgress(50); setGenStage('正在生成分镜 PDF...');
    try {
      const resp = await fetch(`${API_BASE}/api/projects/${projectId}/generate-storyboard-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frames, projectName: '分镜板' }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || '生成失败');
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '分镜板_分镜.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setGenerated(true);
    } catch (err) {
      console.warn('Generate PDF failed:', err.message);
      await showAlert('⚠️ 分镜PDF生成失败: ' + err.message);
    }
    setGenProgress(100); setGenStage('完成！');
    setTimeout(() => { setGenProgress(null); setGenStage(''); }, 1200);
    setGenerating(false);
  }, [frames, projectId, showAlert]);

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

  const saveTimerRef = useRef(null);
  const saveFramesToServer = useCallback((updatedFrames) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      fetch(`${API_BASE}/api/projects/${projectId}/storyboard`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frames: updatedFrames }),
      }).catch(() => {});
    }, 1500);
  }, [projectId]);

  const handleUpdateFrame = useCallback((frameId, field, value) => {
    setFrames((prev) => {
      const updated = prev.map((f) => (f.id === frameId ? { ...f, [field]: value } : f));
      saveFramesToServer(updated);
      return updated;
    });
  }, [saveFramesToServer]);

  const toggleEdit = useCallback((frameId) => {
    if (editingFrameId === frameId) {
      setEditingFrameId(null);
      setEditInstruction('');
    } else {
      setEditingFrameId(frameId);
      setEditInstruction('');
    }
  }, [editingFrameId]);

  // Delete a frame
  const handleDeleteFrame = useCallback((frameId) => {
    setFrames((prev) => {
      const updated = prev.filter((f) => f.id !== frameId);
      saveFramesToServer(updated);
      return updated;
    });
  }, [saveFramesToServer]);

  // Add a new empty frame
  const handleAddFrame = useCallback(() => {
    const maxId = frames.reduce((m, f) => Math.max(m, typeof f.id === 'number' ? f.id : 0), 0);
    const newFrame = {
      id: maxId + 1,
      chapter: frames.length > 0 ? frames[frames.length - 1].chapter || 1 : 1,
      chapterTitle: '',
      step: 1,
      title: '',
      scene: '',
      interaction: '',
      camera: '',
      feeling: '',
      duration: '',
      prompt: '',
      ui: '',
      timing: '',
      animation: '',
      note: '',
      scriptExcerpt: '',
      imageUrl: null,
    };
    setFrames((prev) => {
      const updated = [...prev, newFrame];
      saveFramesToServer(updated);
      return updated;
    });
  }, [frames, saveFramesToServer]);

  // Drag reorder
  const dragItem = useRef(null);
  const dragOverItem = useRef(null);
  const handleDragStart = useCallback((idx) => { dragItem.current = idx; }, []);
  const handleDragEnter = useCallback((idx) => { dragOverItem.current = idx; }, []);
  const handleDragEnd = useCallback(() => {
    if (dragItem.current === null || dragOverItem.current === null || dragItem.current === dragOverItem.current) {
      dragItem.current = null; dragOverItem.current = null; return;
    }
    setFrames((prev) => {
      const updated = [...prev];
      const [removed] = updated.splice(dragItem.current, 1);
      updated.splice(dragOverItem.current, 0, removed);
      saveFramesToServer(updated);
      return updated;
    });
    dragItem.current = null; dragOverItem.current = null;
  }, [saveFramesToServer]);

  return (
    <div className="storyboard-panel" onDrop={handleDrop} onDragOver={handleDragOver}>
      {/* Storyboard Mode Toggle */}
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">📋 分镜模式</h3>
        <div className="sb-mode-toggle">
          <label className={'sb-mode-option' + (!hasStoryboard ? ' sb-mode-active' : '')} onClick={() => { setHasStoryboard(false); setDocFiles([]); }}>
            <input type="radio" name="sbMode" checked={!hasStoryboard} onChange={() => {}} style={{ display: 'none' }} />
            <span className="sb-mode-icon">📝</span>
            <span className="sb-mode-label">无分镜文件</span>
            <span className="sb-mode-desc">上传策划文档，AI 生成分镜配图</span>
          </label>
          <label className={'sb-mode-option' + (hasStoryboard ? ' sb-mode-active' : '')} onClick={() => { setHasStoryboard(true); setDocFiles([]); }}>
            <input type="radio" name="sbMode" checked={hasStoryboard} onChange={() => {}} style={{ display: 'none' }} />
            <span className="sb-mode-icon">📑</span>
            <span className="sb-mode-label">有分镜文件</span>
            <span className="sb-mode-desc">上传 PDF 分镜，直接解析</span>
          </label>
        </div>
      </div>

      {/* Requirement Document Upload */}
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">📄 需求文档</h3>
        <div className={'sb-upload-zone' + (isBusy ? ' sb-upload-disabled' : '')} onClick={() => !isBusy && docInputRef.current?.click()}>
          <input ref={docInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg" multiple style={{ display: 'none' }}
            onChange={(e) => { handleDocFiles(e.target.files); e.target.value = ''; }} disabled={isBusy} />
          <span className="sb-upload-icon">📄</span>
          <span className="sb-upload-text">点击或拖拽上传文件</span>
          <span className="sb-upload-hint">{'支持 PDF / PNG / JPG'}</span>
        </div>
        {docFiles.length > 0 && (
          <div className="sb-file-list">
            {docFiles.map((f, i) => (
              <div key={i} className="sb-file-tag"><span>📄 {f.name}</span><button onClick={() => removeDoc(i)}>×</button></div>
            ))}
          </div>
        )}
      </div>

      {/* Attachments */}
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">📎 上传附件</h3>
        <div className={'sb-upload-zone' + (isBusy ? ' sb-upload-disabled' : '')} onClick={() => !isBusy && imgInputRef.current?.click()}>
          <input ref={imgInputRef} type="file" accept="image/png,image/jpeg,.avi,.mp4,.html,.htm" multiple style={{ display: 'none' }}
            onChange={(e) => { handleImageFiles(e.target.files); e.target.value = ''; }} disabled={isBusy} />
          <span className="sb-upload-icon">📎</span>
          <span className="sb-upload-text">点击或拖拽上传文件</span>
          <span className="sb-upload-hint">支持 PNG, JPG, MP4, AVI, HTML，可上传多个</span>
        </div>
        {refImages.length > 0 && (
          <div className="sb-file-list">
            {refImages.map((img, i) => (
              <div key={i} className="sb-file-tag">
                {img.preview ? (
                  <img src={img.preview} alt="" style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 3, marginRight: 4 }} />
                ) : (
                  <span style={{ marginRight: 4 }}>{/\.(mp4|avi)$/i.test(img.file.name) ? '🎬' : '📄'}</span>
                )}
                <span>{img.file.name}</span>
                <button onClick={() => removeImage(i)}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Notes / Instructions for AI */}
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">📝 备注</h3>
        <textarea className="storyboard-textarea" placeholder="告诉 AI 上传的附件是什么，需要参考哪些内容...&#10;例如：「附件是游戏截图，请参考其中的美术风格和 UI 布局」" value={text} onChange={(e) => setText(e.target.value)} rows={4} />
      </div>

      {/* Camera Options - only in "no storyboard" mode */}
      {!hasStoryboard && (
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
        <div className="sb-option-row">
          <span className="sb-option-label">风格参考</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input ref={styleRefInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setStyleRefFile(file);
              setStyleRefPreview(URL.createObjectURL(file));
              // Upload to server
              try {
                const fd = new FormData();
                fd.append('file', file);
                const resp = await fetch(`${API_BASE}/api/projects/${projectId}/upload-style-ref`, { method: 'POST', body: fd });
                const data = await resp.json();
                if (data.styleRefUrl) { setStyleRefUrl(data.styleRefUrl); }
              } catch(err) { console.warn('Style ref upload failed:', err.message); }
            }} />
            <button className="storyboard-btn" style={{ padding: '4px 12px', fontSize: 13 }} onClick={() => styleRefInputRef.current?.click()}>
              {styleRefPreview ? '更换图片' : '📎 上传参考图'}
            </button>
            {styleRefPreview && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <img src={styleRefPreview} alt="style ref" style={{ height: 36, borderRadius: 4, border: '1px solid #444' }} />
                <button style={{ background: 'none', border: 'none', color: '#f66', cursor: 'pointer', fontSize: 16 }} onClick={() => { setStyleRefFile(null); setStyleRefUrl(null); setStyleRefPreview(null); }}>✕</button>
              </div>
            )}
            {!styleRefPreview && <span style={{ color: '#888', fontSize: 12 }}>可选：统一所有帧的画风</span>}
          </div>
        </div>
        <div className="sb-option-row">
          <span className="sb-option-label">人物参考</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input ref={charRefInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setCharRefFile(file);
              setCharRefPreview(URL.createObjectURL(file));
              try {
                const fd = new FormData();
                fd.append('file', file);
                const resp = await fetch(`${API_BASE}/api/projects/${projectId}/upload-style-ref`, { method: 'POST', body: fd });
                const data = await resp.json();
                if (data.styleRefUrl) { setCharRefUrl(data.styleRefUrl); }
              } catch(err) { console.warn('Char ref upload failed:', err.message); }
            }} />
            <button className="storyboard-btn" style={{ padding: '4px 12px', fontSize: 13 }} onClick={() => charRefInputRef.current?.click()}>
              {charRefPreview ? '更换图片' : '👤 上传人物图'}
            </button>
            {charRefPreview && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <img src={charRefPreview} alt="char ref" style={{ height: 36, borderRadius: 4, border: '1px solid #444' }} />
                <button style={{ background: 'none', border: 'none', color: '#f66', cursor: 'pointer', fontSize: 16 }} onClick={() => { setCharRefFile(null); setCharRefUrl(null); setCharRefPreview(null); }}>✕</button>
              </div>
            )}
            {!charRefPreview && <span style={{ color: '#888', fontSize: 12 }}>可选：统一角色形象</span>}
          </div>
        </div>
        <div className="sb-option-row">
          <span className="sb-option-label">目标帧数</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="range" min={8} max={25} value={targetFrames} onChange={(e) => setTargetFrames(Number(e.target.value))} style={{ flex: 1 }} />
            <span style={{ minWidth: 32, textAlign: 'center', fontWeight: 600 }}>{targetFrames}</span>
          </div>
        </div>
      </div>
      )}

      {/* Parse Button + Progress */}
      <div className="storyboard-input-section">
        <button className="storyboard-btn storyboard-btn-parse" onClick={handleParse}
          disabled={loading || generating || frames.length > 0 || (docFiles.length === 0 && refImages.length === 0)}>
          {loading ? '⏳ 解析中...' : frames.length > 0 ? '✅ 已解析' : '🎬 开始解析'}
        </button>
        {parseProgress !== null && (
          <div className="parse-progress-overlay">
            <div className="parse-progress-card">
              <div className="parse-progress-icon">{parseProgress >= 100 ? '✅' : '🤖'}</div>
              <div className="parse-progress-bar-track">
                <div className="parse-progress-bar-fill" style={{ width: `${parseProgress}%` }} />
              </div>
              <div className="parse-progress-percent">{parseProgress}%</div>
              <div className="parse-progress-text">{parseStage}</div>
            </div>
          </div>
        )}
      </div>

      {genProgress !== null && (
        <div className="parse-progress-overlay">
          <div className="parse-progress-card">
            <div className="parse-progress-icon">{genProgress >= 100 ? '✅' : '🎨'}</div>
            <div className="parse-progress-bar-track">
              <div className="parse-progress-bar-fill" style={{ width: `${genProgress}%` }} />
            </div>
            <div className="parse-progress-percent">{genProgress}%</div>
            <div className="parse-progress-text">{genStage}</div>
          </div>
        </div>
      )}

      {/* Frames Preview — PDF Table Format */}
      {frames.length > 0 && (
        <div className="storyboard-frames-section">
          <div className="storyboard-frames-header">
            <h3 className="storyboard-section-title">🎞 分镜预览 ({frames.length} 帧)</h3>
          </div>
          <table className="sb-table">
            <thead>
              <tr>
                <th className="sb-th sb-th-num">序号</th>
                <th className="sb-th sb-th-desc">文字描述</th>
                <th className="sb-th sb-th-visual">画面</th>
                <th className="sb-th sb-th-note">反馈</th>
              </tr>
            </thead>
            <tbody>
              {frames.map((frame, idx) => (
                <tr key={frame.id} className="sb-tr"
                  draggable onDragStart={() => handleDragStart(idx)}
                  onDragEnter={() => handleDragEnter(idx)} onDragEnd={handleDragEnd}
                  onDragOver={(e) => e.preventDefault()}>
                  {/* 序号 */}
                  <td className="sb-td sb-td-num">
                    <span className="sb-drag-handle" title="拖拽排序">⠿</span>
                    <span className="sb-num">{idx + 1}</span>
                    <button className="sb-delete-frame-btn" onClick={() => handleDeleteFrame(frame.id)} title="删除此帧">✕</button>
                  </td>
                  {/* 文字描述 */}
                  <td className="sb-td sb-td-desc">
                    <div className="sb-desc-phase">
                      <input className="sb-phase-input" value={frame.title || ''}
                        onChange={(e) => handleUpdateFrame(frame.id, 'title', e.target.value)}
                        placeholder="Phase 标题" />
                      <button className="sb-edit-btn" onClick={() => toggleEdit(frame.id)} title="AI 编辑">✏️</button>
                    </div>
                    {editingFrameId === frame.id && (
                      <div className="sb-edit-bar">
                        <input className="sb-edit-input" placeholder="描述修改需求，如「把场景改成室内」..."
                          value={editInstruction} onChange={(e) => setEditInstruction(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditFrame(frame.id); } }}
                          disabled={editingLoading} autoFocus />
                        <button className="sb-edit-apply" onClick={() => handleEditFrame(frame.id)}
                          disabled={editingLoading || !editInstruction.trim()}>
                          {editingLoading ? '⏳' : '✨ 应用'}
                        </button>
                      </div>
                    )}
                    <div className="sb-desc-fields">
                      <div className="sb-field-row">
                        <span className="sb-field-key">玩家看到什么：</span>
                        <textarea className="sb-field-val" value={frame.scene || ''} rows={2}
                          onChange={(e) => handleUpdateFrame(frame.id, 'scene', e.target.value)}
                          placeholder="场景描述..." />
                      </div>
                      <div className="sb-field-row">
                        <span className="sb-field-key">玩家做什么：</span>
                        <textarea className="sb-field-val" value={frame.interaction || ''} rows={2}
                          onChange={(e) => handleUpdateFrame(frame.id, 'interaction', e.target.value)}
                          placeholder="交互行为..." />
                      </div>
                      <div className="sb-field-row">
                        <span className="sb-field-key">镜头：</span>
                        <textarea className="sb-field-val" value={frame.camera || ''} rows={1}
                          onChange={(e) => handleUpdateFrame(frame.id, 'camera', e.target.value)}
                          placeholder="镜头描述..." />
                      </div>
                      <div className="sb-field-row">
                        <span className="sb-field-key">感觉：</span>
                        <textarea className="sb-field-val" value={frame.feeling || ''} rows={1}
                          onChange={(e) => handleUpdateFrame(frame.id, 'feeling', e.target.value)}
                          placeholder="氛围/感受..." />
                      </div>
                      <div className="sb-field-row">
                        <span className="sb-field-key">大约耗时：</span>
                        <input className="sb-field-val sb-field-short" value={frame.duration || ''}
                          onChange={(e) => handleUpdateFrame(frame.id, 'duration', e.target.value)}
                          placeholder="如 2-3秒" />
                      </div>
                      <div className="sb-field-row sb-field-script">
                        <span className="sb-field-key">原脚本文案：</span>
                        <textarea className="sb-field-val sb-script-textarea" value={frame.scriptExcerpt || ''} rows={3}
                          onChange={(e) => handleUpdateFrame(frame.id, 'scriptExcerpt', e.target.value)}
                          placeholder="原脚本文案..." />
                        <button className="sb-script-regen-btn"
                          onClick={() => regenerateFromScript(frame.id)}
                          disabled={generatingFrameIds.has(frame.id)}
                          title="根据原脚本文案重新生成此帧的描述和图片">
                          {generatingFrameIds.has(frame.id) ? '⏳' : '🔄 重新生成'}
                        </button>
                      </div>
                    </div>
                  </td>
                  {/* 画面 */}
                  <td className="sb-td sb-td-visual">
                    {frame.imageUrl ? (
                      <div className="sb-visual-images">
                        <img src={API_BASE + frame.imageUrl} alt={frame.title} className="sb-visual-img sb-visual-img-clickable"
                          onClick={() => setLightboxUrl(API_BASE + frame.imageUrl)} title="点击放大" />
                        <div className="sb-visual-actions">
                          <a className="sb-img-action-btn" href={API_BASE + frame.imageUrl} download={`frame_${idx + 1}.jpg`} title="下载" onClick={e => e.stopPropagation()}>⬇️</a>
                        </div>
                      </div>
                    ) : (
                      <div className="sb-visual-placeholder">
                        <span>#{idx + 1}</span>
                        {generatingFrameIds.has(frame.id) ? (
                          <span className="sb-visual-ph-text">⏳ 生成中...</span>
                        ) : (
                          <>
                            <span className="sb-visual-ph-text">{frame.prompt ? frame.prompt.slice(0, 40) + '...' : '待生成'}</span>
                            <button className="sb-gen-single-btn" onClick={() => generateSingleFrameImage(frame.id)}
                              disabled={generating}>🎨 生成图片</button>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                  {/* 反馈 */}
                  <td className="sb-td sb-td-note">
                    <textarea className="sb-note-input" value={frame.feedback || ''} rows={3}
                      onChange={(e) => handleUpdateFrame(frame.id, 'feedback', e.target.value)}
                      placeholder="输入修改意见..." />
                    <div className="sb-feedback-upload">
                      <label className="sb-feedback-upload-btn" title="上传参考图">
                        📎
                        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = () => handleUpdateFrame(frame.id, 'feedbackImage', reader.result);
                          reader.readAsDataURL(file);
                          e.target.value = '';
                        }} />
                      </label>
                      <button className="sb-feedback-regen-btn"
                        onClick={() => regenerateFrame(frame.id)}
                        disabled={generatingFrameIds.has(frame.id)}
                        title="根据反馈重新生成此帧的文案和图片">
                        {generatingFrameIds.has(frame.id) ? '⏳ 生成中...' : '🔄 重新生成'}
                      </button>
                    </div>
                    {frame.feedbackImage && (
                      <div className="sb-note-ref">
                        <img src={frame.feedbackImage} alt="参考" className="sb-note-ref-img" />
                        <button className="sb-feedback-img-remove" onClick={() => handleUpdateFrame(frame.id, 'feedbackImage', null)}>×</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Bottom Action Bar */}
          <div className="storyboard-bottom-bar">
            <button className="storyboard-btn storyboard-bottom-btn storyboard-btn-add" onClick={handleAddFrame}>
              ➕ 添加分镜
            </button>
            <button className="storyboard-btn storyboard-bottom-btn storyboard-btn-clear" onClick={handleClearFrames}>
              🗑 清空帧
            </button>
            <button className="storyboard-btn storyboard-bottom-btn generate-storyboard-btn"
              onClick={() => window.open(`./storyboard-preview.html?id=${projectId}`, '_blank')}>
              📄 预览分镜
            </button>
            <button className="storyboard-btn storyboard-bottom-btn storyboard-btn-convert" onClick={handleConvert}
              disabled={hasStoryboard ? false : !generated} title={!hasStoryboard && !generated ? '请先点击"生成分镜"' : ''}>
              🗺 转为蓝图
            </button>
          </div>
        </div>
      )}
      {/* Lightbox */}
      {lightboxUrl && (
        <div className="sb-lightbox-overlay" onClick={() => setLightboxUrl(null)}>
          <div className="sb-lightbox-content" onClick={e => e.stopPropagation()}>
            <img src={lightboxUrl} alt="放大预览" className="sb-lightbox-img" />
            <div className="sb-lightbox-bar">
              <a className="sb-lightbox-btn" href={lightboxUrl} download="frame.jpg">⬇️ 下载</a>
              <button className="sb-lightbox-btn" onClick={() => setLightboxUrl(null)}>✕ 关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
