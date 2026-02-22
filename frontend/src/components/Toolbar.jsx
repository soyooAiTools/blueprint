import templates from '../presets/templates';

export default function Toolbar({ onAddShot, onAddJoin, onAddNote, onLoadTemplate }) {
  return (
    <div className="toolbar">
      <div className="toolbar-title">🛠 工具箱</div>

      <div className="toolbar-section">
        <div className="toolbar-section-title">添加节点</div>
        <button className="toolbar-btn" onClick={onAddShot}>
          📷 添加镜头
        </button>
        <button className="toolbar-btn" onClick={onAddJoin}>
          ◇ 添加汇合点
        </button>
        <button className="toolbar-btn" onClick={onAddNote}>
          📝 添加注释
        </button>
      </div>

      <div className="toolbar-section">
        <div className="toolbar-section-title">预设模板</div>
        {templates.map((tpl, i) => (
          <button
            key={i}
            className="toolbar-btn toolbar-btn-template"
            onClick={() => onLoadTemplate(tpl)}
          >
            {tpl.name}
          </button>
        ))}
      </div>
    </div>
  );
}
