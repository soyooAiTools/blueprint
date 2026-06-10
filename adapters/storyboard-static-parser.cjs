'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var AdmZip = require('adm-zip');
var evidenceIr = require('../engine/evidence-ir.cjs');

var IMAGE_EXTS = { png: true, jpg: true, jpeg: true };
var PDF_EXTS = { pdf: true };
var CSV_EXTS = { csv: true };
var EXCEL_EXTS = { xlsx: true, xls: true };
var WORD_EXTS = { docx: true, doc: true };
var MANUAL_EXTS = {
  html: true, htm: true,
  mp4: true, mov: true, webm: true, gif: true, avi: true, mkv: true,
};

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripTags(text) {
  return decodeXml(String(text || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function execFile(command, args, options) {
  return childProcess.execFileSync(command, args, Object.assign({
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  }, options || {}));
}

function sourceTypeForExtension(ext) {
  ext = String(ext || '').toLowerCase();
  if (IMAGE_EXTS[ext]) return 'image';
  if (PDF_EXTS[ext]) return 'pdf';
  if (CSV_EXTS[ext]) return 'csv';
  if (EXCEL_EXTS[ext]) return 'excel';
  if (WORD_EXTS[ext]) return 'word';
  if (MANUAL_EXTS[ext]) return 'manual_required';
  return 'unsupported';
}

function makeSource(filePath, index, status, metadata) {
  var ext = path.extname(filePath).slice(1).toLowerCase();
  var sourceType = sourceTypeForExtension(ext);
  if (sourceType === 'manual_required') status = 'manual_required';
  if (sourceType === 'unsupported') status = status || 'unsupported';
  return {
    sourceId: evidenceIr._internals.safeSourceId(filePath, index),
    path: path.resolve(filePath),
    fileName: path.basename(filePath),
    extension: ext,
    sourceType: sourceType,
    status: status || 'parsed',
    metadata: metadata || {},
  };
}

function fact(source, factType, locator, text, confidence, metadata) {
  return {
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    locator: locator,
    factType: factType,
    text: stringValue(text),
    confidence: confidence,
    metadata: metadata || {},
  };
}

function nonEmptyLines(text) {
  return String(text || '').split(/\r?\n/)
    .map(function(line) { return line.trim(); })
    .filter(Boolean)
    .filter(function(line) { return !/^\f+$/.test(line); });
}

function normalizeStoryboardLines(lines) {
  var input = nonEmptyLines(lines.join ? lines.join('\n') : lines);
  var out = [];
  for (var i = 0; i < input.length; i += 1) {
    var line = input[i];
    var next = input[i + 1] || '';
    if (/^Phas$/i.test(line) && /^e\s*\d+\s*[:：]?/i.test(next)) {
      out.push(next.replace(/^e\s*(\d+)/i, 'Phase$1'));
      i += 1;
      continue;
    }
    if (/^e\s*\d+\s*[:：]?/i.test(line)) {
      out.push(line.replace(/^e\s*(\d+)/i, 'Phase$1'));
      continue;
    }
    if (/^(需求描述|序号\s+文字描述|序号|文字描述|画面|注释)$/.test(line)) continue;
    out.push(line);
  }
  return out;
}

function detectFactType(line, index) {
  var text = stringValue(line);
  if (!text) return 'text';
  if (index === 0 && text.length <= 40) return 'title';
  if (/[-=]>|→|=>|—>|->/.test(text)) return 'core_loop';
  if (/phase\s*\d+|phas\s*e\s*\d+|第\s*\d+\s*(阶段|步|幕)|步骤\s*\d+/i.test(text)) return 'phase_marker';
  return 'text';
}

function addTextFacts(out, source, lines, locatorPrefix, confidence) {
  nonEmptyLines(lines.join ? lines.join('\n') : lines).forEach(function(line, index) {
    out.push(fact(source, detectFactType(line, index), locatorPrefix + ':' + (index + 1), line, confidence));
  });
}

function parsePdf(filePath, source) {
  var facts = [];
  var diagnostics = [];
  var info = {};
  try {
    execFile('pdfinfo', [filePath]).split(/\r?\n/).forEach(function(line) {
      var idx = line.indexOf(':');
      if (idx > 0) info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
  } catch (e) {
    diagnostics.push({ code: 'pdfinfo_failed', severity: 'warning', sourceId: source.sourceId, message: e.message });
  }
  var text = '';
  try {
    text = execFile('pdftotext', ['-layout', filePath, '-']);
  } catch (e2) {
    diagnostics.push({ code: 'pdftotext_failed', severity: 'error', sourceId: source.sourceId, message: e2.message });
  }
  addTextFacts(facts, source, normalizeStoryboardLines(text), 'page-layout-line', 0.82);
  return { facts: facts, diagnostics: diagnostics, metadata: { pages: Number(info.Pages || 0), pdfInfo: info } };
}

function parseCsvLine(line) {
  var cells = [];
  var cell = '';
  var quoted = false;
  for (var i = 0; i < line.length; i += 1) {
    var ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseCsv(filePath, source) {
  var facts = [];
  var text = fs.readFileSync(filePath, 'utf8');
  text.split(/\r?\n/).forEach(function(line, index) {
    var cells = parseCsvLine(line).filter(Boolean);
    if (!cells.length) return;
    var joined = cells.join(' | ');
    facts.push(fact(source, detectFactType(joined, index), 'row:' + (index + 1), joined, 0.86, { cells: cells }));
  });
  return { facts: facts, diagnostics: [], metadata: { rows: facts.length } };
}

function sharedStringsFromZip(zip) {
  var entry = zip.getEntry('xl/sharedStrings.xml');
  if (!entry) return [];
  var xml = zip.readAsText(entry);
  var out = [];
  var matches = xml.match(/<si[\s\S]*?<\/si>/g) || [];
  matches.forEach(function(si) {
    var chunks = [];
    var tMatches = si.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) || [];
    tMatches.forEach(function(t) { chunks.push(stripTags(t)); });
    out.push(chunks.join(''));
  });
  return out;
}

function cellValue(cellXml, sharedStrings) {
  var typeMatch = cellXml.match(/\bt="([^"]+)"/);
  var type = typeMatch ? typeMatch[1] : '';
  if (type === 'inlineStr') {
    var inlineText = (cellXml.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) || []).map(stripTags).join('');
    return inlineText;
  }
  var valueMatch = cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/);
  var raw = valueMatch ? stripTags(valueMatch[1]) : '';
  if (type === 's') return sharedStrings[Number(raw)] || '';
  return raw;
}

function parseXlsx(filePath, source) {
  var zip = new AdmZip(filePath);
  var sharedStrings = sharedStringsFromZip(zip);
  var facts = [];
  zip.getEntries().filter(function(entry) {
    return /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName);
  }).sort(function(a, b) {
    return a.entryName.localeCompare(b.entryName);
  }).forEach(function(entry, sheetIndex) {
    var xml = zip.readAsText(entry);
    var rows = xml.match(/<row\b[\s\S]*?<\/row>/g) || [];
    rows.forEach(function(rowXml, rowIndex) {
      var cells = [];
      var cellMatches = rowXml.match(/<c\b[\s\S]*?<\/c>/g) || [];
      cellMatches.forEach(function(cellXml) {
        var value = cellValue(cellXml, sharedStrings);
        if (value) cells.push(value);
      });
      if (!cells.length) return;
      var joined = cells.join(' | ');
      facts.push(fact(source, detectFactType(joined, rowIndex), 'sheet:' + (sheetIndex + 1) + ':row:' + (rowIndex + 1), joined, 0.82, { cells: cells }));
    });
  });
  return { facts: facts, diagnostics: [], metadata: { rows: facts.length } };
}

function parseDocx(filePath, source) {
  var zip = new AdmZip(filePath);
  var entry = zip.getEntry('word/document.xml');
  if (!entry) return { facts: [], diagnostics: [{ code: 'docx_document_xml_missing', severity: 'error', sourceId: source.sourceId }], metadata: {} };
  var xml = zip.readAsText(entry);
  var paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
  var lines = [];
  paragraphs.forEach(function(p) {
    var text = (p.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g) || []).map(stripTags).join('');
    if (text.trim()) lines.push(text.trim());
  });
  var facts = [];
  addTextFacts(facts, source, lines, 'paragraph', 0.84);
  return { facts: facts, diagnostics: [], metadata: { paragraphs: lines.length } };
}

function parseStringsBacked(filePath, source, kind) {
  var facts = [];
  var diagnostics = [{
    code: kind + '_strings_fallback',
    severity: 'warning',
    sourceId: source.sourceId,
    message: 'Binary ' + kind + ' parsing uses low-confidence strings fallback in v1.',
  }];
  var text = '';
  try {
    text = execFile('strings', ['-n', '3', filePath]);
  } catch (e) {
    diagnostics.push({ code: kind + '_strings_failed', severity: 'error', sourceId: source.sourceId, message: e.message });
  }
  addTextFacts(facts, source, nonEmptyLines(text).slice(0, 220), 'strings-line', 0.42);
  return { facts: facts, diagnostics: diagnostics, metadata: { fallback: 'strings' } };
}

function parseImage(filePath, source) {
  var metadata = {};
  try {
    var parts = execFile('identify', ['-format', '%w %h %m', filePath]).trim().split(/\s+/);
    metadata.width = Number(parts[0] || 0);
    metadata.height = Number(parts[1] || 0);
    metadata.format = parts[2] || source.extension;
  } catch (e) {
    metadata.identifyError = e.message;
  }
  return {
    facts: [fact(source, 'visual_reference', 'image:full', source.fileName, 0.9, {
      imagePath: source.path,
      width: metadata.width || 0,
      height: metadata.height || 0,
      format: metadata.format || source.extension,
    })],
    diagnostics: [],
    metadata: metadata,
  };
}

function parseManualRequired(filePath, source) {
  return {
    facts: [fact(source, 'manual_required', 'file', source.fileName, 1, {
      reason: source.extension === 'html' || source.extension === 'htm'
        ? 'HTML playable/reference requires manual handling in v1.'
        : 'Dynamic media requires manual keyframe/storyboard handling in v1.',
    })],
    diagnostics: [{
      code: 'manual_required_source',
      severity: 'info',
      sourceId: source.sourceId,
      extension: source.extension,
      message: 'This source type is intentionally manual-required in v1.',
    }],
    metadata: {},
  };
}

function parseOne(filePath, index) {
  var abs = path.resolve(filePath);
  var diagnostics = [];
  if (!fs.existsSync(abs)) {
    var missing = makeSource(abs, index, 'error', {});
    return {
      source: missing,
      facts: [],
      diagnostics: [{ code: 'source_file_missing', severity: 'error', sourceId: missing.sourceId, path: abs }],
    };
  }
  var source = makeSource(abs, index, 'parsed', { sizeBytes: fs.statSync(abs).size });
  var parsed;
  try {
    if (source.sourceType === 'manual_required') parsed = parseManualRequired(abs, source);
    else if (source.sourceType === 'unsupported') parsed = {
      facts: [],
      diagnostics: [{ code: 'unsupported_source_type', severity: 'warning', sourceId: source.sourceId, extension: source.extension }],
      metadata: {},
    };
    else if (source.sourceType === 'image') parsed = parseImage(abs, source);
    else if (source.sourceType === 'pdf') parsed = parsePdf(abs, source);
    else if (source.sourceType === 'csv') parsed = parseCsv(abs, source);
    else if (source.extension === 'xlsx') parsed = parseXlsx(abs, source);
    else if (source.extension === 'xls') parsed = parseStringsBacked(abs, source, 'xls');
    else if (source.extension === 'docx') parsed = parseDocx(abs, source);
    else if (source.extension === 'doc') parsed = parseStringsBacked(abs, source, 'doc');
    else parsed = { facts: [], diagnostics: [], metadata: {} };
  } catch (e) {
    source.status = 'error';
    parsed = {
      facts: [],
      diagnostics: [{ code: 'source_parse_failed', severity: 'error', sourceId: source.sourceId, message: e.message }],
      metadata: {},
    };
  }
  if (source.sourceType === 'manual_required') source.status = 'manual_required';
  if (source.sourceType === 'unsupported') source.status = 'unsupported';
  if (parsed && parsed.metadata) source.metadata = Object.assign({}, source.metadata, parsed.metadata);
  diagnostics = diagnostics.concat(parsed.diagnostics || []);
  return { source: source, facts: parsed.facts || [], diagnostics: diagnostics };
}

function parseStaticSources(filePaths, options) {
  options = options || {};
  var sources = [];
  var facts = [];
  var diagnostics = [];
  safeArray(filePaths).forEach(function(filePath, index) {
    var parsed = parseOne(filePath, index);
    sources.push(parsed.source);
    facts = facts.concat(parsed.facts);
    diagnostics = diagnostics.concat(parsed.diagnostics);
  });
  return evidenceIr.normalizeEvidenceIr({
    projectName: options.projectName,
    sources: sources,
    facts: facts,
    diagnostics: diagnostics,
  }, {
    projectName: options.projectName,
  });
}

module.exports = {
  parseStaticSources: parseStaticSources,
  _internals: {
    parseCsvLine: parseCsvLine,
    parseDocx: parseDocx,
    parseXlsx: parseXlsx,
    sourceTypeForExtension: sourceTypeForExtension,
    decodeXml: decodeXml,
    stripTags: stripTags,
    normalizeStoryboardLines: normalizeStoryboardLines,
  },
};
