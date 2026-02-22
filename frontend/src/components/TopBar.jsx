import { useRef, useState } from 'react';
import { submitProject, submitFeedback } from '../utils/api';

export default function TopBar({
  projectName,
  onProjectNameChange,
  onExportJSON,
  onImportJSON,
  onClearCanvas,
  onBack,
  projectId,
  nodes,
}) {
  const fileInputRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportJSON(file);
      e.target.value = '';
    }
  };

  const handleSubmit = async () => {
    if (!projectId) return;
    
    try {
      setSubmitting(true);
      await submitProject(projectId);
      alert('✅ 项目已提交！');
    } catch (err) {
      alert('提交失败：' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitFeedback = async () => {
    if (!projectId || !nodes) return;
    
    // 收集所有反馈
    const feedbackData = [];
    nodes.forEach((node) => {
      if (node.data.revisions && node.data.revisions.length > 0) {
        node.data.revisions.forEach((rev) => {
          if (rev.status === 'pending') {
            feedbackData.push({
              nodeId: node.id,
              nodeLabel: node.data.label,
              ...rev,
            });
          }
        });
      }
    });
    
    if (feedbackData.length === 0) {
      alert('没有待提交的反馈');
      return;
    }
    
    try {
      setSubmitting(true);
      await submitFeedback(projectId, feedbackData);
      alert(`✅ 已提交 ${feedbackData.length} 条反馈！`);
    } catch (err) {
      alert('提交反馈失败：' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="topbar">
      <div className="topbar-left">
        {onBack && (
          <button className="topbar-back-btn" onClick={onBack} title="返回项目列表">
            ← 返回
          </button>
        )}
        <span className="topbar-logo">🎬</span>
        <input
          className="topbar-project-name"
          type="text"
          value={projectName}
          onChange={(e) => onProjectNameChange(e.target.value)}
        />
        <span className="topbar-subtitle">镜头蓝图编辑器</span>
      </div>
      <div className="topbar-right">
        {projectId && (
          <>
            <button 
              className="topbar-btn topbar-btn-submit" 
              onClick={handleSubmit}
              disabled={submitting}
            >
              📝 提交项目
            </button>
            <button 
              className="topbar-btn topbar-btn-feedback" 
              onClick={handleSubmitFeedback}
              disabled={submitting}
            >
              💬 提交反馈
            </button>
          </>
        )}
        <button className="topbar-btn" onClick={onExportJSON}>
          📤 导出 JSON
        </button>
        <button className="topbar-btn" onClick={handleImportClick}>
          📥 导入 JSON
        </button>
        <button className="topbar-btn topbar-btn-danger" onClick={onClearCanvas}>
          🗑 清空画布
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.zip"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
}
