/**
 * StateMachine — declarative state transition rules
 * Prevents invalid state transitions and records history
 */

// ============ Task Status Transitions ============
// pending → assigned → processing → developing → building → completed
//                                                         → failed → pending (retry)
//                                                         → fix_needed → assigned (re-claim)
var TASK_TRANSITIONS = {
  pending:        ['assigned'],
  assigned:       ['processing', 'pending'],          // pending = timeout/watchdog回退
  processing:     ['developing', 'building', 'completed', 'failed', 'fix_needed', 'done', 'cua_passed'],
  developing:     ['building', 'failed', 'fix_needed'],
  building:       ['completed', 'failed', 'fix_needed', 'done', 'cua_passed'],
  fix_needed:     ['assigned', 'pending'],            // 重新被 worker claim 或入队
  failed:         ['pending', 'permanent_fail'],      // pending = 重试
  done:           [],                                 // 终态
  cua_passed:     [],                                 // 终态
  completed:      [],                                 // 终态
  permanent_fail: [],                                 // 终态
  cancelled:      [],                                 // 终态
};

// ============ Project Status Transitions ============
var PROJECT_TRANSITIONS = {
  editing:          ['submitted', 'spec_extracting'],
  spec_extracting:  ['submitted', 'editing'],           // 提取失败可回退
  submitted:        ['assigned', 'processing', 'developing', 'building', 'reviewing', 'failed', 'done', 'cua_passed', 'feedback'],
  assigned:         ['processing', 'pending', 'failed'],
  processing:       ['developing', 'building', 'reviewing', 'failed', 'done', 'cua_passed'],
  developing:       ['building', 'reviewing', 'failed'],
  building:         ['reviewing', 'failed', 'done', 'cua_passed'],
  reviewing:        ['feedback', 'approved', 'failed'],
  feedback:         ['submitted', 'editing'],           // 反馈后可重新提交
  approved:         ['committed'],
  committed:        [],                                 // 终态
  failed:           ['editing', 'submitted'],           // 允许重试
  done:             ['reviewing'],                      // done后进入人工审核
  cua_passed:       ['reviewing'],                      // CUA通过后进入人工审核
};

function StateMachine(transitions, name) {
  this.transitions = transitions;
  this.name = name || 'state-machine';
}

StateMachine.prototype.canTransition = function(from, to) {
  var allowed = this.transitions[from];
  if (!allowed) return false;
  return allowed.indexOf(to) >= 0;
};

StateMachine.prototype.validate = function(from, to) {
  if (!this.canTransition(from, to)) {
    var allowed = this.transitions[from] || [];
    return {
      valid: false,
      error: '[' + this.name + '] Invalid transition: ' + from + ' → ' + to +
             '. Allowed: [' + allowed.join(', ') + ']'
    };
  }
  return { valid: true };
};

/**
 * Transition with validation (throws on invalid)
 * Returns updated entity with statusHistory
 */
StateMachine.prototype.transition = function(entity, newStatus, meta) {
  var from = entity.status;
  var result = this.validate(from, newStatus);
  if (!result.valid) {
    if (meta && meta.force) {
      console.warn('[force] ' + result.error);
    } else {
      throw new Error(result.error);
    }
  }

  if (!entity.statusHistory) entity.statusHistory = [];
  entity.statusHistory.push({
    from: from,
    to: newStatus,
    at: new Date().toISOString(),
    actor: (meta && meta.actor) || null,
    reason: (meta && meta.reason) || null,
  });
  // Keep last 30 entries
  if (entity.statusHistory.length > 30) {
    entity.statusHistory = entity.statusHistory.slice(-30);
  }

  entity.status = newStatus;
  entity.updatedAt = new Date().toISOString();
  return entity;
};

/**
 * Force transition for internal actors (watchdog, admin).
 * Logs warning on invalid transition but allows it.
 */
StateMachine.prototype.forceTransition = function(entity, newStatus, actor) {
  var from = entity.status;
  var result = this.validate(from, newStatus);
  if (!result.valid) {
    console.warn('[force][' + (actor || 'internal') + '] ' + result.error);
  }

  if (!entity.statusHistory) entity.statusHistory = [];
  entity.statusHistory.push({
    from: from,
    to: newStatus,
    at: new Date().toISOString(),
    actor: actor || 'force',
    reason: result.valid ? null : 'forced',
  });
  if (entity.statusHistory.length > 30) {
    entity.statusHistory = entity.statusHistory.slice(-30);
  }

  entity.status = newStatus;
  entity.updatedAt = new Date().toISOString();
  return entity;
};

/**
 * Get all allowed next states from current state
 */
StateMachine.prototype.allowedTransitions = function(currentStatus) {
  return this.transitions[currentStatus] || [];
};

/**
 * Check if a state is terminal (no outgoing transitions)
 */
StateMachine.prototype.isTerminal = function(status) {
  var allowed = this.transitions[status];
  return !allowed || allowed.length === 0;
};

// Pre-built instances
var taskSM = new StateMachine(TASK_TRANSITIONS, 'task');
var projectSM = new StateMachine(PROJECT_TRANSITIONS, 'project');

module.exports = {
  StateMachine: StateMachine,
  taskSM: taskSM,
  projectSM: projectSM,
  TASK_TRANSITIONS: TASK_TRANSITIONS,
  PROJECT_TRANSITIONS: PROJECT_TRANSITIONS,
};
