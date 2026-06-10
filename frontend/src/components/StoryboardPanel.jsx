import { useState, useCallback, useRef, useEffect } from 'react';
import {
  generateStoryboardHtmlPackage,
  getStoryboardHtmlPackageJob,
} from '../utils/api';

const ACCEPTED_STORYBOARD_FILES = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg';
const SUPPORTED_FILE_PATTERN = /\.(pdf|doc|docx|xls|xlsx|csv|png|jpg|jpeg)$/i;
const MAX_STORYBOARD_FILE_SIZE = 20 * 1024 * 1024;

function formatBytes(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}

function fileKey(file) {
  return [file.name, file.size, file.lastModified].join(':');
}

export default function StoryboardPanel({
  projectName,
  onApproveHtmlPreview,
  hasExistingNodes,
  showAlert,
  showConfirm,
}) {
  const [files, setFiles] = useState([]);
  const [job, setJob] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef(null);

  const jobActive = job && (job.status === 'queued' || job.status === 'running');
  const busy = generating || jobActive || submitting;

  useEffect(() => {
    if (!job?.jobId || !jobActive) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await getStoryboardHtmlPackageJob(job.jobId);
        if (cancelled) return;
        setJob(data);
        if (data.status === 'done') {
          setResult(data.result || data);
          setError('');
        } else if (data.status === 'error') {
          setError(data.error || 'HTML 生成失败');
        }
      } catch (err) {
        if (!cancelled) setError(err.message || '查询 HTML 任务失败');
      }
    };
    const timer = setInterval(poll, 4000);
    const starter = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(starter);
    };
  }, [job?.jobId, jobActive]);

  const resetGenerated = useCallback(() => {
    setJob(null);
    setResult(null);
    setError('');
  }, []);

  const addFiles = useCallback(async (list) => {
    const incoming = Array.from(list || []);
    if (!incoming.length) return;

    const unsupported = incoming.filter((file) => !SUPPORTED_FILE_PATTERN.test(file.name));
    const supported = incoming.filter((file) => SUPPORTED_FILE_PATTERN.test(file.name));
    const oversized = supported.filter((file) => file.size > MAX_STORYBOARD_FILE_SIZE);
    const accepted = supported.filter((file) => file.size <= MAX_STORYBOARD_FILE_SIZE);

    if (unsupported.length) {
      await showAlert('⚠️ 以下文件格式暂不支持，已跳过：\n' + unsupported.map((file) => file.name).join('\n'));
    }
    if (oversized.length) {
      await showAlert('⚠️ 以下文件超过 20MB 限制，已跳过：\n' + oversized.map((file) => `${file.name} (${formatBytes(file.size)})`).join('\n'));
    }
    if (!accepted.length) return;

    setFiles((prev) => {
      const seen = new Set(prev.map(fileKey));
      const merged = prev.slice();
      accepted.forEach((file) => {
        const key = fileKey(file);
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(file);
        }
      });
      return merged;
    });
    resetGenerated();
  }, [resetGenerated, showAlert]);

  const removeFile = useCallback((index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    resetGenerated();
  }, [resetGenerated]);

  const handleDrop = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!busy) addFiles(event.dataTransfer.files);
  }, [addFiles, busy]);

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const buildFormData = useCallback(() => {
    const formData = new FormData();
    formData.append('projectName', projectName || 'AI试玩HTML');
    files.forEach((file) => formData.append('files', file, file.name));
    return formData;
  }, [files, projectName]);

  const generateHtmlPreview = useCallback(async () => {
    if (!files.length || busy) return;
    setGenerating(true);
    resetGenerated();
    try {
      const data = await generateStoryboardHtmlPackage(buildFormData());
      if (data.async && data.status !== 'done') {
        setJob(data);
      } else {
        setResult(data.result || data);
      }
    } catch (err) {
      setError(err.message || 'HTML 生成失败');
      await showAlert('⚠️ HTML 生成失败: ' + (err.message || err));
    } finally {
      setGenerating(false);
    }
  }, [buildFormData, busy, files.length, resetGenerated, showAlert]);

  const confirmHtmlPreview = useCallback(async () => {
    if (!result || submitting) return;
    if (hasExistingNodes) {
      const yes = await showConfirm('画布已有内容。确认后将以当前 HTML 作为 source 进入 WebGL 生成流程，确认继续？');
      if (!yes) return;
    }
    if (!onApproveHtmlPreview) {
      await showAlert('⚠️ 当前页面没有接入 HTML 确认提交流程');
      return;
    }
    setSubmitting(true);
    try {
      await onApproveHtmlPreview(result);
    } catch (err) {
      await showAlert('⚠️ 提交 WebGL 生成失败: ' + (err.message || err));
    } finally {
      setSubmitting(false);
    }
  }, [hasExistingNodes, onApproveHtmlPreview, result, showAlert, showConfirm, submitting]);

  return (
    <div className="storyboard-panel" onDrop={handleDrop} onDragOver={handleDragOver}>
      <div className="storyboard-input-section">
        <h3 className="storyboard-section-title">📄 分镜文档</h3>
        <div
          className={'sb-upload-zone' + (busy ? ' sb-upload-disabled' : '')}
          onClick={() => !busy && inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_STORYBOARD_FILES}
            multiple
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <span className="sb-upload-icon">📄</span>
          <span className="sb-upload-text">点击或拖拽上传文件</span>
          <span className="sb-upload-hint">支持 PDF / Word / Excel / CSV / PNG / JPG，单文件不超过 20MB</span>
        </div>

        {files.length > 0 && (
          <div className="sb-file-list">
            {files.map((file, index) => (
              <div key={fileKey(file)} className="sb-file-tag">
                <span>📄 {file.name} ({formatBytes(file.size)})</span>
                <button disabled={busy} onClick={() => removeFile(index)}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="storyboard-input-section">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="storyboard-btn storyboard-btn-parse"
            onClick={generateHtmlPreview}
            disabled={!files.length || busy}
            style={{ background: files.length ? 'linear-gradient(135deg, #7c3aed, #2563eb)' : undefined, opacity: files.length ? 1 : 0.4, fontWeight: 600 }}
          >
            {generating || jobActive
              ? `⏳ ${Math.round(job?.progress || 0)}% ${job?.stage || '生成 HTML...'}`
              : (result ? '🔄 重新生成 HTML' : '🚀 开始解析')}
          </button>
        </div>

        {jobActive && (
          <div className="sb-html-preview-status">
            <div className="sb-html-preview-row">
              <span>{job?.stage || '生成 HTML 预览中...'}</span>
              <strong>{Math.round(job?.progress || 1)}%</strong>
            </div>
            <div className="sb-html-preview-progress">
              <div style={{ width: `${Math.max(4, Math.min(100, job?.progress || 1))}%` }} />
            </div>
          </div>
        )}

        {error && <div className="sb-html-preview-error">{error}</div>}

        {result?.urls && (
          <div className="sb-html-preview-card">
            <div className="sb-html-preview-title">HTML 预览已生成 · {result.phaseCount || '-'} phase</div>
            <div className="sb-html-preview-actions">
              <a className="sb-html-preview-link primary" href={result.urls.html} target="_blank" rel="noreferrer">打开 HTML 预览</a>
              <button className="storyboard-btn storyboard-btn-parse" onClick={confirmHtmlPreview} disabled={submitting}>
                {submitting ? '提交中...' : '确认预览，继续生成 WebGL'}
              </button>
              <a className="sb-html-preview-link" href={result.urls.auditReport} target="_blank" rel="noreferrer">审计报告</a>
              <a className="sb-html-preview-link" href={result.urls.storyboard2htmlInput} target="_blank" rel="noreferrer">HTML 输入</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
