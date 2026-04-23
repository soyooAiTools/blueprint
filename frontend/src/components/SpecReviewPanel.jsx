import { useState, useEffect, useCallback } from 'react';
import { getSpecs, confirmSpecs } from '../utils/api';

const INTERACTION_CATEGORIES = {
  basic: ['move_to', 'click', 'drag', 'hold'],
  economy: ['collect', 'deliver', 'spend'],
  building: ['build', 'upgrade', 'unlock'],
  combat: ['defeat', 'defeat_count', 'defend', 'attack'],
  state: ['wait', 'reach', 'disappear', 'appear', 'transform'],
  slg: ['recruit', 'deploy', 'merge', 'assign', 'expand', 'rally', 'scout', 'trade'],
};

function summarizeAction(action) {
  const kind = String(action?.kind || action?.type || '').trim();
  if (!kind) return '';
  const target = action?.target || action?.to || action?.item || '';
  return target ? `${kind}:${target}` : kind;
}

function PlanReviewPanel({ plans, planValidation }) {
  if (!plans?.assemblyPlan) return null;

  const atoms = plans.storyboardAtomPlan?.items || [];
  const modules = plans.assemblyPlan?.moduleInstances || [];
  const cuaSteps = plans.cuaPlan?.steps || [];
  const unresolved = plans.assemblyPlan?.unresolved || [];
  const warnings = planValidation?.warnings || [];
  const errors = planValidation?.errors || [];

  return (
    <div style={{
      background: 'rgba(16,185,129,0.08)',
      border: '1px solid rgba(16,185,129,0.22)',
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>🧩 Assembly Plan Review</div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 4 }}>
            分镜原子、实体模块和 CUA 断言已预编译。这里确认的是装配链，而不只是旧 spec。
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', fontFamily: 'monospace' }}>
          {plans.registryVersion || plans.storyboardAtomPlan?.registryVersion || 'assembly-registry-v1'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13, marginBottom: 12 }}>
        <span>🎬 {atoms.length} 个 atoms</span>
        <span>🧱 {modules.length} 个 modules</span>
        <span>🧪 {cuaSteps.length} 个 CUA steps</span>
        <span>📁 {(plans.assemblyPlan?.fileOwners || []).length} 个 owner files</span>
        <span>⚠️ {unresolved.length} 个 unresolved</span>
      </div>

      {(warnings.length > 0 || errors.length > 0) && (
        <div style={{
          background: 'rgba(245,158,11,0.08)',
          border: '1px solid rgba(245,158,11,0.25)',
          borderRadius: 10,
          padding: 12,
          marginBottom: 12,
          fontSize: 12,
          color: 'rgba(255,255,255,0.78)',
        }}>
          {errors.length > 0 && <div style={{ marginBottom: warnings.length > 0 ? 8 : 0 }}>❌ {errors.join(' | ')}</div>}
          {warnings.length > 0 && <div>⚠️ {warnings.join(' | ')}</div>}
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {cuaSteps.map((step, index) => (
          <div key={step.id || step.phaseId || index} style={{
            borderRadius: 10,
            padding: 12,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <div style={{ color: '#fff', fontWeight: 600 }}>
                Phase {index + 1}: {step.phaseId || step.id}
              </div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{step.mode || 'act_and_assert'}</div>
            </div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.72)', marginBottom: 6 }}>
              动作: {(step.actions || []).map(summarizeAction).filter(Boolean).join(' / ') || 'observe_only'}
            </div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
              信号: {(step.expectedSignals || []).join(', ') || 'none'}
            </div>
          </div>
        ))}
      </div>

      {unresolved.length > 0 && (
        <div style={{
          marginTop: 12,
          fontSize: 12,
          color: 'rgba(255,255,255,0.68)',
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.18)',
          borderRadius: 10,
          padding: 12,
          whiteSpace: 'pre-wrap',
          fontFamily: 'monospace',
        }}>
          {JSON.stringify(unresolved, null, 2)}
        </div>
      )}
    </div>
  );
}

function SpecCard({ spec, index, onChange }) {
  const [expanded, setExpanded] = useState(true);

  const updateField = (field, value) => {
    onChange(index, { ...spec, [field]: value });
  };

  const updateDuration = (key, value) => {
    onChange(index, { ...spec, duration: { ...spec.duration, [key]: Number(value) || 0 } });
  };

  const updateInteraction = (i, value) => {
    const arr = [...(spec.requiredInteractions || [])];
    arr[i] = value;
    onChange(index, { ...spec, requiredInteractions: arr });
  };

  const addInteraction = () => {
    const arr = [...(spec.requiredInteractions || []), 'click:target'];
    onChange(index, { ...spec, requiredInteractions: arr });
  };

  const removeInteraction = (i) => {
    const arr = (spec.requiredInteractions || []).filter((_, idx) => idx !== i);
    onChange(index, { ...spec, requiredInteractions: arr });
  };

  const updateEntity = (i, field, value) => {
    const arr = [...(spec.entitiesRequired || [])];
    arr[i] = { ...arr[i], [field]: field === 'terminalState' ? Number(value) : value };
    onChange(index, { ...spec, entitiesRequired: arr });
  };

  const addEntity = () => {
    const arr = [...(spec.entitiesRequired || []), { name: '', terminalState: 2, description: '' }];
    onChange(index, { ...spec, entitiesRequired: arr });
  };

  const removeEntity = (i) => {
    const arr = (spec.entitiesRequired || []).filter((_, idx) => idx !== i);
    onChange(index, { ...spec, entitiesRequired: arr });
  };

  return (
    <div className="spec-card" style={{
      background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
           onClick={() => setExpanded(!expanded)}>
        <span style={{ fontSize: 20, opacity: 0.5 }}>{expanded ? '▼' : '▶'}</span>
        <span style={{
          background: 'rgba(99,102,241,0.3)',
          borderRadius: 6,
          padding: '2px 10px',
          fontSize: 13,
          fontWeight: 600,
        }}>Phase {index + 1}</span>
        <input
          value={spec.phaseName || ''}
          onChange={e => updateField('phaseName', e.target.value)}
          onClick={e => e.stopPropagation()}
          style={{
            flex: 1, background: 'transparent', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.2)',
            color: '#fff', fontSize: 15, fontWeight: 500, padding: '4px 0',
          }}
        />
        <span style={{ fontSize: 12, opacity: 0.5, fontFamily: 'monospace' }}>{spec.phaseId}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Duration */}
          <div>
            <label style={{ fontSize: 12, opacity: 0.6, display: 'block', marginBottom: 4 }}>⏱ 停留时长 (秒)</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="number" value={spec.duration?.min || 0} onChange={e => updateDuration('min', e.target.value)}
                style={{ width: 60, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, color: '#fff', padding: '4px 8px', textAlign: 'center' }}
              />
              <span style={{ opacity: 0.5 }}>~</span>
              <input type="number" value={spec.duration?.max || 0} onChange={e => updateDuration('max', e.target.value)}
                style={{ width: 60, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, color: '#fff', padding: '4px 8px', textAlign: 'center' }}
              />
              <span style={{ fontSize: 12, opacity: 0.5 }}>秒</span>
            </div>
          </div>

          {/* Required Interactions */}
          <div>
            <label style={{ fontSize: 12, opacity: 0.6, display: 'block', marginBottom: 4 }}>🎮 必须交互</label>
            {(spec.requiredInteractions || []).map((inter, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
                <input value={inter} onChange={e => updateInteraction(i, e.target.value)}
                  style={{ flex: 1, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, color: '#fff', padding: '4px 8px', fontFamily: 'monospace', fontSize: 13 }}
                />
                <button onClick={() => removeInteraction(i)}
                  style={{ background: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#ef4444', cursor: 'pointer', padding: '2px 8px', fontSize: 12 }}>✕</button>
              </div>
            ))}
            <button onClick={addInteraction}
              style={{ background: 'rgba(99,102,241,0.15)', border: '1px dashed rgba(99,102,241,0.4)', borderRadius: 6, color: 'rgba(99,102,241,0.8)', cursor: 'pointer', padding: '4px 12px', fontSize: 12, width: '100%' }}>+ 添加交互</button>
          </div>

          {/* Trigger Next */}
          <div>
            <label style={{ fontSize: 12, opacity: 0.6, display: 'block', marginBottom: 4 }}>🔗 推进条件</label>
            <input value={spec.triggerNext?.condition || ''} 
              onChange={e => updateField('triggerNext', { ...spec.triggerNext, condition: e.target.value })}
              placeholder="C# 条件表达式"
              style={{ width: '100%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, color: '#fff', padding: '4px 8px', fontFamily: 'monospace', fontSize: 13, boxSizing: 'border-box' }}
            />
            <input value={spec.triggerNext?.description || ''}
              onChange={e => updateField('triggerNext', { ...spec.triggerNext, description: e.target.value })}
              placeholder="中文描述"
              style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#fff', padding: '4px 8px', fontSize: 12, marginTop: 4, boxSizing: 'border-box' }}
            />
          </div>

          {/* Entities Required */}
          <div>
            <label style={{ fontSize: 12, opacity: 0.6, display: 'block', marginBottom: 4 }}>🏗 必建实体</label>
            {(spec.entitiesRequired || []).map((entity, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
                <input value={entity.name} onChange={e => updateEntity(i, 'name', e.target.value)} placeholder="名称"
                  style={{ flex: 1, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, color: '#fff', padding: '4px 8px', fontFamily: 'monospace', fontSize: 13 }}
                />
                <input type="number" value={entity.terminalState} onChange={e => updateEntity(i, 'terminalState', e.target.value)}
                  style={{ width: 40, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, color: '#fff', padding: '4px 8px', textAlign: 'center', fontSize: 13 }}
                />
                <input value={entity.description} onChange={e => updateEntity(i, 'description', e.target.value)} placeholder="描述"
                  style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#fff', padding: '4px 8px', fontSize: 12 }}
                />
                <button onClick={() => removeEntity(i)}
                  style={{ background: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#ef4444', cursor: 'pointer', padding: '2px 8px', fontSize: 12 }}>✕</button>
              </div>
            ))}
            <button onClick={addEntity}
              style={{ background: 'rgba(99,102,241,0.15)', border: '1px dashed rgba(99,102,241,0.4)', borderRadius: 6, color: 'rgba(99,102,241,0.8)', cursor: 'pointer', padding: '4px 12px', fontSize: 12, width: '100%' }}>+ 添加实体</button>
          </div>

          {/* Flags */}
          <div style={{ display: 'flex', gap: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={spec.playerMustAct !== false}
                onChange={e => updateField('playerMustAct', e.target.checked)}
              /> 玩家必须操作
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={spec.autoAllowed === true}
                onChange={e => updateField('autoAllowed', e.target.checked)}
              /> 允许自动完成
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SpecReviewPanel({ projectId, onConfirmed, showAlert }) {
  const [specs, setSpecs] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [plans, setPlans] = useState(null);
  const [planValidation, setPlanValidation] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let pollTimer = null;

    async function loadSpecs() {
      try {
        const data = await getSpecs(projectId);
        if (cancelled) return;
        setSpecs(data.specs || []);
        setStatus(data.status);
        setProjectName(data.projectName || '');
        setPlans(data.plans || null);
        setPlanValidation(data.planValidation || null);
        setLoading(false);

        // If still extracting, poll every 3s
        if (data.status === 'spec_extracting') {
          pollTimer = setTimeout(loadSpecs, 3000);
        }
      } catch (e) {
        if (!cancelled) { setLoading(false); showAlert?.('加载失败: ' + e.message); }
      }
    }
    loadSpecs();
    return () => { cancelled = true; if (pollTimer) clearTimeout(pollTimer); };
  }, [projectId]);

  const handleSpecChange = useCallback((index, newSpec) => {
    setSpecs(prev => {
      const next = [...prev];
      next[index] = newSpec;
      return next;
    });
  }, []);

  const handleConfirm = useCallback(async () => {
    setConfirming(true);
    try {
      await confirmSpecs(projectId, specs);
      showAlert?.('✅ 体验规格已确认，任务已提交编码队列');
      onConfirmed?.();
    } catch (e) {
      showAlert?.('确认失败: ' + e.message);
    } finally {
      setConfirming(false);
    }
  }, [projectId, specs, onConfirmed, showAlert]);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,0.5)' }}>
        <div style={{ fontSize: 24, marginBottom: 12 }}>⏳</div>
        <div>正在提取体验规格...</div>
      </div>
    );
  }

  if (status === 'spec_extracting') {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,0.5)' }}>
        <div style={{ fontSize: 24, marginBottom: 12, animation: 'spin 2s linear infinite' }}>⚙️</div>
        <div>AI 正在分析分镜，提取体验规格...</div>
        <div style={{ fontSize: 12, marginTop: 8 }}>通常需要 10-30 秒</div>
      </div>
    );
  }

  if (status !== 'spec_review' || specs.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,0.5)' }}>
        <div>暂无待确认的体验规格</div>
        <div style={{ fontSize: 12, marginTop: 8 }}>状态: {status}</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxHeight: '80vh', overflow: 'auto' }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, color: '#fff', fontSize: 18 }}>
          📋 体验规格确认 — {projectName}
        </h3>
        <p style={{ margin: '8px 0 0', fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
          以下是从分镜自动提取的 {specs.length} 个阶段体验规格，以及对应的 assembly / CUA 计划。
          正常项目会自动确认并直接进入编码；只有检测到异常待检查项时，才会停留在这个人工确认页。
        </p>
      </div>

      {/* Summary */}
      <div style={{
        background: 'rgba(99,102,241,0.1)',
        border: '1px solid rgba(99,102,241,0.3)',
        borderRadius: 8,
        padding: 12,
        marginBottom: 16,
        display: 'flex',
        gap: 24,
        fontSize: 13,
      }}>
        <span>📊 {specs.length} 个阶段</span>
        <span>⏱ 总时长 {specs.reduce((s, sp) => s + (sp.duration?.min || 0), 0)}-{specs.reduce((s, sp) => s + (sp.duration?.max || 0), 0)} 秒</span>
        <span>🎮 {specs.reduce((s, sp) => s + (sp.requiredInteractions?.length || 0), 0)} 个交互</span>
        <span>🏗 {specs.reduce((s, sp) => s + (sp.entitiesRequired?.length || 0), 0)} 个实体</span>
      </div>

      <PlanReviewPanel plans={plans} planValidation={planValidation} />

      {specs.map((spec, i) => (
        <SpecCard key={i} spec={spec} index={i} onChange={handleSpecChange} />
      ))}

      <div style={{ display: 'flex', gap: 12, marginTop: 16, justifyContent: 'flex-end' }}>
        <button
          onClick={handleConfirm}
          disabled={confirming}
          style={{
            background: confirming ? 'rgba(99,102,241,0.3)' : 'rgba(99,102,241,0.8)',
            border: 'none',
            borderRadius: 8,
            color: '#fff',
            padding: '10px 24px',
            fontSize: 14,
            fontWeight: 600,
            cursor: confirming ? 'wait' : 'pointer',
          }}
        >
          {confirming ? '提交中...' : '✅ 人工确认并继续编码'}
        </button>
      </div>
    </div>
  );
}
