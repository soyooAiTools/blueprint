// Restore full 10-shot blueprint while keeping V3 global data
const fs = require('fs');
const recovered = require('./recovered-qmjs.json');
const bp = recovered.blueprint || recovered;

// Build the full blueprint with nodes/edges from recovered + V3 data from API
const fullBp = {
  nodes: bp.nodes,
  edges: bp.edges || [],
  // V3 global data (from the previous API PUT - hardcoded here as backup)
  objectRegistry: [
    {name:"Ground",shape:"Ground",scale:"40×1×40",color:"(0.35,0.25,0.15)",firstSeen:1,label:"地面",role:"decoration",interactionType:"none"},
    {name:"Player",shape:"Cube",scale:"1×2×1",color:"(0.2,0.4,0.9)",firstSeen:1,label:"玩家",role:"player",interactionType:"none"},
    {name:"Base",shape:"Cube",scale:"3×3×3",color:"(0.85,0.7,0.4)",firstSeen:1,label:"基地",role:"interactive",interactionType:"proximity"},
    {name:"WoodFence",shape:"Cube",scale:"0.3×1.5×4",color:"(0.6,0.35,0.1)",firstSeen:1,label:"木栅栏",role:"decoration",interactionType:"none"},
    {name:"PineTree_L",shape:"Cylinder",scale:"0.5×3×0.5",color:"(0.1,0.55,0.1)",firstSeen:1,label:"松树(左)",role:"decoration",interactionType:"none"},
    {name:"PineTree_R",shape:"Cylinder",scale:"0.5×3×0.5",color:"(0.1,0.55,0.1)",firstSeen:1,label:"松树(右)",role:"decoration",interactionType:"none"},
    {name:"Generator",shape:"Cube",scale:"2×2×2",color:"(0.5,0.5,0.55)",firstSeen:1,label:"发电机",role:"interactive",interactionType:"proximity"},
    {name:"ConveyorBelt",shape:"Cube",scale:"4×0.3×1",color:"(0.5,0.5,0.55)",firstSeen:1,label:"传送带",role:"interactive",interactionType:"proximity"},
    {name:"Crossbow_L",shape:"Cube",scale:"1×1.5×1",color:"(0.5,0.5,0.55)",firstSeen:2,label:"弩炮(左)",role:"interactive",interactionType:"click"},
    {name:"Crossbow_R",shape:"Cube",scale:"1×1.5×1",color:"(0.5,0.5,0.55)",firstSeen:2,label:"弩炮(右)",role:"interactive",interactionType:"click"},
    {name:"Enemy_A",shape:"Cube",scale:"0.8×1.6×0.8",color:"(0.85,0.15,0.15)",firstSeen:2,label:"敌人A",role:"enemy",interactionType:"auto"},
    {name:"WoodLog",shape:"Cylinder",scale:"0.3×0.8×0.3",color:"(0.6,0.35,0.1)",firstSeen:3,label:"木材",role:"interactive",interactionType:"pickup"},
    {name:"WoodHouse",shape:"Cube",scale:"3×2.5×3",color:"(0.85,0.7,0.4)",firstSeen:3,label:"木屋",role:"interactive",interactionType:"proximity"},
    {name:"Worker",shape:"Cube",scale:"0.8×1.5×0.8",color:"(0.9,0.6,0.2)",firstSeen:4,label:"工人",role:"interactive",interactionType:"auto"},
    {name:"GoldCoin",shape:"Sphere",scale:"0.3×0.3×0.3",color:"(1,0.85,0)",firstSeen:1,label:"金币",role:"interactive",interactionType:"pickup"},
    {name:"Arrow",shape:"Cylinder",scale:"0.05×0.5×0.05",color:"(0.6,0.35,0.1)",firstSeen:2,label:"箭矢",role:"decoration",interactionType:"none"},
    {name:"Turret",shape:"Cube",scale:"1.5×2×1.5",color:"(0.5,0.5,0.55)",firstSeen:6,label:"炮塔",role:"interactive",interactionType:"click"},
    {name:"Boss",shape:"Cube",scale:"1.5×3×1.5",color:"(0.7,0.1,0.1)",firstSeen:8,label:"Boss",role:"enemy",interactionType:"auto"},
    {name:"CastleWall",shape:"Cube",scale:"5×4×0.5",color:"(0.7,0.7,0.75)",firstSeen:9,label:"城墙",role:"decoration",interactionType:"none"},
    {name:"HealthBar",shape:"UI",scale:"1×0.1×0.1",color:"(0.1,0.8,0.1)",firstSeen:2,label:"血条",role:"ui",interactionType:"none"}
  ],
  globalParams: `# === 玩家参数 ===
player.moveSpeed = 5        # 移动速度
player.startGold = 1        # 初始金币

# === 传送带 ===
conveyor.buildCost = 1      # 建造花费金币
conveyor.buildTime = 1.5    # 建造时间(秒)

# === 弩炮 ===
crossbow.fireRate = 1.5     # 射击间隔(秒)
crossbow.arrowSpeed = 12    # 箭矢飞行速度
crossbow.damage = 1         # 伤害值

# === 敌人 ===
enemy.moveSpeed = 2         # 移动速度
enemy.hp = 3                # 生命值
enemy.spawnInterval = 3     # 生成间隔(秒)

# === Boss ===
boss.hp = 20                # Boss生命值
boss.moveSpeed = 1.5        # Boss移动速度

# === 经济 ===
economy.killReward = 1      # 击杀奖励金币
economy.woodValue = 1       # 木材价值

# === 建筑 ===
building.woodHouseCost = 3  # 木屋建造花费
building.turretCost = 5     # 炮塔建造花费
building.upgradeCost = 10   # 升级花费`,
  globalSettings: {
    gameType: "slg",
    cameraMode: "topDown45",
    cameraProjection: "orthographic",
    cameraFOV: 60,
    defaultInput: "virtualJoystick"
  }
};

fs.writeFileSync('/tmp/full-bp.json', JSON.stringify(fullBp), 'utf-8');
console.log('Full blueprint: ' + fullBp.nodes.length + ' nodes, ' + fullBp.objectRegistry.length + ' objects');
