const shot1Preset = {
  name: '太空打冰块 Shot1',
  nodes: [
    {
      id: 'shot_1',
      type: 'shotNode',
      position: { x: 300, y: 100 },
      data: {
        label: '镜头1',
        name: '初始破冰',
        scene: '1. 有一个卫星，卫星周围有15个冰块，冰块里面有宇航员\n2. 卫星和最近的一个冰块之间，有长长的引导线条\n3. 有一个手指UI，做引导动画，引导卫星移动去最近冰块的位置',
        controlTarget: '卫星',
        controlMethod: '使用轮盘移动卫星',
        triggers: '1. 控制卫星移动，移动到最近的一个冰块的时候，发射子弹打冰块，打5次后，冰块消失，冰块中的宇航员被解救，飞到卫星上',
        endCondition: '所有15个冰块被破坏，宇航员全部收集',
      },
    },
  ],
  edges: [],
};

export default shot1Preset;
