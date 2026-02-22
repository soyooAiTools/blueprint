import shot1Preset from './shot1';

const templates = [
  {
    name: '空白项目',
    nodes: [],
    edges: [],
  },
  {
    name: '线性3镜头',
    nodes: [
      {
        id: 'shot_1',
        type: 'shotNode',
        position: { x: 300, y: 50 },
        data: {
          label: '镜头1',
          name: '开场',
          scene: '',
          controlTarget: '',
          controlMethod: '',
          triggers: '',
          endCondition: '',
        },
      },
      {
        id: 'shot_2',
        type: 'shotNode',
        position: { x: 300, y: 450 },
        data: {
          label: '镜头2',
          name: '发展',
          scene: '',
          controlTarget: '',
          controlMethod: '',
          triggers: '',
          endCondition: '',
        },
      },
      {
        id: 'shot_3',
        type: 'shotNode',
        position: { x: 300, y: 850 },
        data: {
          label: '镜头3',
          name: '结局',
          scene: '',
          controlTarget: '',
          controlMethod: '',
          triggers: '',
          endCondition: '',
        },
      },
    ],
    edges: [
      { id: 'e1-2', source: 'shot_1', target: 'shot_2', type: 'smoothstep', animated: true, style: { stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2 }, markerEnd: { type: 'arrowclosed', color: 'rgba(255,255,255,0.5)' } },
      { id: 'e2-3', source: 'shot_2', target: 'shot_3', type: 'smoothstep', animated: true, style: { stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2 }, markerEnd: { type: 'arrowclosed', color: 'rgba(255,255,255,0.5)' } },
    ],
  },
  {
    name: '分支流程',
    nodes: [
      {
        id: 'shot_1',
        type: 'shotNode',
        position: { x: 300, y: 50 },
        data: {
          label: '镜头1',
          name: '开场',
          scene: '',
          controlTarget: '',
          controlMethod: '',
          triggers: '',
          endCondition: '',
        },
      },
      {
        id: 'shot_2a',
        type: 'shotNode',
        position: { x: 80, y: 450 },
        data: {
          label: '镜头2a',
          name: '分支A',
          scene: '',
          controlTarget: '',
          controlMethod: '',
          triggers: '',
          endCondition: '',
        },
      },
      {
        id: 'shot_2b',
        type: 'shotNode',
        position: { x: 520, y: 450 },
        data: {
          label: '镜头2b',
          name: '分支B',
          scene: '',
          controlTarget: '',
          controlMethod: '',
          triggers: '',
          endCondition: '',
        },
      },
      {
        id: 'shot_3',
        type: 'shotNode',
        position: { x: 300, y: 850 },
        data: {
          label: '镜头3',
          name: '汇合结局',
          scene: '',
          controlTarget: '',
          controlMethod: '',
          triggers: '',
          endCondition: '',
        },
      },
    ],
    edges: [
      { id: 'e1-2a', source: 'shot_1', target: 'shot_2a', type: 'smoothstep', animated: true, label: '条件A', style: { stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2 }, markerEnd: { type: 'arrowclosed', color: 'rgba(255,255,255,0.5)' }, labelStyle: { fill: '#fff', fontWeight: 700, fontSize: 12 }, labelBgStyle: { fill: '#f59e0b', fillOpacity: 0.9 }, labelBgPadding: [6, 4], labelBgBorderRadius: 4 },
      { id: 'e1-2b', source: 'shot_1', target: 'shot_2b', type: 'smoothstep', animated: true, label: '条件B', style: { stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2 }, markerEnd: { type: 'arrowclosed', color: 'rgba(255,255,255,0.5)' }, labelStyle: { fill: '#fff', fontWeight: 700, fontSize: 12 }, labelBgStyle: { fill: '#f59e0b', fillOpacity: 0.9 }, labelBgPadding: [6, 4], labelBgBorderRadius: 4 },
      { id: 'e2a-3', source: 'shot_2a', target: 'shot_3', type: 'smoothstep', animated: true, style: { stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2 }, markerEnd: { type: 'arrowclosed', color: 'rgba(255,255,255,0.5)' } },
      { id: 'e2b-3', source: 'shot_2b', target: 'shot_3', type: 'smoothstep', animated: true, style: { stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2 }, markerEnd: { type: 'arrowclosed', color: 'rgba(255,255,255,0.5)' } },
    ],
  },
  shot1Preset,
];

export default templates;
