import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import Login from './components/Login';
import ProjectList from './components/ProjectList';
import PhaseNode from './components/PhaseNode';
import EntityNode from './components/EntityNode';
import JoinNode from './components/JoinNode';
import NoteNode from './components/NoteNode';
import Toolbar from './components/Toolbar';
import PropsPanel from './components/PropsPanel';
import TopBar from './components/TopBar';
import TaskPanel from './components/TaskPanel';
import StoryboardPanel from './components/StoryboardPanel';
import SpecReviewPanel from './components/SpecReviewPanel';
import { ModalProviderWithContext, useModal } from './components/ModalProvider';
import { exportToJSON, downloadJSON } from './utils/export';
import { importFromJSON, readFileAsJSON } from './utils/import';
import {
  saveBlueprint,
  submitProject,
  submitFeedback,
  approveProject,
  getWebglInfo,
  getProject,
  fetchProjects,
  getSpecs,
  svnCommit,
} from './utils/api';
import { normalizeLegendShape, normalizeLegendColor } from '../../engine/legend-normalizer.cjs';
import { validateShotProgressionMonotonic } from '../../engine/preview-validators.cjs';

const nodeTypes = {
  phaseNode: PhaseNode,
  entityNode: EntityNode,
  joinNode: JoinNode,
  noteNode: NoteNode,
};

const defaultEdgeOptions = {
  type: 'smoothstep',
  animated: true,
  style: { stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2 },
  markerEnd: { type: 'arrowclosed', color: 'rgba(255,255,255,0.5)' },
};

let idCounter = 100;
const getNextId = (prefix) => `${prefix}_${++idCounter}`;

const PHASE_WORD_BLACKLIST = new Set(['phase', 'guide', 'trigger', 'show', 'download', 'operation', 'auto', 'first', 'three', 'ripe', 'boost']);
const PHASE_ALIAS_OVERRIDES = {
  initialGuideMineIce: ['initialCollectIce', 'initialMiningIce'],
  deliverIceToWaterTank: ['transportIceToWaterTank'],
  harvestRipeCorn: ['harvestCorn'],
  producePopcornFromCorn: ['producePopcorn'],
  sellPopcornEarnGold: ['sellPopcornForGold'],
  unlockWorkerAutoOperation: ['unlockWorker'],
  defeatInvadingLittleEnemies: ['defeatLittleEnemies'],
  buildThreeTurretsDefense: ['buildTurretDefense'],
  upgradeCabinBoostPower: ['upgradeCabinAttributes'],
  defeatBossShowDownloadCTA: ['defeatAlienBoss'],
};
const ENTITY_WORD_LABELS = {
  alien: '异形',
  base: '基地',
  blue: '蓝',
  boss: 'Boss',
  bullet: '子弹',
  button: '按钮',
  cabin: '舱室',
  character: '角色',
  corn: '玉米',
  cta: '下载',
  desk: '柜台',
  enemy: '敌人',
  field: '农田',
  gold: '金币',
  ice: '冰',
  little: '小型',
  machine: '机器',
  main: '主',
  obj: '物体',
  ore: '矿',
  player: '玩家',
  popcorn: '爆米花',
  sales: '售卖',
  spaceship: '飞船',
  tank: '水箱',
  turret: '炮塔',
  water: '水',
  worker: '工人',
};

function tokenizePhaseKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .filter((part) => !PHASE_WORD_BLACKLIST.has(part));
}

function normalizePhaseKey(value) {
  return tokenizePhaseKey(value).join('');
}

function phaseMatchScore(alias, runtimePhaseId) {
  const left = tokenizePhaseKey(alias);
  const right = tokenizePhaseKey(runtimePhaseId);
  if (!left.length || !right.length) return 0;
  const leftNorm = left.join('');
  const rightNorm = right.join('');
  if (leftNorm === rightNorm) return 100;
  if (leftNorm && rightNorm && (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm))) return 95;

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let overlap = 0;
  leftSet.forEach((part) => {
    if (rightSet.has(part)) overlap += 1;
  });
  const minSize = Math.min(leftSet.size, rightSet.size);
  const samePrefix = left[0] && right[0] && left[0] === right[0];
  if (samePrefix && overlap >= minSize) return 90;
  if (samePrefix && overlap >= Math.max(2, minSize - 1)) return 80;
  return 0;
}

function buildSpecPhaseAliases(spec) {
  const aliasSet = new Set();
  if (!spec) return aliasSet;
  [spec.phaseId, spec.phaseName, spec.name, spec.label].forEach((value) => {
    if (value) aliasSet.add(String(value).trim());
  });
  (PHASE_ALIAS_OVERRIDES[spec.phaseId] || []).forEach((value) => aliasSet.add(value));
  return aliasSet;
}

function phaseMatchesOrdered(spec, runtimePhaseId, runtimeAlias) {
  if (!runtimePhaseId) return false;
  const runtimeNorm = normalizePhaseKey(runtimePhaseId);
  const aliases = buildSpecPhaseAliases(spec);
  if (runtimeAlias) aliases.add(String(runtimeAlias).trim());
  for (const alias of aliases) {
    const aliasNorm = normalizePhaseKey(alias);
    if (aliasNorm && aliasNorm === runtimeNorm) return true;
    if (phaseMatchScore(alias, runtimePhaseId) >= 80) return true;
  }
  return false;
}

function isRuntimeMetaPhase(phaseId) {
  const norm = normalizePhaseKey(phaseId);
  return norm === 'gamestart' || norm === 'start' || norm === 'init' || norm === 'initialize' || norm === 'gameend';
}

function getOrderedPreviewPhaseStates(previewSpecs, completedPhases, currentPhase, runtimePhaseOrder, hasRuntimeSignal) {
  const runtimeCompleted = Array.from(new Set((completedPhases || []).filter(Boolean)))
    .filter((phaseId) => !isRuntimeMetaPhase(phaseId));
  const runtimeOrder = Array.from(new Set((runtimePhaseOrder || []).filter(Boolean)))
    .filter((phaseId) => !isRuntimeMetaPhase(phaseId));

  const rawStatuses = (previewSpecs || []).map((spec, index) => {
    const runtimeAlias = runtimeOrder[index] || '';
    const done = runtimeCompleted.some((phaseId) => phaseMatchesOrdered(spec, phaseId, runtimeAlias));
    const active = phaseMatchesOrdered(spec, currentPhase, runtimeAlias);
    return { done, active, runtimeAlias };
  });

  let contiguousDoneCount = 0;
  while (contiguousDoneCount < rawStatuses.length && rawStatuses[contiguousDoneCount].done) {
    contiguousDoneCount++;
  }

  const ordered = rawStatuses.map((state, index) => {
    const done = index < contiguousDoneCount;
    const active = !done && index === contiguousDoneCount && (state.active || hasRuntimeSignal);
    return {
      done,
      active,
      outOfOrder: !done && index > contiguousDoneCount && state.done,
    };
  });
  // 反馈 01: SHOT 进度推演必须连续 1→2→3。outOfOrder 只能捕捉「后 done 前未 done」的视觉异常,
  // 真正的跳号 / 回退要靠 validateShotProgressionMonotonic 看 runtime 命中顺序的 spec 索引序列。
  const completionSequence = runtimeOrder
    .map((phaseId) => {
      const idx = (previewSpecs || []).findIndex((spec) => phaseMatchesOrdered(spec, phaseId, ''));
      return idx >= 0 ? { phase: idx + 1 } : null;
    })
    .filter(Boolean);
  const seqIssues = validateShotProgressionMonotonic(completionSequence);
  seqIssues.forEach((issue) => {
    __feedback01_warnOnce(`shot-${issue.kind}:${runtimeOrder.join(',')}:${issue.index}`,
      `SHOT 推演 ${issue.kind}: ${issue.message}`);
  });
  const skips = ordered.filter((s) => s.outOfOrder).length;
  if (skips > 0) {
    __feedback01_warnOnce(`shot-outOfOrder:${runtimeOrder.join(',')}`,
      `SHOT 推演检测到 ${skips} 个 outOfOrder（后 done 前未 done）`);
  }
  return ordered;
}

function splitIdentifierWords(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function containsChinese(value) {
  return /[\u4e00-\u9fa5]/.test(String(value || ''));
}

function inferChineseAlias(value) {
  const text = String(value || '').trim();
  if (!text || !containsChinese(text)) return '';
  const match = text.match(/^([\u4e00-\u9fa5A-Za-z]{2,16}?)(已|可|正在|将|是|会|能|升级|建造|完成|启用|解锁|进入|触发|展示|开始|结束|出现|消失|到达|停止|达到|恢复|被|自动)/);
  if (match && match[1]) return match[1];
  return text.length > 12 ? text.slice(0, 12) : text;
}

function toReadableEnglishLabel(name) {
  const words = splitIdentifierWords(name);
  if (!words.length) return String(name || '').trim();
  const mapped = words.map((word) => {
    const lower = word.toLowerCase();
    return ENTITY_WORD_LABELS[lower] || word;
  });
  if (mapped.some((word, idx) => word !== words[idx])) return mapped.join('');
  return words.join(' ');
}

function formatEntityDisplayName(entity) {
  const displayName = String(entity && entity.displayName || '').trim();
  if (displayName) return displayName;

  const aliasCandidates = []
    .concat(Array.isArray(entity && entity.aliases) ? entity.aliases : [])
    .map(inferChineseAlias)
    .filter(Boolean)
    .sort((a, b) => a.length - b.length);
  if (aliasCandidates.length > 0) return aliasCandidates[0];

  const readable = toReadableEnglishLabel(entity && entity.name);
  if (readable) return readable;
  return String(entity && entity.name || '未命名对象').trim() || '未命名对象';
}

function readPreviewVisual(data, index) {
  const visual = (data && data.visual) || {};
  return {
    shape: normalizeLegendShape(visual.shape || data?.shape || data?.template, index),
    color: normalizeLegendColor(visual.color || data?.color || data?.template, index),
  };
}

// 反馈 01 (2026-04-26): 画面图例 / SHOT 推演运行时校验。
// 模块级去重,避免同一警告在每次重渲染时刷屏。详见 ~/.codex/skills/blueprint/INCIDENTS.md
const __feedback01_warned = new Set();
function __feedback01_warnOnce(key, message) {
  if (__feedback01_warned.has(key)) return;
  __feedback01_warned.add(key);
  console.warn('[反馈01] ' + message);
}

function buildPreviewLegendItems(entityMap, entities, nodes, previewSpecs) {
  const seen = new Map();
  const add = (name, data) => {
    const key = String(name || '').trim();
    if (!key) return;
    const existing = seen.get(key) || { name: key, aliases: [] };
    const next = { ...existing, name: key };
    Object.keys(data || {}).forEach((field) => {
      if (field === 'aliases' || field === 'name') return;
      const value = data[field];
      if (value === undefined || value === null || value === '') return;
      if (existing[field] !== undefined && existing[field] !== null && existing[field] !== '') return;
      next[field] = value;
    });
    const aliases = []
      .concat(existing.aliases || [])
      .concat((data && data.aliases) || [])
      .filter(Boolean);
    next.aliases = Array.from(new Set(aliases));
    seen.set(key, next);
  };

  (entityMap || []).forEach((item, index) => {
    add(item.name, {
      ...item,
      shape: normalizeLegendShape(item.shape, index),
      color: normalizeLegendColor(item.color, index),
    });
  });

  (entities || []).forEach((entity, index) => {
    const visual = readPreviewVisual(entity, index);
    add(entity.name, {
      ...visual,
      displayName: entity.chineseName || entity.label || entity.displayName || '',
      aliases: [entity.label, entity.chineseName].filter(Boolean),
    });
  });

  (nodes || []).forEach((node, index) => {
    if (!node || node.type !== 'entityNode') return;
    const data = node.data || {};
    const visual = readPreviewVisual(data, index);
    add(data.name || node.id, {
      ...visual,
      displayName: data.chineseName || data.label || data.displayName || '',
      aliases: [data.label, data.chineseName].filter(Boolean),
    });
  });

  (previewSpecs || []).forEach((spec) => {
    (spec.entitiesRequired || []).forEach((entity, index) => {
      if (!entity) return;
      add(entity.name || entity, {
        shape: normalizeLegendShape('', index),
        color: normalizeLegendColor('', index),
        aliases: [entity.description].filter(Boolean),
      });
    });
  });

  const result = Array.from(seen.values()).map((item, index) => ({
    ...item,
    shape: normalizeLegendShape(item.shape, index),
    color: normalizeLegendColor(item.color, index),
  }));
  if (result.length === 0) {
    __feedback01_warnOnce('legend-empty', '画面图例为空 — 预览页左侧将显示空白区域');
  } else {
    result.forEach((item) => {
      if (!item.shape) __feedback01_warnOnce(`legend-shape:${item.name}`, `legend "${item.name}" 缺 shape`);
      if (!item.color) __feedback01_warnOnce(`legend-color:${item.name}`, `legend "${item.name}" 缺 color`);
    });
  }
  return result;
}

/**
 * V4 方案A: 从 entities 数组生成画布上的实体节点和条件连线
 */
function generateEntityNodesAndEdges(entities) {
  const nodes = [];
  const edges = [];
  const nameToId = {};
  
  // Layout: group by spawn condition
  const groups = { gameStart: [], runtime: [], conditional: [] };
  entities.forEach((e) => {
    const cond = e.spawn?.condition || '';
    if (cond === 'runtime') groups.runtime.push(e);
    else if (cond.startsWith('phase:1') || cond === 'gameStart' || cond.startsWith('phase:1')) groups.gameStart.push(e);
    else groups.conditional.push(e);
  });
  
  let x = 50, y = 50;
  const COL_WIDTH = 260, ROW_HEIGHT = 130;
  
  // Column 1: gameStart entities
  groups.gameStart.forEach((e, i) => {
    const id = 'entity_' + e.name;
    nameToId[e.name] = id;
    nodes.push({
      id,
      type: 'entityNode',
      position: { x, y: y + i * ROW_HEIGHT },
      data: { ...e },
    });
  });
  
  // Column 2: conditional entities
  x += COL_WIDTH + 80;
  groups.conditional.forEach((e, i) => {
    const id = 'entity_' + e.name;
    nameToId[e.name] = id;
    nodes.push({
      id,
      type: 'entityNode',
      position: { x, y: y + i * ROW_HEIGHT },
      data: { ...e },
    });
  });
  
  // Column 3: runtime/pool entities
  x += COL_WIDTH + 80;
  groups.runtime.forEach((e, i) => {
    const id = 'entity_' + e.name;
    nameToId[e.name] = id;
    nodes.push({
      id,
      type: 'entityNode',
      position: { x, y: y + i * ROW_HEIGHT },
      data: { ...e },
    });
  });
  
  // Generate edges from spawn.condition (entity:XXX references)
  entities.forEach((e) => {
    const cond = e.spawn?.condition || '';
    if (cond.startsWith('entity:')) {
      // entity:ConveyorBelt.state==built → source is ConveyorBelt
      const ref = cond.split(':')[1];
      const sourceName = ref.split('.')[0];
      const sourceId = nameToId[sourceName];
      const targetId = nameToId[e.name];
      if (sourceId && targetId) {
        edges.push({
          id: `edge_${sourceName}_${e.name}`,
          source: sourceId,
          target: targetId,
          type: 'smoothstep',
          label: ref.includes('.') ? ref.split('.').slice(1).join('.') : '',
          style: { stroke: '#7c5cfc' },
          labelStyle: { fontSize: 10, fill: '#a0aec0' },
          animated: true,
        });
      }
    }
    // onBuilt activate links
    if (e.behavior?.onBuilt) {
      e.behavior.onBuilt.forEach((a) => {
        if (a.type === 'activate' && a.params?.target) {
          const sourceId = nameToId[e.name];
          const targetId = nameToId[a.params.target];
          if (sourceId && targetId) {
            edges.push({
              id: `edge_built_${e.name}_${a.params.target}`,
              source: sourceId,
              target: targetId,
              type: 'smoothstep',
              label: 'onBuilt',
              style: { stroke: '#48bb78' },
              labelStyle: { fontSize: 10, fill: '#48bb78' },
              animated: true,
            });
          }
        }
      });
    }
  });
  
  return { nodes, edges };
}

function FlowEditor({ project, onBack, initialTab }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(project.nodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(project.edges || []);
  const [projectName, setProjectName] = useState(project.name || '未命名项目');
  const [projectStatus, setProjectStatus] = useState(project.status || 'editing');
  const [statusMessage, setStatusMessage] = useState(project.statusMessage || '');
  const [previewLandscape, setPreviewLandscape] = useState(false);
  const [feedbackHistory, setFeedbackHistory] = useState(project.feedbackHistory || []);
  const [hasPendingFeedback, setHasPendingFeedback] = useState(false);

  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [activeTab, setActiveTab] = useState(initialTab || 'storyboard');
  const [objectRegistry, setObjectRegistry] = useState(project.objectRegistry || []);
  const [entities, setEntities] = useState(project.entities || []);
  const isV4 = entities.length > 0;
  
  // V4 方案A: 自动从 entities 生成画布节点（仅在首次加载且无 entityNode 时）
  const entityNodesGenerated = useRef(false);
  useEffect(() => {
    if (isV4 && !entityNodesGenerated.current) {
      const hasEntityNodes = nodes.some((n) => n.type === 'entityNode');
      if (!hasEntityNodes && entities.length > 0) {
        const { nodes: eNodes, edges: eEdges } = generateEntityNodesAndEdges(entities);
        setNodes((nds) => [...nds.filter((n) => n.type !== 'phaseNode'), ...eNodes]);
        setEdges((eds) => [...eds.filter((e) => !e.id.startsWith('e_')), ...eEdges]);
        entityNodesGenerated.current = true;
      }
    }
  }, [isV4, entities]);
  
  const [globalParams, setGlobalParams] = useState(project.globalParams || '');
  const [globalSettings, setGlobalSettings] = useState(project.globalSettings || {
    gameType: 'slg',
    cameraMode: 'topDown45',
    cameraProjection: 'orthographic',
    cameraFOV: 60,
    cameraBgColor: '(0.6,0.8,1)',
    defaultInput: 'virtualJoystick',
  });
  const [sourceHtmlPath, setSourceHtmlPath] = useState(
    project.sourceHtmlPath || project.blueprint?.sourceHtmlPath || ''
  );
  // Default to storyboard for new/editing projects (unless explicitly set)
  
  const [webglInfo, setWebglInfo] = useState(null);
  const [previewSpecs, setPreviewSpecs] = useState([]);
  const [entityMap, setEntityMap] = useState([]);
  const [completedPhases, setCompletedPhases] = useState([]);
  const [currentPhase, setCurrentPhase] = useState('');
  const [runtimePhaseOrder, setRuntimePhaseOrder] = useState([]);
  const [hasRuntimePhaseSignal, setHasRuntimePhaseSignal] = useState(false);
  const [previewGameState, setPreviewGameState] = useState(null);
  const [svnCommitting, setSvnCommitting] = useState(false);
  const [iframeLoading, setIframeLoading] = useState(true);
  const reactFlowInstance = useReactFlow();
  const entityCountRef = useRef((project.entities || []).length || (project.nodes || []).filter((n) => n.type === 'entityNode').length || 1);
  const autoSaveRef = useRef(null);
  const { showAlert, showConfirm, showPrompt } = useModal();

  // Fetch WebGL info + feedback history when status warrants it
  useEffect(() => {
    if (['preview_ready', 'reviewing', 'approved', 'committed', 'feedback', 'done'].indexOf(projectStatus) >= 0) {
      getWebglInfo(project.id).then(setWebglInfo).catch(() => {});
      getProject(project.id).then((p) => {
        if (p.feedbackHistory && p.feedbackHistory.length > 0) {
          setFeedbackHistory(p.feedbackHistory);
          // Mark existing revisions as done if feedback was already submitted
          setNodes((nds) => nds.map((n) => {
            if (n.data.inFeedbackList && n.data.revisions) {
              const updatedRevs = n.data.revisions.map((r) =>
                r.status === 'pending' ? { ...r, status: 'done' } : r
              );
              return { ...n, data: { ...n.data, revisions: updatedRevs } };
            }
            return n;
          }));
        }
      }).catch(() => {});
    }
  }, [projectStatus, project.id]);

  // Fetch specs + poll iframe __gameState for phase progress
  const iframeRef = useRef(null);
  // useMemo: nodes changes on every React Flow drag tick; recomputing these
  // O(n*m) walks every render visibly stutters the editor with large graphs.
  const previewPhaseStates = useMemo(
    () => getOrderedPreviewPhaseStates(previewSpecs, completedPhases, currentPhase, runtimePhaseOrder, hasRuntimePhaseSignal),
    [previewSpecs, completedPhases, currentPhase, runtimePhaseOrder, hasRuntimePhaseSignal],
  );
  const matchedPreviewPhaseCount = previewPhaseStates.filter((item) => item.done).length;
  const previewLegendItems = useMemo(
    () => buildPreviewLegendItems(entityMap, entities, nodes, previewSpecs),
    [entityMap, entities, nodes, previewSpecs],
  );
  const previewOffscreenEntities = useMemo(() => {
    const rawList = previewGameState && Array.isArray(previewGameState.offscreenEntities)
      ? previewGameState.offscreenEntities
      : [];
    const names = rawList.map((name) => String(name || '').trim()).filter(Boolean);
    const cameraCount = previewGameState && previewGameState.cameraState
      ? Number(previewGameState.cameraState.offscreenCount)
      : NaN;
    const hasSignal = Array.isArray(previewGameState && previewGameState.offscreenEntities)
      || Number.isFinite(cameraCount);
    return {
      names,
      count: Number.isFinite(cameraCount) ? Math.max(cameraCount, names.length) : names.length,
      hasSignal,
    };
  }, [previewGameState]);
  useEffect(() => {
    if (activeTab !== 'review') return;
    getSpecs(project.id).then((data) => {
      const arr = Array.isArray(data) ? data : (data && data.specs) || [];
      if (arr.length > 0) setPreviewSpecs(arr);
      if (data && Array.isArray(data.entityMap)) setEntityMap(data.entityMap);
    }).catch(() => {});
  }, [activeTab, project.id]);

  useEffect(() => {
    if (activeTab !== 'review' || !webglInfo || !webglInfo.available) return;
    const poll = setInterval(() => {
      try {
        const iframe = iframeRef.current;
        if (!iframe || !iframe.contentWindow) return;
        const gs = iframe.contentWindow.__gameState;
        if (gs) {
          setPreviewGameState(gs);
          setHasRuntimePhaseSignal(true);
          if (Array.isArray(gs.completedPhases)) setCompletedPhases(gs.completedPhases);
          if (typeof gs.currentPhase === 'string') setCurrentPhase(gs.currentPhase);
          if (gs.phaseTimestamps && typeof gs.phaseTimestamps === 'object') {
            const orderedRuntimePhases = Object.keys(gs.phaseTimestamps);
            if (orderedRuntimePhases.length > 0) setRuntimePhaseOrder(orderedRuntimePhases);
          }
        }
      } catch (e) { /* cross-origin — ignore */ }
    }, 1000);
    return () => clearInterval(poll);
  }, [activeTab, webglInfo]);

  // Poll for WebGL build completion
  const buildNotified = useRef(false);
  useEffect(() => {
    if (['submitted', 'processing', 'developing', 'building', 'feedback'].indexOf(projectStatus) === -1 || buildNotified.current) return;
    const interval = setInterval(() => {
      getWebglInfo(project.id)
        .then((info) => {
          if (info && info.available && !buildNotified.current) {
            buildNotified.current = true;
            setWebglInfo(info);
            setProjectStatus('preview_ready');
            clearInterval(interval);
          }
        })
        .catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, [projectStatus, project.id]);

  // Poll for status changes
  useEffect(() => {
    if (['submitted', 'processing', 'developing', 'building', 'preview_ready', 'feedback', 'spec_extracting', 'spec_review'].indexOf(projectStatus) === -1) return;
    const interval = setInterval(() => {
      getProject(project.id)
        .then((p) => {
          if (p.status !== projectStatus) setProjectStatus(p.status);
          if (p.statusMessage !== undefined) setStatusMessage(p.statusMessage || '');
          if (p.feedbackHistory) setFeedbackHistory(p.feedbackHistory);
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [projectStatus, project.id]);

  // Auto-save to backend
  useEffect(() => {
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
    autoSaveRef.current = setTimeout(() => {
      saveBlueprint(project.id, nodes, edges, projectName, { objectRegistry, globalParams, globalSettings, entities }).catch((err) => {
        console.warn('自动保存失败:', err);
      });
    }, 2000);
    return () => { if (autoSaveRef.current) clearTimeout(autoSaveRef.current); };
  }, [nodes, edges, projectName, project.id, objectRegistry, globalParams, globalSettings]);

  const onConnect = useCallback(
    (params) => {
      setEdges((eds) => addEdge({ ...params, ...defaultEdgeOptions }, eds));
    },
    [setEdges]
  );

  const onNodeClick = useCallback((_, node) => {
    setSelectedNode(node);
    setSelectedEdge(null);
  }, []);

  const onEdgeClick = useCallback((_, edge) => {
    setSelectedEdge(edge);
    setSelectedNode(null);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
  }, []);

  const onUpdateNode = useCallback(
    (nodeId, updates) => {
      setNodes((nds) => {
        const newNds = nds.map((n) => {
          if (n.id === nodeId) {
            return { ...n, data: { ...n.data, ...updates } };
          }
          return n;
        });
        // Check if any shot has pending revisions → enable feedback button
        const hasPending = newNds.some((n) =>
          n.data.inFeedbackList &&
          (n.data.revisions || []).some((r) => r.status === 'pending' && r.instruction && r.instruction.trim())
        );
        setHasPendingFeedback(hasPending);
        return newNds;
      });
      setSelectedNode((prev) => {
        if (prev && prev.id === nodeId) {
          return { ...prev, data: { ...prev.data, ...updates } };
        }
        return prev;
      });
    },
    [setNodes]
  );

  const onUpdateEdge = useCallback(
    (edgeId, label) => {
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id === edgeId) {
            const updated = { ...e };
            if (label) {
              updated.label = label;
              updated.labelStyle = { fill: '#fff', fontWeight: 700, fontSize: 12 };
              updated.labelBgStyle = { fill: '#f59e0b', fillOpacity: 0.9 };
              updated.labelBgPadding = [6, 4];
              updated.labelBgBorderRadius = 4;
            } else {
              delete updated.label;
              delete updated.labelStyle;
              delete updated.labelBgStyle;
              delete updated.labelBgPadding;
              delete updated.labelBgBorderRadius;
            }
            return updated;
          }
          return e;
        })
      );
      setSelectedEdge((prev) => {
        if (prev && prev.id === edgeId) {
          return { ...prev, label: label || '' };
        }
        return prev;
      });
    },
    [setEdges]
  );

  const onDeleteNode = useCallback(
    (nodeId) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedNode(null);
    },
    [setNodes, setEdges]
  );

  const getViewportCenter = useCallback(() => {
    const vp = reactFlowInstance.getViewport();
    const bounds = document.querySelector('.react-flow')?.getBoundingClientRect();
    if (!bounds) return { x: 300, y: 200 };
    const centerX = (-vp.x + bounds.width / 2) / vp.zoom;
    const centerY = (-vp.y + bounds.height / 2) / vp.zoom;
    return { x: centerX - 140, y: centerY - 150 };
  }, [reactFlowInstance]);

  const onAddShot = useCallback(() => {
    entityCountRef.current += 1;
    const pos = getViewportCenter();
    const newNode = {
      id: getNextId('entity'),
      type: 'entityNode',
      position: { x: pos.x + Math.random() * 60 - 30, y: pos.y + Math.random() * 60 - 30 },
      data: {
        name: `Entity_${entityCountRef.current}`,
        label: '',
        template: 'Static',
        visual: { shape: 'Cube', scale: '1×1×1', color: '(0.5,0.5,0.5)', position: '(0,0,0)' },
        spawn: { condition: 'gameStart', style: 'instant' },
        behavior: {},
        trigger: { type: 'none' },
      },
    };
    setNodes((nds) => [...nds, newNode]);
  }, [setNodes, getViewportCenter]);

  const onAddJoin = useCallback(() => {
    const pos = getViewportCenter();
    const newNode = {
      id: getNextId('join'),
      type: 'joinNode',
      position: { x: pos.x + 100, y: pos.y + Math.random() * 60 },
      data: { label: '汇合' },
    };
    setNodes((nds) => [...nds, newNode]);
  }, [setNodes, getViewportCenter]);

  const onAddNote = useCallback(() => {
    const pos = getViewportCenter();
    const newNode = {
      id: getNextId('note'),
      type: 'noteNode',
      position: { x: pos.x + Math.random() * 60, y: pos.y + Math.random() * 60 },
      data: { text: '' },
    };
    setNodes((nds) => [...nds, newNode]);
  }, [setNodes, getViewportCenter]);

  const onLoadTemplate = useCallback(
    async (tpl) => {
      if (nodes.length > 0) {
        if (!(await showConfirm(`加载模板「${tpl.name}」将覆盖当前画布，确认？`))) return;
      }
      setNodes(tpl.nodes || []);
      setEdges(tpl.edges || []);
      setSelectedNode(null);
      setSelectedEdge(null);
      if (tpl.name) {
        setProjectName(tpl.name);
      }
      entityCountRef.current = (tpl.entities || []).length || (tpl.nodes || []).filter((n) => n.type === 'entityNode').length;
      setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.2 });
      }, 50);
    },
    [nodes, setNodes, setEdges, reactFlowInstance, showConfirm]
  );

  const onExportJSON = useCallback(async () => {
    const data = exportToJSON(projectName, nodes, edges, { objectRegistry, globalParams, globalSettings });
    downloadJSON(data, `${projectName || 'blueprint'}.json`);
    // Auto-submit feedback when exporting in reviewing state
    if (projectStatus === 'reviewing') {
      try {
        const result = await submitFeedback(project.id, { blueprint: data, text: '蓝图反馈更新' });
        setProjectStatus(result.status);
        await showAlert('✅ 反馈已同步提交给 Coding Agent！');
      } catch (err) {
        console.warn('自动提交反馈失败:', err);
      }
    }
  }, [projectName, nodes, edges, projectStatus, project.id, showAlert]);

  const onImportJSON = useCallback(
    async (file) => {
      try {
        const result = await readFileAsJSON(file);
        let newNodes, newEdges, pn;
        if (result.__parsed) {
          ({ nodes: newNodes, edges: newEdges, projectName: pn } = result);
        } else {
          ({ nodes: newNodes, edges: newEdges, projectName: pn } = importFromJSON(result));
        }
        setNodes(newNodes);
        setEdges(newEdges);
        setProjectName(pn);
        if (result.objectRegistry) setObjectRegistry(result.objectRegistry);
        if (result.globalParams) setGlobalParams(result.globalParams);
        if (result.globalSettings) setGlobalSettings(result.globalSettings);
        setSelectedNode(null);
        setSelectedEdge(null);
        setTimeout(() => {
          reactFlowInstance.fitView({ padding: 0.2 });
        }, 50);
      } catch (err) {
        await showAlert('导入失败: ' + err.message);
      }
    },
    [setNodes, setEdges, reactFlowInstance, showAlert]
  );

  const onClearCanvas = useCallback(async () => {
    if (!(await showConfirm('确认清空画布？所有数据将丢失。'))) return;
    setNodes([]);
    setEdges([]);
    setSelectedNode(null);
    setSelectedEdge(null);
  }, [setNodes, setEdges, showConfirm]);

  const handleSubmit = useCallback(async () => {
    if (!sourceHtmlPath) {
      await showAlert('请先在分镜页生成并确认 HTML 预览，再提交 WebGL 生成流程');
      return;
    }
    try {
      await saveBlueprint(project.id, nodes, edges, projectName, { objectRegistry, globalParams, globalSettings, entities });
      const result = await submitProject(project.id);
      setProjectStatus(result.status);
      if (result.message !== undefined) setStatusMessage(result.message || '');
      await showAlert('✅ 已成功提交给 Coding Agent！');
    } catch (err) {
      await showAlert('提交失败: ' + err.message);
    }
  }, [project.id, nodes, edges, projectName, objectRegistry, globalParams, globalSettings, entities, sourceHtmlPath, showAlert]);

  const handleStoryboardHtmlApproved = useCallback(async (htmlResult) => {
    const sourceHtmlPath = htmlResult?.paths?.html || '';
    if (!sourceHtmlPath) throw new Error('HTML 产物缺少 sourceHtmlPath');
    const sourceHtmlUrl = htmlResult?.urls?.html || '';
    await saveBlueprint(project.id, [], [], projectName, {
      objectRegistry: [],
      globalParams,
      globalSettings,
      entities: [],
      phases: [],
      sourceHtmlPath,
      sourceHtmlUrl,
      sourceHtmlJobId: htmlResult.jobId || '',
      storyboardFrames: [],
      clearDerivedStoryboardState: true,
    });
    setNodes([]);
    setEdges([]);
    setEntities([]);
    setObjectRegistry([]);
    setSourceHtmlPath(sourceHtmlPath);
    const result = await submitProject(project.id);
    setProjectStatus(result.status);
    if (result.message !== undefined) setStatusMessage(result.message || '');
    await showAlert('✅ HTML 已确认，已提交 WebGL 生成流程');
  }, [project.id, projectName, globalParams, globalSettings, setNodes, setEdges, setEntities, setObjectRegistry, showAlert]);

  const handleApprove = useCallback(async () => {
    try {
      const result = await approveProject(project.id);
      setProjectStatus(result.status);
      await showAlert('✅ 审核已通过！');
    } catch (err) {
      await showAlert('通过失败: ' + err.message);
    }
  }, [project.id, showAlert]);

  const handleFeedback = useCallback(async (text) => {
    try {
      const result = await submitFeedback(project.id, { text });
      setProjectStatus(result.status);
      if (result.feedbackHistory) setFeedbackHistory(result.feedbackHistory);
      else setFeedbackHistory((prev) => [...prev, { text, timestamp: new Date().toISOString() }]);
      // Mark all pending revisions in TaskPanel as done
      setNodes((nds) => nds.map((n) => {
        if (n.data.inFeedbackList && n.data.revisions) {
          const updatedRevs = n.data.revisions.map((r) =>
            r.status === 'pending' ? { ...r, status: 'done' } : r
          );
          return { ...n, data: { ...n.data, revisions: updatedRevs } };
        }
        return n;
      }));
      setHasPendingFeedback(false);
      await showAlert('✅ 反馈已提交！');
    } catch (err) {
      await showAlert('反馈失败: ' + err.message);
    }
  }, [project.id, showAlert, setNodes]);

  // Whether storyboard has been parsed (frames exist) or blueprint has content
  const hasContent = nodes.length > 0 || entities.length > 0;

  return (
    <div className="app-container">
      <TopBar
        projectName={projectName}
        onProjectNameChange={setProjectName}
        onExportJSON={onExportJSON}
        onImportJSON={onImportJSON}
        onClearCanvas={onClearCanvas}
        onBack={onBack}
        projectStatus={projectStatus}
                statusMessage={statusMessage}
        onSubmit={handleSubmit}
        onApprove={handleApprove}
        onFeedback={handleFeedback}
        shotCount={nodes.filter((n) => n.type === 'entityNode' || n.type === 'phaseNode').length}
        sourceHtmlReady={!!sourceHtmlPath}
        activeTab={activeTab}
      />
      <div className="app-tabs">
        <button
          className={`app-tab ${activeTab === 'storyboard' ? 'app-tab-active' : ''}`}
          onClick={() => setActiveTab('storyboard')}
        >
          🎬 分镜
        </button>
        {hasContent && (
          <button
            className={`app-tab ${activeTab === 'blueprint' ? 'app-tab-active' : ''}`}
            onClick={() => setActiveTab('blueprint')}
          >
            🗺 蓝图
          </button>
        )}

        {['preview_ready', 'reviewing', 'approved', 'committed', 'feedback'].indexOf(projectStatus) >= 0 && (
          <button
            className={`app-tab ${activeTab === 'review' ? 'app-tab-active' : ''}`}
            onClick={() => setActiveTab('review')}
          >
            📱 预览
          </button>
        )}
      </div>
      <div className="app-body">
        {activeTab === 'storyboard' ? (
          <StoryboardPanel
            projectName={projectName}
            onApproveHtmlPreview={handleStoryboardHtmlApproved}
            hasExistingNodes={nodes.length > 0}
            showAlert={showAlert}
            showConfirm={showConfirm}
          />
        ) : activeTab === 'blueprint' ? (
          <>
            <Toolbar
              onAddShot={onAddShot}
              onAddJoin={onAddJoin}
              onAddNote={onAddNote}
              onLoadTemplate={onLoadTemplate}
              isV4={isV4}
            />
            <div className="canvas-container">
              <ReactFlow
                nodes={nodes.map(n => {
                  if (n.type === 'phaseNode') return { ...n, data: { ...n.data, _entities: entities } };
                  return n;
                })}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={onNodeClick}
                onEdgeClick={onEdgeClick}
                onPaneClick={onPaneClick}
                nodeTypes={nodeTypes}
                defaultEdgeOptions={defaultEdgeOptions}
                fitView
                fitViewOptions={{ padding: 0.3 }}
                deleteKeyCode={['Backspace', 'Delete']}
                snapToGrid
                snapGrid={[20, 20]}
              >
                <Background color="#1a1a3a" gap={20} size={1} variant="dots" />
                <Controls position="bottom-left" />
              </ReactFlow>
            </div>
            <PropsPanel
              selectedNode={selectedNode}
              selectedEdge={selectedEdge}
              onUpdateNode={onUpdateNode}
              onUpdateEdge={onUpdateEdge}
              onDeleteNode={onDeleteNode}
              objectRegistry={objectRegistry}
              globalParams={globalParams}
              globalSettings={globalSettings}
              onChangeRegistry={setObjectRegistry}
              onChangeParams={setGlobalParams}
              onChangeGlobalSettings={setGlobalSettings}
              entities={entities}
              onChangeEntities={setEntities}
              isV4={isV4}
            />
          </>
        ) : activeTab === 'review' ? (
          <div className="preview-center">
              <div className="preview-toolbar">
                <button className="preview-refresh-btn" onClick={() => {
                  if (iframeRef.current) {
                    const currentSrc = iframeRef.current.getAttribute('src') || webglInfo?.url || '';
                    iframeRef.current.setAttribute('src', currentSrc);
                  }
                  setCompletedPhases([]);
                  setCurrentPhase('');
                  setPreviewGameState(null);
                  setIframeLoading(true);
                }} title="刷新预览">🔄</button>
                <button className="preview-orientation-btn" onClick={() => setPreviewLandscape(!previewLandscape)}
                  title={previewLandscape ? '切换竖屏' : '切换横屏'}>
                  {previewLandscape ? '📱 竖屏' : '📲 横屏'}
                </button>
                <span className="preview-progress-counter">
                  {matchedPreviewPhaseCount}/{previewSpecs.length} Shots
                </span>
                <button className="preview-svn-btn" disabled={svnCommitting} onClick={async () => {
                  if (!project.svnUrl) {
                    showAlert('该项目未配置 SVN 地址，请在创建项目时填写');
                    return;
                  }
                  const ok = await showConfirm('确认提交到 SVN？\n目标: ' + project.svnUrl);
                  if (!ok) return;
                  setSvnCommitting(true);
                  try {
                    const resp = await svnCommit(project.id);
                    if (resp.error) {
                      showAlert('SVN 提交失败: ' + resp.error);
                    } else {
                      showAlert('SVN 提交成功' + (resp.revision ? ' (r' + resp.revision + ')' : ''));
                    }
                  } catch(e) {
                    showAlert('SVN 提交失败: ' + e.message);
                  } finally {
                    setSvnCommitting(false);
                  }
                }}>
                  {svnCommitting ? '⏳ 提交中...' : '📤 提交SVN'}
                </button>
              </div>
              {webglInfo && webglInfo.available ? (
                <div className="preview-main-row">
                  {previewLegendItems.length > 0 && (() => {
                    const shapeLabel = { Cube: '方块', Sphere: '球', Cylinder: '柱体', Plane: '平面' };
                    const colorLabel = { Red: '红色', Blue: '蓝色', Green: '绿色', Yellow: '黄色', Orange: '橙色', Purple: '紫色', White: '白色', Brown: '棕色', Cyan: '青色', Pink: '粉色', Gray: '灰色' };
                    return (
                      <div className="preview-entity-legend">
                        <div className="preview-shot-title">画面图例</div>
                        {previewLegendItems.map((e) => (
                          <div key={e.name} className="preview-entity-item">
                            <span className={`preview-entity-swatch color-${String(e.color || 'Blue').toLowerCase()}`}>
                              {e.shape === 'Cube' ? '■' : e.shape === 'Sphere' ? '●' : e.shape === 'Cylinder' ? '▮' : '▬'}
                            </span>
                            <span className="preview-entity-label">
                              {colorLabel[e.color] || e.color}{shapeLabel[e.shape] || e.shape}
                            </span>
                            <span className="preview-entity-name">
                              {formatEntityDisplayName(e)}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  <div className={`preview-phone-frame preview-phone-large ${previewLandscape ? 'landscape' : ''}`} style={{ position: 'relative' }}>
                    {!previewLandscape && <div className="preview-phone-notch" />}
                    {iframeLoading && (
                      <div className="webgl-loading-overlay">
                        <div className="webgl-loading-spinner" />
                        <div className="webgl-loading-text">加载中...</div>
                        <div className="webgl-loading-hint">Luna WebGL 引擎初始化</div>
                      </div>
                    )}
                    <iframe
                      ref={iframeRef}
                      className="preview-iframe"
                      src={webglInfo.url}
                      title="WebGL Preview"
                      allow="autoplay; fullscreen; webgl; webgl2"
                      allowFullScreen
                      scrolling="no"
                      style={{ overflow: 'hidden' }}
                      onLoad={(e) => {
                        const iframe = e.target;
                        const sendStartMsg = () => {
                          try {
                            iframe.contentWindow.postMessage(JSON.stringify({
                              name: 'setPlaygroundAssetOverrides',
                              data: '{}'
                            }), '*');
                          } catch(err) {}
                        };
                        sendStartMsg();
                        setTimeout(sendStartMsg, 500);
                        setTimeout(sendStartMsg, 1500);
                        setTimeout(sendStartMsg, 3000);
                        // Wait for game to actually render (not just HTML load)
                        const checkReady = setInterval(() => {
                          try {
                            const gs = iframe.contentWindow.__gameState;
                            if (gs || iframe.contentWindow.pc) {
                              setIframeLoading(false);
                              clearInterval(checkReady);
                            }
                          } catch(err) {}
                        }, 300);
                        // Fallback: hide after 8s regardless
                        setTimeout(() => { setIframeLoading(false); clearInterval(checkReady); }, 8000);
                      }}
                    />
                    <div className="preview-input-shield" title="预览模式已禁用手动操作">
                      <span className="preview-input-shield-label">预览模式已禁用手动操作</span>
                    </div>
                  </div>
                  {previewSpecs.length > 0 && (
                  <div className="preview-shot-list">
                      <div className="preview-shot-title">Shot 进度</div>
                      <div className={`preview-framing-status${previewOffscreenEntities.count > 0 ? ' warning' : ''}`}>
                        <span className="preview-framing-label">
                          {previewOffscreenEntities.count > 0 ? '构图风险' : (previewOffscreenEntities.hasSignal ? '构图正常' : '等待构图信号')}
                        </span>
                        {previewOffscreenEntities.count > 0 && (
                          <span className="preview-framing-detail">
                            {previewOffscreenEntities.names.length > 0
                              ? previewOffscreenEntities.names.slice(0, 4).join(', ')
                              : previewOffscreenEntities.count + ' 个实体出镜'}
                          </span>
                        )}
                      </div>
                      {previewSpecs.map((spec, i) => {
                        const phaseState = previewPhaseStates[i] || { done: false, active: false };
                        const done = phaseState.done;
                        const active = phaseState.active;
                        const outOfOrder = phaseState.outOfOrder;
                        const desc = spec.triggerNext && spec.triggerNext.description;
                        return (
                          <div
                            key={spec.phaseId}
                            className={`preview-shot-item${done ? ' done' : ''}${active ? ' active' : ''}${outOfOrder ? ' out-of-order' : ''}`}
                            title={outOfOrder ? '运行时已上报，但前序 Shot 尚未完成，暂不计入进度' : ''}
                          >
                            <span className="preview-shot-num">{i + 1}</span>
                            <div className="preview-shot-text">
                              <span className="preview-shot-name">{spec.phaseName}</span>
                              {desc && <span className="preview-shot-desc">{desc}</span>}
                              {outOfOrder && <span className="preview-shot-note">等待前序 Shot 完成</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="preview-empty">
                  {(projectStatus === 'spec_extracting' || projectStatus === 'spec_review') ? (
                    <SpecReviewPanel
                      projectId={project.id}
                      onConfirmed={() => setProjectStatus('submitted')}
                      showAlert={showAlert}
                    />
                  ) : projectStatus === 'submitted' ? (
                    <>
                      <div className="preview-empty-icon">⏳</div>
                      <div className="preview-empty-text">已提交开发</div>
                      <div className="preview-empty-hint">Coding Agent 正在生成代码，请耐心等待...</div>
                    </>
                  ) : projectStatus === 'building' ? (
                    <>
                      <div className="preview-empty-icon">🔨</div>
                      <div className="preview-empty-text">正在构建 WebGL</div>
                      <div className="preview-empty-hint">代码已完成，正在打包中...</div>
                    </>
                  ) : (
                    <>
                      <div className="preview-empty-icon">📱</div>
                      <div className="preview-empty-text">暂无预览</div>
                      <div className="preview-empty-hint">等待 Coding Agent 交付 WebGL 包</div>
                    </>
                  )}
                </div>
              )}
          </div>
        ) : (
          <TaskPanel nodes={nodes} onUpdateNode={onUpdateNode} feedbackSubmitted={feedbackHistory.length > 0} />
        )}
      </div>
    </div>
  );
}

// Global build notification component
function GlobalBuildNotification({ user, currentProject, onGoToProject }) {
  const [notification, setNotification] = useState(null);
  const notifiedRef = useRef({});

  useEffect(() => {
    if (!user) return;
    // Check once on mount, then poll only if there are active builds
    let hasActiveBuilds = false;
    const checkBuilds = async () => {
      try {
        const projects = await fetchProjects();
        hasActiveBuilds = false;
        for (const p of projects) {
          if (['submitted', 'building', 'feedback'].indexOf(p.status) !== -1) {
            hasActiveBuilds = true;
            if (!notifiedRef.current[p.id]) {
              try {
                const info = await getWebglInfo(p.id);
                if (info && info.available) {
                  notifiedRef.current[p.id] = true;
                  setNotification({ project: p, url: info.url });
                }
              } catch {}
            }
          }
        }
      } catch {}
    };
    checkBuilds();
    const interval = setInterval(() => {
      if (hasActiveBuilds) checkBuilds();
    }, 15000);
    return () => clearInterval(interval);
  }, [user]);

  if (!notification) return null;

  return (
    <div className="global-notification-overlay" onClick={() => setNotification(null)}>
      <div className="global-notification" onClick={(e) => e.stopPropagation()}>
        <div className="global-notification-icon">🎉</div>
        <div className="global-notification-title">WebGL 构建完成</div>
        <div className="global-notification-text">
          项目「{notification.project.name}」已完成构建，可以预览了！
        </div>
        <div className="global-notification-actions">
          <button
            className="global-notification-btn global-notification-btn-primary"
            onClick={() => { onGoToProject(notification.project); setNotification(null); }}
          >
            🚀 立即查看
          </button>
          <button
            className="global-notification-btn"
            onClick={() => setNotification(null)}
          >
            稍后再看
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(() => localStorage.getItem('blueprint_user'));
  const [currentProject, setCurrentProject] = useState(null);
  const [goToReview, setGoToReview] = useState(false);

  const handleGoToProject = useCallback((project) => {
    setGoToReview(true);
    setCurrentProject(project);
  }, []);

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  if (!currentProject) {
    return (
      <>
        <ProjectList
          user={user}
          onSelectProject={(p) => { setGoToReview(false); setCurrentProject(p); }}
          onLogout={() => {
            localStorage.removeItem('blueprint_user');
            setUser(null);
          }}
        />
        {/* GlobalBuildNotification disabled */}
      </>
    );
  }

  return (
    <ModalProviderWithContext>
      <ReactFlowProvider>
        <FlowEditor
          key={currentProject.id}
          project={currentProject}
          onBack={() => setCurrentProject(null)}
          initialTab={goToReview ? 'review' : 'storyboard'}
        />
      </ReactFlowProvider>
      {/* GlobalBuildNotification disabled */}
    </ModalProviderWithContext>
  );
}
