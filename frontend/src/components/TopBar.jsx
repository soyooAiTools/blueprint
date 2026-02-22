import { useRef } from 'react';

export default function TopBar({
  projectName,
  onProjectNameChange,
  onExportJSON,
  onImportJSON,
  onClearCanvas,
  onBack,
}) {
  const fileInputRef = useRef(null);

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
