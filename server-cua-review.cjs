/**
 * CUA Review Integration for Blueprint Server
 * 
 * Triggered after build upload (status → reviewing).
 * Runs GPT-5.4 CUA to interact with the playable ad,
 * then Gemini video review for visual QC.
 * 
 * If issues found → auto-submit feedback → worker re-codes.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LUNA_AGENT_DIR = '/opt/playcheck';
const LUNA_AGENT_JS = path.join(LUNA_AGENT_DIR, 'luna-agent.js');
const CUA_RESULTS_DIR = '/opt/blueprint-editor/server-data/cua-reviews';
const MAX_AUTO_RETRIES = 3; // Max auto-feedback loops before requiring human review
const CUA_PASS_THRESHOLD = 70; // Score >= 70 = pass

// Ensure results dir exists
try { fs.mkdirSync(CUA_RESULTS_DIR, { recursive: true }); } catch(e) {}

/**
 * Trigger CUA review for a project after build completion.
 * Runs asynchronously — does NOT block the upload response.
 * 
 * @param {object} project - Project data with id, blueprint, webglPath
 * @param {function} readProject - Function to read project by id
 * @param {function} writeProject - Function to write project data
 */
function triggerCUAReview(project, readProject, writeProject) {
  const taskId = project.id;
  const previewUrl = 'https://playcools.top' + project.webglPath;

  // Check retry count
  const retryFile = path.join(CUA_RESULTS_DIR, taskId + '-retries.json');
  let retries = 0;
  try {
    retries = JSON.parse(fs.readFileSync(retryFile, 'utf-8')).count || 0;
  } catch(e) {}

  if (retries >= MAX_AUTO_RETRIES) {
    console.log('[CUA Review] Max auto-retries (' + MAX_AUTO_RETRIES + ') reached for ' + taskId + ', skipping CUA — needs human review');
    return;
  }

  // Check if luna-agent.js exists
  if (!fs.existsSync(LUNA_AGENT_JS)) {
    console.log('[CUA Review] luna-agent.js not found at ' + LUNA_AGENT_JS + ', skipping CUA review');
    return;
  }

  // Generate script file from blueprint shots for CUA to follow
  let scriptContent = '';
  if (project.blueprint && project.blueprint.nodes) {
    scriptContent = project.blueprint.nodes
      .filter(n => n.type === 'shotNode')
      .map((n, i) => (i + 1) + '. ' + (n.data.name || n.data.label || 'Shot ' + (i + 1)))
      .join('\n');
  }

  const scriptPath = path.join(CUA_RESULTS_DIR, taskId + '-script.txt');
  const outputPath = path.join(CUA_RESULTS_DIR, taskId + '-report.json');
  const logPath = path.join(CUA_RESULTS_DIR, taskId + '-cua.log');

  if (scriptContent) {
    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
  }

  console.log('[CUA Review] Starting CUA review for ' + taskId);
  console.log('[CUA Review] URL: ' + previewUrl);
  console.log('[CUA Review] Retry: ' + retries + '/' + MAX_AUTO_RETRIES);

  // Build command args
  const args = [
    LUNA_AGENT_JS,
    previewUrl,
    '--model', 'cua',
    '--rounds', '15',
    '--output', outputPath,
    '--background',
    '--log-file', logPath
  ];

  if (scriptContent) {
    args.push('--script', scriptPath);
  }

  // Spawn luna-agent.js as background process
  const child = spawn('node', args, {
    cwd: LUNA_AGENT_DIR,
    env: {
      ...process.env,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  child.on('close', (code) => {
    console.log('[CUA Review] luna-agent exited with code ' + code + ' for ' + taskId);

    // Read the report
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    } catch(e) {
      console.log('[CUA Review] Failed to read report: ' + e.message);
    }

    if (!report) {
      console.log('[CUA Review] No report generated, keeping status as reviewing');
      return;
    }

    // Evaluate results
    const score = report.score || report.overallScore || 0;
    const issues = [];

    // Collect CUA issues
    if (report.bugs && report.bugs.length > 0) {
      report.bugs.forEach(bug => {
        issues.push('[CUA操控] ' + (bug.description || bug.message || JSON.stringify(bug)));
      });
    }

    // Collect Gemini visual issues
    if (report.geminiReview && report.geminiReview.issues) {
      report.geminiReview.issues.forEach(issue => {
        issues.push('[视觉审核] ' + (issue.description || issue.message || JSON.stringify(issue)));
      });
    }

    // Collect anomaly issues
    if (report.anomalies && report.anomalies.length > 0) {
      report.anomalies
        .filter(a => a.severity === 'error' || a.severity === 'critical')
        .forEach(a => {
          issues.push('[异常检测] ' + (a.description || a.rule || JSON.stringify(a)));
        });
    }

    // CTA check
    if (report.ctaStatus === 'not_found' || report.ctaStatus === 'no_response') {
      issues.push('[CTA] CTA按钮未找到或无响应 — 这是阻断级问题');
    }

    // Script coverage check
    if (report.scriptCoverage) {
      const uncovered = report.scriptCoverage.filter(s => !s.covered);
      if (uncovered.length > 0) {
        issues.push('[分镜覆盖] 以下分镜未被覆盖: ' + uncovered.map(s => s.step).join(', '));
      }
    }

    const passed = score >= CUA_PASS_THRESHOLD && issues.length === 0;

    console.log('[CUA Review] Score: ' + score + ', Issues: ' + issues.length + ', Pass: ' + passed);

    // Re-read project (may have changed)
    const latestProject = readProject(taskId);
    if (!latestProject) {
      console.log('[CUA Review] Project not found: ' + taskId);
      return;
    }

    // Only act if project is still in reviewing state
    if (latestProject.status !== 'reviewing') {
      console.log('[CUA Review] Project status changed to ' + latestProject.status + ', skipping auto-feedback');
      return;
    }

    if (passed) {
      console.log('[CUA Review] ✅ PASSED — project stays in reviewing for human confirmation');
      latestProject.statusMessage = 'AI CUA验证通过 (score: ' + score + ')，等待人工确认';
      latestProject.cuaReview = { score, passed: true, timestamp: new Date().toISOString() };
      writeProject(latestProject);
    } else {
      console.log('[CUA Review] ❌ FAILED — auto-submitting feedback');

      // Update retry count
      fs.writeFileSync(retryFile, JSON.stringify({ count: retries + 1, lastAttempt: new Date().toISOString() }), 'utf-8');

      // Build feedback text from issues
      const feedbackText = 'AI CUA自动验证不通过 (score: ' + score + '/' + CUA_PASS_THRESHOLD + '):\n' + issues.join('\n');

      // Add to project feedback history
      if (!latestProject.feedbackHistory) latestProject.feedbackHistory = [];
      latestProject.feedbackHistory.push({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        data: { text: feedbackText, source: 'cua-auto' },
        status: 'pending'
      });

      // Reset status to trigger re-coding
      latestProject.status = 'submitted';
      latestProject.statusMessage = 'CUA验证不通过，自动重新编码 (retry ' + (retries + 1) + '/' + MAX_AUTO_RETRIES + ')';
      latestProject.cuaReview = { score, passed: false, issues: issues.length, timestamp: new Date().toISOString() };
      latestProject.updatedAt = new Date().toISOString();
      writeProject(latestProject);

      console.log('[CUA Review] Feedback submitted, status reset to submitted for re-coding');
    }
  });

  child.on('error', (err) => {
    console.log('[CUA Review] Failed to start luna-agent: ' + err.message);
  });

  child.unref();
}

/**
 * Reset CUA retry count (call when user manually re-submits)
 */
function resetCUARetries(taskId) {
  const retryFile = path.join(CUA_RESULTS_DIR, taskId + '-retries.json');
  try { fs.unlinkSync(retryFile); } catch(e) {}
}

module.exports = { triggerCUAReview, resetCUARetries, CUA_RESULTS_DIR };
