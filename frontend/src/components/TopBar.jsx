import { useRef, useState } from 'react';
import { useModal } from './ModalProvider';

const TOPBAR_STATUS_LABELS = {
  editing: { text: '✏️ 编辑中', color: '#2563eb', bg: 'rgba(37,99,235,0.15)' },
  submitted: {
    text: '⏳ 已提交，等待 Coding Agent 接单...',
    color: '#eab308',
    bg: 'rgba(234,179,8,0.15)',
  },
  processing: {
    text: '⚙️ Coding Agent 准备中...',
    color: '#eab308',
    bg: 'rgba(234,179,8,0.15)',
  },
  building: {
    text: '🔨 Coding Agent 开发中...',
    color: '#f97316',
    bg: 'rgba(249,115,22,0.15)',
  },
  reviewing: {
    text: '👀 开发完成，请审核',
    color: '#a855f7',
    bg: 'rgba(168,85,247,0.15)',
  },
  feedback: {
    text: '💬 反馈中，等待 Coding Agent 修改...',
    color: '#f97316',
    bg: 'rgba(249,115,22,0.15)',
  },
  approved: {
    text: '⏳ 正在提交 SVN...',
    color: '#22c55e',
    bg: 'rgba(34,197,94,0.15)',
  },
  committed: {
    text: '✅ 已提交 SVN',
    color: '#22c55e',
    bg: 'rgba(34,197,94,0.15)',
  },
  failed: {
    text: '❌ 开发失败，可重新提交',
    color: '#ef4444',
    bg: 'rgba(239,68,68,0.15)',
  },
};

export default function TopBar({
  projectName,
  onProjectNameChange,
  onExportJSON,
  onImportJSON,
  onClearCanvas,
  onBack,
  projectStatus,
  onSubmit,
  onApprove,
  onFeedback,
  shotCount,
  statusMessage,
  activeTab,
}) {
  const fileInputRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const { showAlert, showConfirm, showPrompt } = useModal();

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
    if (!shotCount || shotCount === 0) {
      await showAlert('蓝图为空，请先添加实体或镜头节点再提交');
      return;
    }
    if (await showConfirm('确认提交给 Coding Agent 开发？')) {
      setSubmitting(true);
      try {
        await onSubmit();
      } finally {
        setSubmitting(false);
      }
    }
  };

  const handleApprove = async () => {
    if (await showConfirm('确认通过审核？')) {
      try {
        await onApprove();
      } catch (err) {
        await showAlert('操作失败: ' + err.message);
      }
    }
  };

  const handleFeedback = async () => {
    const text = await showPrompt('请输入反馈内容：');
    if (text) {
      try {
        await onFeedback(text);
      } catch (err) {
        await showAlert('操作失败: ' + err.message);
      }
    }
  };

  const statusLabel = TOPBAR_STATUS_LABELS[projectStatus] || TOPBAR_STATUS_LABELS.editing;

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
        {projectStatus && projectStatus !== 'editing' && (
          <span
            className="topbar-status-tag"
            style={{ color: statusLabel.color, background: statusLabel.bg }}
          >
            {statusLabel.text}
            {statusMessage && (projectStatus === 'submitted' || projectStatus === 'building' || projectStatus === 'feedback' || projectStatus === 'failed') && (
              <span className="topbar-status-detail"> — {statusMessage}</span>
            )}
          </span>
        )}
      </div>
      <div className="topbar-right">
        {activeTab === 'blueprint' && (
          <>
            {(!projectStatus || projectStatus === 'editing' || projectStatus === 'feedback' || projectStatus === 'failed') && onSubmit && (
              <button
                className="topbar-btn topbar-btn-submit"
                onClick={handleSubmit}
                disabled={submitting || !shotCount}
                title={!shotCount ? '请先完成分镜并转为蓝图' : ''}
              >
                {submitting ? '⏳ 提交中...' : '🚀 提交开发'}
              </button>
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
          </>
        )}
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
