// generate-architecture.js — Parse C# code to architecture.json + architecture.drawio
// No external deps, no API calls. Runs after AI coding completes.

const fs = require('fs');
const path = require('path');

/**
 * Analyze C# files and produce architecture.json
 * @param {string} clientDir - project root (contains Assets/)
 * @returns {object} architecture data
 */
function analyzeCode(clientDir) {
  var scriptsDir = path.join(clientDir, 'Assets');
  var csFiles = listCs(scriptsDir);
  var scripts = [];
  var dataFlow = [];

  for (var i = 0; i < csFiles.length; i++) {
    var code = fs.readFileSync(csFiles[i], 'utf-8');
    var relPath = path.relative(clientDir, csFiles[i]).replace(/\\/g, '/');
    var className = path.basename(csFiles[i], '.cs');

    // Skip empty stubs (< 20 non-empty lines)
    var nonEmpty = code.split('\n').filter(function(l) { return l.trim().length > 0; }).length;
    if (nonEmpty < 20) continue;

    // Extract base class
    var baseMatch = code.match(/class\s+\w+\s*:\s*([\w.]+)/);
    var baseClass = baseMatch ? baseMatch[1] : 'MonoBehaviour';

    // Extract methods
    var methods = [];
    var methodRegex = /(?:public|private|protected|internal)\s+(?:static\s+)?(?:void|bool|int|float|string|IEnumerator|[\w<>\[\]]+)\s+(\w+)\s*\(/g;
    var m;
    while ((m = methodRegex.exec(code)) !== null) {
      if (methods.indexOf(m[1]) === -1) methods.push(m[1]);
    }

    // Extract fields/references to other classes
    var deps = [];
    for (var j = 0; j < csFiles.length; j++) {
      if (i === j) continue;
      var otherClass = path.basename(csFiles[j], '.cs');
      // Check if this file references the other class
      var refRegex = new RegExp('\\b' + otherClass + '\\b', 'g');
      if (refRegex.test(code)) {
        deps.push(otherClass);
        // Find method calls: OtherClass.Method() or instance.Method()
        var callRegex = new RegExp(otherClass + '\\.([A-Za-z]\\w*)\\s*\\(', 'g');
        var cm2;
        while ((cm2 = callRegex.exec(code)) !== null) {
          dataFlow.push({ from: className, to: otherClass, via: cm2[1] + '()' });
        }
      }
    }

    // Extract responsibilities from comments / method names
    var responsibilities = extractResponsibilities(methods, className);

    scripts.push({
      name: className,
      path: relPath,
      type: baseClass,
      methods: methods.slice(0, 20), // Cap at 20
      dependencies: deps,
      responsibilities: responsibilities,
      lineCount: nonEmpty
    });
  }

  // Deduplicate dataFlow
  var seen = {};
  dataFlow = dataFlow.filter(function(d) {
    var key = d.from + '->' + d.to + ':' + d.via;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });

  return { scripts: scripts, dataFlow: dataFlow, generatedAt: new Date().toISOString() };
}

function extractResponsibilities(methods, className) {
  var resps = [];
  var patterns = {
    '游戏流程控制': /Start|Awake|Update|GameFlow|InitGame|GameEnd/,
    'UI管理': /UI|Panel|Button|Text|Show|Hide|Canvas/,
    '镜头控制': /Camera|Cam|Look|Zoom|Orbit/,
    '玩家控制': /Player|Input|Move|Jump|Attack|Shoot/,
    '动画控制': /Anim|Tween|DOTween|LeanTween|Coroutine/,
    '音效管理': /Audio|Sound|Music|Play.*Sound/,
    '计时器': /Timer|Count|Delay|Wait/,
    '场景切换': /shot_|Scene|Level|Stage|Phase/,
    '碰撞检测': /Collision|Trigger|Raycast|OnTrigger|OnCollision/,
    'AI/NPC': /Enemy|Boss|Npc|AI|Patrol|Chase/
  };
  for (var label in patterns) {
    for (var i = 0; i < methods.length; i++) {
      if (patterns[label].test(methods[i]) || patterns[label].test(className)) {
        resps.push(label);
        break;
      }
    }
  }
  return resps;
}

/**
 * Convert architecture.json to draw.io XML
 */
function toDrawioXml(arch) {
  var scripts = arch.scripts || [];
  var dataFlow = arch.dataFlow || [];

  // Layout: grid arrangement
  var cols = Math.ceil(Math.sqrt(scripts.length));
  var cellW = 240, cellH = 160, padX = 60, padY = 60;
  var nodeMap = {};

  var cells = [];
  cells.push('<mxCell id="0"/>');
  cells.push('<mxCell id="1" parent="0"/>');

  var id = 2;
  for (var i = 0; i < scripts.length; i++) {
    var s = scripts[i];
    var col = i % cols;
    var row = Math.floor(i / cols);
    var x = padX + col * (cellW + padX);
    var y = padY + row * (cellH + padY);
    nodeMap[s.name] = id;

    var label = '<b>' + s.name + '</b>\\n'
      + '(' + s.type + ', ' + s.lineCount + ' lines)\\n'
      + '---\\n'
      + (s.responsibilities.length > 0 ? s.responsibilities.join(', ') : 'general');

    cells.push('<mxCell id="' + id + '" value="' + escXml(label) + '" '
      + 'style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=11;verticalAlign=top;align=center;" '
      + 'vertex="1" parent="1">'
      + '<mxGeometry x="' + x + '" y="' + y + '" width="' + cellW + '" height="' + cellH + '" as="geometry"/>'
      + '</mxCell>');
    id++;
  }

  // Edges from dataFlow
  var edgeSeen = {};
  for (var d = 0; d < dataFlow.length; d++) {
    var src = nodeMap[dataFlow[d].from];
    var tgt = nodeMap[dataFlow[d].to];
    if (!src || !tgt) continue;
    var edgeKey = src + '->' + tgt;
    // Aggregate methods on same edge
    if (edgeSeen[edgeKey]) {
      // Already have this edge, skip (label already set to first method)
      continue;
    }
    edgeSeen[edgeKey] = true;

    var methods = dataFlow.filter(function(df) {
      return df.from === dataFlow[d].from && df.to === dataFlow[d].to;
    }).map(function(df) { return df.via; });
    var edgeLabel = methods.slice(0, 3).join(', ') + (methods.length > 3 ? '...' : '');

    cells.push('<mxCell id="' + id + '" value="' + escXml(edgeLabel) + '" '
      + 'style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;fontSize=9;" '
      + 'edge="1" parent="1" source="' + src + '" target="' + tgt + '">'
      + '<mxGeometry relative="1" as="geometry"/>'
      + '</mxCell>');
    id++;
  }

  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<mxfile host="ai-worker" modified="' + new Date().toISOString() + '" type="device">\n'
    + '  <diagram name="Architecture" id="arch">\n'
    + '    <mxGraphModel dx="1024" dy="768" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="900">\n'
    + '      <root>\n'
    + '        ' + cells.join('\n        ') + '\n'
    + '      </root>\n'
    + '    </mxGraphModel>\n'
    + '  </diagram>\n'
    + '</mxfile>';

  return xml;
}

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function listCs(dir) {
  var results = [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fp = path.join(dir, entries[i].name);
      if (entries[i].isDirectory() && entries[i].name !== 'Editor' && entries[i].name !== '_hidden_') {
        results = results.concat(listCs(fp));
      } else if (entries[i].name.endsWith('.cs')) {
        results.push(fp);
      }
    }
  } catch(e) {}
  return results;
}

/**
 * Main entry: analyze + generate both files
 * @param {string} clientDir - project root
 * @param {function} log - logger
 * @param {string} taskId
 * @returns {{ json: string, drawio: string }} paths to generated files
 */
function generateArchitecture(clientDir, log, taskId) {
  log('[arch] Analyzing code structure...', taskId);
  var arch = analyzeCode(clientDir);
  log('[arch] Found ' + arch.scripts.length + ' scripts, ' + arch.dataFlow.length + ' data flows', taskId);

  var jsonPath = path.join(clientDir, 'architecture.json');
  var drawioPath = path.join(clientDir, 'architecture.drawio');

  fs.writeFileSync(jsonPath, JSON.stringify(arch, null, 2), 'utf-8');
  log('[arch] Written: architecture.json', taskId);

  var xml = toDrawioXml(arch);
  fs.writeFileSync(drawioPath, xml, 'utf-8');
  log('[arch] Written: architecture.drawio', taskId);

  return { json: jsonPath, drawio: drawioPath, data: arch };
}

module.exports = { generateArchitecture, analyzeCode, toDrawioXml };
