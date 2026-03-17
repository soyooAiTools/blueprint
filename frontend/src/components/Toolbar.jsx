export default function Toolbar({ onAddShot, onAddJoin, onAddNote, isV4 }) {
  return (
    <div className="toolbar">
      <div className="toolbar-title">🛠 工具箱</div>

      <div className="toolbar-section">
        <div className="toolbar-section-title">添加节点</div>
        <button className="toolbar-btn" onClick={onAddShot}>
          {isV4 ? '📦 添加实体' : '📷 添加镜头'}
        </button>
        <button className="toolbar-btn" onClick={onAddJoin}>
          ◇ 添加汇合点
        </button>
        <button className="toolbar-btn" onClick={onAddNote}>
          📝 添加注释
        </button>
      </div>
    </div>
  );
}
