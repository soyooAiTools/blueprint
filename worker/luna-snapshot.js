/**
 * Luna Snapshot Engine v1 — Unity 场景快照序列化
 * 
 * 对标 agent-browser 的 snapshot 命令，但专为 Canvas/Unity 设计。
 * 将 Unity 场景树序列化为结构化 JSON，供 AI 决策循环使用。
 * 
 * 依赖: window.__playcheck (playcheck-dom-input.js)
 * 暴露: window.__lunaSnapshot
 * 
 * 注意: 纯 ES5 语法，兼容 Luna 运行时
 */
(function () {
  'use strict';

  var _refMap = {};       // name → ref (u1, u2...)
  var _refCounter = 0;
  var _prevState = null;
  var _prevObjectCount = 0;

  // ==================== Ref 系统 ====================

  function getRef(name) {
    if (!_refMap[name]) {
      _refCounter++;
      _refMap[name] = 'u' + _refCounter;
    }
    return _refMap[name];
  }

  function refToName(ref) {
    for (var name in _refMap) {
      if (_refMap[name] === ref) return name;
    }
    return null;
  }

  // ==================== 场景扫描 ====================

  function scanObjects(options) {
    options = options || {};
    var maxCount = options.maxObjects || 60;
    var results = [];
    var seen = {}; // 去重

    try {
      var cam = (typeof UnityEngine !== 'undefined' && UnityEngine.Camera) ? UnityEngine.Camera.main : null;

      // ─── 1. 扫 Renderer（所有可见对象） ───
      try {
        var rendType = UnityEngine.Renderer;
        if (rendType) {
          var rends = UnityEngine.Object.FindObjectsOfType$1
            ? UnityEngine.Object.FindObjectsOfType$1(rendType)
            : null;
          if (rends) {
            for (var ri = 0; ri < Math.min(rends.length, maxCount); ri++) {
              var r = rends[ri];
              if (!r || !r.gameObject || !r.gameObject.transform) continue;
              var rgo = r.gameObject;
              var rname = rgo.name || ('renderer_' + ri);
              if (seen[rname]) continue;
              seen[rname] = true;
              addObject(results, rgo, rname, cam, 'visible');
            }
          }
        }
      } catch (e) { /* Renderer 扫描失败 */ }

      // ─── 2. 扫 Collider（所有可交互对象） ───
      var colTypes = ['BoxCollider', 'SphereCollider', 'CapsuleCollider', 'BoxCollider2D', 'CircleCollider2D'];
      for (var ci = 0; ci < colTypes.length; ci++) {
        try {
          var colType = UnityEngine[colTypes[ci]];
          if (!colType) continue;
          var cols = UnityEngine.Object.FindObjectsOfType$1(colType);
          if (!cols) continue;
          for (var cj = 0; cj < Math.min(cols.length, 30); cj++) {
            var col = cols[cj];
            if (!col || !col.gameObject || !col.gameObject.transform) continue;
            var cgo = col.gameObject;
            var cname = cgo.name || ('collider_' + cj);
            if (seen[cname]) continue;
            seen[cname] = true;
            addObject(results, cgo, cname, cam, 'interactive');
          }
        } catch (e) { /* 该 Collider 类型不存在 */ }
      }

      // ─── 3. 扫根节点的关键子对象（Player, Enemy 等） ───
      try {
        var allGO = UnityEngine.Object.FindObjectsOfType$1
          ? UnityEngine.Object.FindObjectsOfType$1(UnityEngine.GameObject)
          : null;
        if (allGO) {
          for (var gi = 0; gi < Math.min(allGO.length, 20); gi++) {
            var go = allGO[gi];
            if (!go || !go.transform) continue;
            var t = go.transform;
            // 递归扫描子节点（最多 2 层）
            for (var k = 0; k < Math.min(t.childCount, 15); k++) {
              try {
                var child = t.GetChild(k);
                if (!child || !child.gameObject) continue;
                var childName = child.gameObject.name;
                if (seen[childName]) continue;
                // 只保留有意义的子对象（跳过纯容器）
                var childType = inferType(childName);
                if (childType === 'character' || childType === 'npc' || childType === 'ui' ||
                    childType === 'collectible' || childType === 'effect' ||
                    childName.indexOf('Enemy') >= 0 || childName.indexOf('Weapon') >= 0 ||
                    childName.indexOf('武器') >= 0 || childName.indexOf('解锁') >= 0 ||
                    childName.indexOf('引导') >= 0 || childName.indexOf('door') >= 0 ||
                    childName.indexOf('门') >= 0) {
                  seen[childName] = true;
                  addObject(results, child.gameObject, childName, cam, childType);
                }
              } catch (e) { /* 子对象访问失败 */ }
            }
          }
        }
      } catch (e) { /* 子节点扫描失败 */ }

    } catch (e) {
      results.push({ error: 'scanObjects failed: ' + e.message });
    }

    // ─── 过滤 + 排序 ───
    var filtered = [];
    for (var fi = 0; fi < results.length; fi++) {
      var obj = results[fi];
      if (obj.domPosition) {
        // 有屏幕坐标：关键/分镜对象保留，装饰物也保留（后面 compact 时汇总）
        filtered.push(obj);
      } else {
        // offscreen：只保留关键和分镜对象
        if (obj.importance === 'key' || obj.importance === 'storyboard') {
          filtered.push(obj);
        }
      }
    }

    // 排序优先级：key > storyboard > decoration，有坐标 > 无坐标
    var importanceScore = { key: 20, storyboard: 15, decoration: 0 };
    filtered.sort(function(a, b) {
      var aScore = (a.domPosition ? 100 : 0) + (a.active ? 10 : 0) + (importanceScore[a.importance] || 0);
      var bScore = (b.domPosition ? 100 : 0) + (b.active ? 10 : 0) + (importanceScore[b.importance] || 0);
      return bScore - aScore;
    });

    return filtered.slice(0, maxCount);
  }

  // ==================== 组件级重要性判断 ====================

  /**
   * 三层判断体系：
   * 1. 组件层（通用）— Collider/Animator/Button/EventTrigger = 可交互
   * 2. 分镜层（项目级）— 分镜文件中提到的元素 = 必须关注
   *    → 通过 __lunaSnapshot.setStoryboardNames(names) 注入
   * 3. 名字兜底（弱信号）— 关键词匹配
   */

  var _storyboardNames = null; // 分镜元素名称集合

  function checkComponents(go) {
    var flags = { hasCollider: false, hasAnimator: false, hasUI: false };
    try {
      // Collider（3D + 2D）
      var col3d = go.GetComponent$1 ? go.GetComponent$1(UnityEngine.Collider) : null;
      if (col3d) flags.hasCollider = true;
      if (!flags.hasCollider) {
        var col2d = go.GetComponent$1 ? go.GetComponent$1(UnityEngine.Collider2D) : null;
        if (col2d) flags.hasCollider = true;
      }
    } catch (e) {}
    try {
      // Animator
      var anim = go.GetComponent$1 ? go.GetComponent$1(UnityEngine.Animator) : null;
      if (anim) flags.hasAnimator = true;
      // Animation（旧动画系统）
      if (!flags.hasAnimator) {
        var animLegacy = go.GetComponent$1 ? go.GetComponent$1(UnityEngine.Animation) : null;
        if (animLegacy) flags.hasAnimator = true;
      }
    } catch (e) {}
    try {
      // UI 组件
      if (UnityEngine.UI) {
        var btn = go.GetComponent$1 ? go.GetComponent$1(UnityEngine.UI.Button) : null;
        if (btn) flags.hasUI = true;
      }
    } catch (e) {}
    return flags;
  }

  /**
   * 综合判断对象重要性
   * @returns {string} 'key' | 'storyboard' | 'decoration'
   */
  function classifyImportance(go, name, componentFlags) {
    // 第 1 层：组件判断（最可靠）
    if (componentFlags.hasCollider) return 'key';
    if (componentFlags.hasAnimator) return 'key';
    if (componentFlags.hasUI) return 'key';

    // 第 2 层：分镜元素匹配
    if (_storyboardNames) {
      var lname = name.toLowerCase();
      for (var si = 0; si < _storyboardNames.length; si++) {
        if (lname.indexOf(_storyboardNames[si]) >= 0) return 'storyboard';
      }
    }

    // 第 3 层：名字关键词兜底
    var n = name.toLowerCase();
    var keywords = [
      'player', 'enemy', 'hero', 'boss', 'npc', 'character',
      'button', 'btn', 'playnow', 'coin', 'item', 'reward',
      'trigger', 'checkpoint', 'spawn', 'clone',
      '解锁', '武器', '门', '引导', '金币', '升级', '箱子',
      '障碍', '敌人', '玩家', '角色', '服务器', '宝箱'
    ];
    for (var ki = 0; ki < keywords.length; ki++) {
      if (n.indexOf(keywords[ki]) >= 0) return 'key';
    }

    return 'decoration';
  }

  function addObject(results, go, name, cam, tag) {
    var pos = go.transform.position;
    var domPos = null;

    try {
      if (cam && pos) {
        var sp = cam.WorldToScreenPoint$1(pos);
        if (sp && sp.z > 0 && sp.x >= 0 && sp.x <= 800 && sp.y >= 0 && sp.y <= 600) {
          domPos = { x: Math.round(sp.x), y: Math.round(600 - sp.y) };
        }
      }
    } catch (e) { /* 坐标转换失败 */ }

    if (!domPos) {
      try {
        if (window.__playcheck && window.__playcheck.worldToDOM) {
          var wd = window.__playcheck.worldToDOM(pos.x, pos.y, pos.z);
          if (wd && wd.clientX >= 0 && wd.clientX <= 800 && wd.clientY >= 0 && wd.clientY <= 600) {
            domPos = { x: Math.round(wd.clientX), y: Math.round(wd.clientY) };
          }
        }
      } catch (e) {}
    }

    // 组件检查
    var compFlags = checkComponents(go);
    var importance = classifyImportance(go, name, compFlags);

    // 覆盖 tag：如果 Collider 扫描已经标了 interactive，保持
    if (tag === 'interactive') importance = 'key';

    results.push({
      name: name,
      ref: getRef(name),
      active: go.activeSelf !== false,
      position: { x: pos.x, y: pos.y, z: pos.z },
      domPosition: domPos,
      type: tag || inferType(name),
      importance: importance,
      childCount: go.transform.childCount || 0,
      components: compFlags
    });
  }

  function inferType(name) {
    var n = name.toLowerCase();
    if (n.indexOf('button') >= 0 || n.indexOf('btn') >= 0) return 'ui';
    if (n.indexOf('canvas') >= 0 || n.indexOf('panel') >= 0 || n.indexOf('popup') >= 0) return 'ui-container';
    if (n.indexOf('text') >= 0 || n.indexOf('label') >= 0 || n.indexOf('txt') >= 0) return 'ui-text';
    if (n.indexOf('player') >= 0 || n.indexOf('hero') >= 0 || n.indexOf('character') >= 0) return 'character';
    if (n.indexOf('enemy') >= 0 || n.indexOf('monster') >= 0 || n.indexOf('boss') >= 0) return 'npc';
    if (n.indexOf('item') >= 0 || n.indexOf('coin') >= 0 || n.indexOf('gem') >= 0 || n.indexOf('reward') >= 0) return 'collectible';
    if (n.indexOf('camera') >= 0) return 'camera';
    if (n.indexOf('light') >= 0) return 'light';
    if (n.indexOf('particle') >= 0 || n.indexOf('effect') >= 0 || n.indexOf('fx') >= 0) return 'effect';
    if (n.indexOf('ground') >= 0 || n.indexOf('floor') >= 0 || n.indexOf('wall') >= 0 || n.indexOf('terrain') >= 0) return 'environment';
    return 'object';
  }

  // ==================== UI 坐标转换 ====================

  /**
   * 将 UI 元素的 position 转为 DOM 屏幕坐标
   * Screen Space UI 的 position 直接就是像素坐标（Y 轴从底部算起）
   * World Space UI 则需要 Camera.WorldToScreenPoint 转换
   */
  function uiPositionToScreen(worldPos, gameObject) {
    try {
      var x = worldPos.x;
      var y = worldPos.y;
      var canvasHeight = 600; // viewport height

      // 判断是否在 Screen Space 模式：
      // Screen Space UI 的 position.x/y 通常在 0~800/0~600 范围内
      // World Space 的坐标则可能很大或很小
      var looksLikeScreenSpace = (x >= 0 && x <= 800 && y >= 0 && y <= 600);

      if (looksLikeScreenSpace) {
        // Screen Space: position 就是像素坐标，Y 轴需要翻转
        var screenX = Math.round(x);
        var screenY = Math.round(canvasHeight - y);
        if (screenX >= 0 && screenX <= 800 && screenY >= 0 && screenY <= 600) {
          return { x: screenX, y: screenY };
        }
      }

      // 尝试 worldToDOM（适用于 World Space UI）
      if (window.__playcheck && window.__playcheck.worldToDOM) {
        var dom = window.__playcheck.worldToDOM(x, y, worldPos.z || 0);
        if (dom && dom.clientX >= 0 && dom.clientX <= 800 && dom.clientY >= 0 && dom.clientY <= 600) {
          return { x: Math.round(dom.clientX), y: Math.round(dom.clientY) };
        }
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  // ==================== UI 扫描 ====================

  function scanUI() {
    var ui = { texts: [], buttons: [] };

    // 扫描 Text 组件
    try {
      var textType = null;
      if (typeof UnityEngine !== 'undefined' && UnityEngine.UI) {
        textType = UnityEngine.UI.Text;
      }
      if (textType) {
        var texts = UnityEngine.Object.FindObjectsOfType$1
          ? UnityEngine.Object.FindObjectsOfType$1(textType)
          : UnityEngine.Object.FindObjectsOfType(textType);
        if (texts) {
          for (var i = 0; i < Math.min(texts.length || 0, 20); i++) {
            var t = texts[i];
            if (t && t.text) {
              var textContent = String(t.text);
              if (textContent.length > 0 && textContent.length < 100) {
                var textEntry = {
                  name: t.gameObject ? t.gameObject.name : 'unknown',
                  text: textContent.substring(0, 50)
                };
                // 计算 UI 元素的屏幕坐标（UI 可能在 Screen Space 模式）
                try {
                  if (t.gameObject && t.gameObject.transform) {
                    var tp = t.gameObject.transform.position;
                    var resolved = uiPositionToScreen(tp, t.gameObject);
                    if (resolved) {
                      textEntry.screenX = resolved.x;
                      textEntry.screenY = resolved.y;
                    }
                  }
                } catch (e) { /* 忽略 */ }
                ui.texts.push(textEntry);
              }
            }
          }
        }
      }
    } catch (e) {
      // UI.Text 可能不存在
    }

    // 扫描 Button 组件
    try {
      var btnType = null;
      if (typeof UnityEngine !== 'undefined' && UnityEngine.UI) {
        btnType = UnityEngine.UI.Button;
      }
      if (btnType) {
        var buttons = UnityEngine.Object.FindObjectsOfType$1
          ? UnityEngine.Object.FindObjectsOfType$1(btnType)
          : UnityEngine.Object.FindObjectsOfType(btnType);
        if (buttons) {
          for (var j = 0; j < Math.min(buttons.length || 0, 10); j++) {
            var b = buttons[j];
            if (b && b.gameObject) {
              var btnEntry = {
                name: b.gameObject.name,
                ref: getRef(b.gameObject.name),
                interactable: b.interactable !== false,
                active: b.gameObject.activeSelf !== false
              };
              // 计算按钮的屏幕坐标（UI 元素可能在 Screen Space 模式）
              try {
                if (b.gameObject.transform) {
                  var bp = b.gameObject.transform.position;
                  var resolved = uiPositionToScreen(bp, b.gameObject);
                  if (resolved) {
                    btnEntry.screenX = resolved.x;
                    btnEntry.screenY = resolved.y;
                  }
                }
              } catch (e) { /* 忽略 */ }
              ui.buttons.push(btnEntry);
            }
          }
        }
      }
    } catch (e) {
      // UI.Button 可能不存在
    }

    return ui;
  }

  // ==================== FPS 计算（基于真实帧间隔） ====================

  var _lastFrameTime = 0;
  var _fpsHistory = [];
  var _fpsTimerStarted = false;

  /**
   * 启动 FPS 追踪（用 requestAnimationFrame 计算真实帧间隔）
   * Time.deltaTime 在 headless/Luna 下可能是固定步长（如 0.1），不反映真实帧率
   */
  function startFpsTracker() {
    if (_fpsTimerStarted) return;
    _fpsTimerStarted = true;
    _lastFrameTime = performance.now();

    function tick() {
      var now = performance.now();
      var dt = now - _lastFrameTime;
      _lastFrameTime = now;
      if (dt > 0 && dt < 1000) {
        _fpsHistory.push(1000 / dt);
        if (_fpsHistory.length > 30) _fpsHistory.shift();
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function getRealtimeFps() {
    if (_fpsHistory.length === 0) return -1;
    var sum = 0;
    for (var i = 0; i < _fpsHistory.length; i++) sum += _fpsHistory[i];
    return Math.round(sum / _fpsHistory.length);
  }

  // ==================== 健康检查 ====================

  function checkHealth() {
    var health = { fps: -1, unityDeltaTime: -1, objectCount: 0, errors: [] };

    // 启动 FPS 追踪器
    startFpsTracker();

    // 真实 FPS（基于 requestAnimationFrame）
    health.fps = getRealtimeFps();

    // Unity 的 deltaTime（可能是固定步长，仅供参考）
    try {
      if (typeof UnityEngine !== 'undefined' && UnityEngine.Time) {
        health.unityDeltaTime = UnityEngine.Time.deltaTime;
      }
    } catch (e) { /* 忽略 */ }

    // FPS 不作为 bug 检测项（headless 和真机差异太大，无参考价值）

    try {
      var allGO = null;
      if (typeof UnityEngine !== 'undefined' && UnityEngine.Object) {
        allGO = UnityEngine.Object.FindObjectsOfType$1
          ? UnityEngine.Object.FindObjectsOfType$1(UnityEngine.GameObject)
          : null;
      }
      health.objectCount = allGO ? allGO.length : 0;

      // 对象暴涨检测
      if (_prevObjectCount > 0 && health.objectCount > _prevObjectCount * 2) {
        health.errors.push('object_surge:' + _prevObjectCount + '->' + health.objectCount);
      }
      _prevObjectCount = health.objectCount;
    } catch (e) { /* 忽略 */ }

    return health;
  }

  // ==================== Diff 计算 ====================

  function computeDiff(prev, curr) {
    var diff = { moved: [], appeared: [], disappeared: [], stateChanged: [] };
    if (!prev || !prev.objects || !curr || !curr.objects) return diff;

    var prevMap = {};
    for (var i = 0; i < prev.objects.length; i++) {
      var o = prev.objects[i];
      if (o.name) prevMap[o.name] = o;
    }

    var currMap = {};
    for (var j = 0; j < curr.objects.length; j++) {
      var c = curr.objects[j];
      if (c.name) currMap[c.name] = c;
    }

    // 检查当前对象
    for (var name in currMap) {
      var currObj = currMap[name];
      var prevObj = prevMap[name];
      if (!prevObj) {
        diff.appeared.push(name);
      } else {
        // 位移检测
        if (currObj.position && prevObj.position) {
          var dx = currObj.position.x - prevObj.position.x;
          var dy = currObj.position.y - prevObj.position.y;
          var dz = currObj.position.z - prevObj.position.z;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) > 0.1) {
            diff.moved.push(name);
          }
        }
        // 激活状态变化
        if (currObj.active !== prevObj.active) {
          diff.stateChanged.push(name);
        }
      }
    }

    // 检查消失的对象
    for (var pname in prevMap) {
      if (!currMap[pname]) {
        diff.disappeared.push(pname);
      }
    }

    // UI 文本变化
    var prevTexts = {};
    if (prev.ui && prev.ui.texts) {
      for (var ti = 0; ti < prev.ui.texts.length; ti++) {
        prevTexts[prev.ui.texts[ti].name] = prev.ui.texts[ti].text;
      }
    }
    if (curr.ui && curr.ui.texts) {
      for (var tj = 0; tj < curr.ui.texts.length; tj++) {
        var ct = curr.ui.texts[tj];
        if (prevTexts[ct.name] !== undefined && prevTexts[ct.name] !== ct.text) {
          diff.stateChanged.push(ct.name);
        }
      }
    }

    return diff;
  }

  // ==================== 快照 API ====================

  function snapshot(options) {
    var objects = scanObjects(options);
    var ui = scanUI();
    var camera = null;
    try {
      if (window.__playcheck && window.__playcheck.getCameraInfo) {
        camera = window.__playcheck.getCameraInfo();
      }
    } catch (e) { /* 忽略 */ }
    var health = checkHealth();

    var state = {
      timestamp: Date.now(),
      camera: camera,
      objects: objects,
      ui: ui,
      health: health,
      diff: null
    };

    // 计算 diff
    if (_prevState) {
      state.diff = computeDiff(_prevState, state);
    }
    _prevState = state;

    return state;
  }

  /**
   * Compact 快照 — 给 LLM 的精简格式
   * 约 200-500 字符，极省 token
   * 
   * 格式: u1:Player(3.1,0.0) u2:Enemy(5.0,1.2) | Score="0" Timer="30" | fps=58 | moved=[Player] appeared=[] disappeared=[]
   */
  function compactSnapshot() {
    var s = snapshot();

    // 对象列表 — 分为「可交互/关键」和「装饰」两部分
    // 关键对象完整列出带坐标，装饰物只统计数量
    var objParts = [];
    var decoCount = 0;

    for (var i = 0; i < s.objects.length; i++) {
      var o = s.objects[i];
      if (o.error) continue;
      if (o.type === 'light' || o.type === 'camera') continue;

      var oname = (o.name || '').toLowerCase();
      var activeFlag = o.active ? '' : '[off]';

      // 用组件级 importance 判断
      var isKey = (o.importance === 'key' || o.importance === 'storyboard');

      if (isKey) {
        var posStr;
        if (o.domPosition) {
          posStr = '@(' + o.domPosition.x + ',' + o.domPosition.y + ')';
        } else {
          posStr = '[offscreen]';
        }
        objParts.push(o.ref + ':' + o.name + posStr + activeFlag);
      } else {
        decoCount++;
      }
    }

    // 同名对象聚合（如 5 个 Enemy(Clone) → Enemy(Clone)x5）
    var nameCounts = {};
    var dedupParts = [];
    for (var di = 0; di < objParts.length; di++) {
      // 提取基础名（去掉 (1) (2) 等编号）
      var part = objParts[di];
      var baseName = part.replace(/\s*\(\d+\)/g, '').replace(/@\(\d+,\d+\)/, '');
      if (!nameCounts[baseName]) {
        nameCounts[baseName] = { first: part, count: 1 };
      } else {
        nameCounts[baseName].count++;
      }
    }
    for (var bn in nameCounts) {
      var nc = nameCounts[bn];
      if (nc.count > 1) {
        dedupParts.push(nc.first + '(x' + nc.count + ')');
      } else {
        dedupParts.push(nc.first);
      }
    }
    objParts = dedupParts;

    if (decoCount > 0) {
      objParts.push('(+' + decoCount + '个装饰/场景物体)');
    }

    // UI 文本（带屏幕坐标）
    var uiParts = [];
    if (s.ui && s.ui.texts) {
      for (var j = 0; j < s.ui.texts.length; j++) {
        var t = s.ui.texts[j];
        var tPos = (t.screenX !== undefined) ? '@(' + t.screenX + ',' + t.screenY + ')' : '';
        uiParts.push(t.name + tPos + '="' + t.text + '"');
      }
    }

    // UI 按钮（带屏幕坐标）
    if (s.ui && s.ui.buttons) {
      for (var k = 0; k < s.ui.buttons.length; k++) {
        var b = s.ui.buttons[k];
        var btnState = b.active ? (b.interactable ? '' : '[disabled]') : '[hidden]';
        var bPos = (b.screenX !== undefined) ? '@(' + b.screenX + ',' + b.screenY + ')' : '';
        uiParts.push(b.ref + ':' + b.name + bPos + btnState);
      }
    }

    // Diff
    var diffStr = '(first frame)';
    if (s.diff) {
      var parts = [];
      if (s.diff.moved.length > 0) parts.push('moved=[' + s.diff.moved.join(',') + ']');
      if (s.diff.appeared.length > 0) parts.push('appeared=[' + s.diff.appeared.join(',') + ']');
      if (s.diff.disappeared.length > 0) parts.push('disappeared=[' + s.diff.disappeared.join(',') + ']');
      if (s.diff.stateChanged.length > 0) parts.push('changed=[' + s.diff.stateChanged.join(',') + ']');
      diffStr = parts.length > 0 ? parts.join(' ') : 'no changes';
    }

    return {
      objects: objParts.join(' '),
      ui: uiParts.join(' '),
      fps: s.health.fps,
      objectCount: s.health.objectCount,
      errors: s.health.errors,
      diff: diffStr,
      // 保留原始数据供规则引擎用
      _raw: s
    };
  }

  // ==================== 暴露 API ====================

  window.__lunaSnapshot = {
    snapshot: snapshot,
    compactSnapshot: compactSnapshot,
    scanObjects: scanObjects,
    scanUI: scanUI,
    checkHealth: checkHealth,
    getRef: getRef,
    refToName: refToName,
    /**
     * 注入分镜元素名称（第 2 层判断）
     * @param {string[]} names - 分镜中提到的对象名（小写）
     * 例: setStoryboardNames(['spaceship', '太空舱', 'turret', 'alien'])
     */
    setStoryboardNames: function(names) {
      _storyboardNames = names || null;
    },
    getStoryboardNames: function() {
      return _storyboardNames;
    },
    version: '1.1.0'
  };

  console.log('[LunaSnapshot] v1.0.0 loaded');
})();
