/**
 * CUA Review Integration for Blueprint Server (PlayableAgent version)
 * 
 * Triggered after build upload (status → reviewing).
 * Runs PlayableAgent (VLM + __gameState) to verify playable ad flow.
 * 
 * If issues found → auto-submit feedback → worker re-codes.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PYTHON = '/usr/bin/python3.8';
const VERIFY_SCRIPT = '/root/cua-agent/blueprint_verify.py';
const CUA_RESULTS_DIR = '/opt/blueprint-editor/server-data/cua-reviews';
const MAX_AUTO_RETRIES = 3;

try { fs.mkdirSync(CUA_RESULTS_DIR, { recursive: true }); } catch(e) {}

/**
 * Trigger PlayableAgent review for a project after build completion.
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
    console.log('[CUA Review] Max auto-retries (' + MAX_AUTO_RETRIES + ') reached for ' + taskId + ', needs human review');
    return;
  }

  if (!fs.existsSync(VERIFY_SCRIPT)) {
    console.log('[CUA Review] blueprint_verify.py not found, skipping review');
    return;
  }

  // Ensure Xvfb
  try {
    require('child_process').execSync('pgrep -f "Xvfb :99" || Xvfb :99 -screen 0 1280x1024x24 -ac &', { shell: true, timeout: 5000 });
  } catch(e) {}

  // Write specs if available
  let specsArg = [];
  if (project.blueprint && project.blueprint.nodes) {
    const phaseNodes = project.blueprint.nodes.filter(n => n.type === 'phaseNode');
    if (phaseNodes.length > 0) {
      const specs = phaseNodes.map((n, i) => ({
        phaseId: (n.data || {}).phaseId || n.id,
        phaseName: (n.data || {}).name || (n.data || {}).phaseId || n.id,
        requiredInteractions: (n.data || {}).requiredInteractions || [],
        triggerNext: (n.data || {}).triggerCondition ? { condition: (n.data || {}).triggerCondition } : {},
        order: i
      }));
      const specsPath = path.join(CUA_RESULTS_DIR, taskId + '-specs.json');
      fs.writeFileSync(specsPath, JSON.stringify(specs, null, 2), 'utf-8');
      specsArg = ['--specs', specsPath];
    }
  }

  console.log('[CUA Review] Starting PlayableAgent review for ' + taskId);
  console.log('[CUA Review] URL: ' + previewUrl);
  console.log('[CUA Review] Retry: ' + retries + '/' + MAX_AUTO_RETRIES);

  const args = [VERIFY_SCRIPT, previewUrl, '--steps', '30', ...specsArg];

  const child = spawn(PYTHON, args, {
    cwd: '/root/cua-agent',
    env: {
      ...process.env,
      DISPLAY: ':99',
      SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY || 'sk-pdxubhitsovteroxocmmdhcytlghrvnopumfgmxxylfgempc',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  child.on('close', (code) => {
    console.log('[CUA Review] PlayableAgent exited with code ' + code + ' for ' + taskId);

    // Find and read report
    let report = null;
    try {
      const runsDir = '/root/cua-agent/runs';
      if (fs.existsSync(runsDir)) {
        const dirs = fs.readdirSync(runsDir).filter(d => d.startsWith('verify_')).sort().reverse();
        for (const dir of dirs) {
          const rp = path.join(runsDir, dir, 'verify_report.json');
          if (fs.existsSync(rp)) {
            report = JSON.parse(fs.readFileSync(rp, 'utf-8'));
            break;
          }
        }
      }
    } catch(e) {
      console.log('[CUA Review] Failed to read report: ' + e.message);
    }

    if (!report) {
      console.log('[CUA Review] No report generated, keeping status as reviewing');
      return;
    }

    // Evaluate
    const passed = report.passed === true;
    const issues = [];
    const missingPhases = report.missingPhases || [];
    const coveredPhases = report.coveredPhases || [];

    if (missingPhases.length > 0) {
      issues.push('[Phase覆盖] 未完成的Phase: ' + missingPhases.join(', '));
    }

    const finalState = report.finalState || {};
    if (finalState.entityStates) {
      const BUILDABLE_KEYS = ['conveyor', 'woodHouse', 'turret'];
      BUILDABLE_KEYS.forEach(key => {
        if (finalState.entityStates[key] !== undefined && String(finalState.entityStates[key]) !== '2') {
          issues.push('[实体未完成] ' + key + '=' + finalState.entityStates[key] + ' (expected 2=built)');
        }
      });
    }

    console.log('[CUA Review] Passed: ' + passed + ', Coverage: ' + coveredPhases.length + '/' + (report.specPhases || []).length + ', Issues: ' + issues.length);

    const latestProject = readProject(taskId);
    if (!latestProject) return;
    if (latestProject.status !== 'reviewing') {
      console.log('[CUA Review] Status changed to ' + latestProject.status + ', skipping');
      return;
    }

    if (passed) {
      console.log('[CUA Review] ✅ PASSED');
      latestProject.statusMessage = 'PlayableAgent验证通过 (覆盖: ' + coveredPhases.length + '/' + (report.specPhases || []).length + ')，等待人工确认';
      latestProject.cuaReview = { passed: true, coverage: coveredPhases.length + '/' + (report.specPhases || []).length, timestamp: new Date().toISOString() };
      writeProject(latestProject);
    } else {
      console.log('[CUA Review] ❌ FAILED — auto-submitting feedback');
      fs.writeFileSync(retryFile, JSON.stringify({ count: retries + 1, lastAttempt: new Date().toISOString() }), 'utf-8');

      const feedbackText = 'PlayableAgent自动验证不通过:\n' + issues.join('\n')
        + (finalState.currentPhase ? '\n\n当前Phase: ' + finalState.currentPhase : '')
        + (finalState.completedPhases ? '\n已完成: ' + JSON.stringify(finalState.completedPhases) : '');

      if (!latestProject.feedbackHistory) latestProject.feedbackHistory = [];
      latestProject.feedbackHistory.push({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        data: { text: feedbackText, source: 'playableagent-auto' },
        status: 'pending'
      });

      latestProject.status = 'submitted';
      latestProject.statusMessage = 'PlayableAgent验证不通过，自动重新编码 (retry ' + (retries + 1) + '/' + MAX_AUTO_RETRIES + ')';
      latestProject.cuaReview = { passed: false, issues: issues.length, timestamp: new Date().toISOString() };
      latestProject.updatedAt = new Date().toISOString();
      writeProject(latestProject);
    }
  });

  child.on('error', (err) => {
    console.log('[CUA Review] Failed to start PlayableAgent: ' + err.message);
  });

  child.unref();
}

function resetCUARetries(taskId) {
  const retryFile = path.join(CUA_RESULTS_DIR, taskId + '-retries.json');
  try { fs.unlinkSync(retryFile); } catch(e) {}
}

module.exports = { triggerCUAReview, resetCUARetries, CUA_RESULTS_DIR };
