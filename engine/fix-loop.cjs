/**
 * FixLoop — unified fix-loop primitive for pipeline stages
 *
 * Stages declare a FixLoop config and call loop.run(ctx).
 * The loop handles round counting, logging, status reporting,
 * error classification, and exhaustion policy.
 *
 * Usage:
 *   var { createFixLoop } = require('../fix-loop.cjs');
 *   var loop = createFixLoop({
 *     name: 'compile',
 *     maxRounds: 5,
 *     onExhausted: 'throw',           // or 'pass-through'
 *     beforeRound: function(ctx, round, maxRounds) { ... },
 *     attempt: function(ctx, round, maxRounds) {
 *       // Return Promise<{done:boolean, result?:any}>
 *     },
 *   });
 *   return loop.run(ctx);
 */

var { classify } = require('./error-classifier.cjs');

function createFixLoop(config) {
  var name = config.name;
  var maxRounds = config.maxRounds || 5;
  var onExhausted = config.onExhausted || 'throw';
  var attemptFn = config.attempt;
  var beforeRoundFn = config.beforeRound || null;
  var onErrorFn = config.onError || null;
  // Circuit breaker: if the same CODE error signature repeats this many rounds
  // in a row, abort the loop. Prevents "AI fix doesn't converge" token burn.
  var sameErrorThreshold = config.sameErrorThreshold || 3;

  return {
    run: function(ctx) {
      var round = 0;
      var consecutiveInfra = 0;
      var lastErrorSig = null;
      var sameErrorStreak = 0;

      function next() {
        round++;
        if (round > maxRounds) {
          if (onExhausted === 'pass-through') {
            ctx.addLog(name, 'Exhausted ' + maxRounds + ' rounds, proceeding anyway');
            return Promise.resolve({ exhausted: true, rounds: maxRounds });
          }
          throw new Error(name + ' failed after ' + maxRounds + ' rounds');
        }

        ctx.addLog(name, 'Round ' + round + '/' + maxRounds);

        // beforeRound hook (status reporting etc). Must be awaited — prior
        // fire-and-forget behavior caused a race where attempt() started
        // before status was persisted, and async errors vanished silently.
        var beforePromise = Promise.resolve();
        if (beforeRoundFn) {
          beforePromise = Promise.resolve().then(function() {
            return beforeRoundFn(ctx, round, maxRounds);
          }).catch(function(e) {
            // beforeRound errors are non-fatal — log and continue so that
            // a broken status reporter can't take down the whole pipeline.
            ctx.addLog(name, 'beforeRound error (non-fatal): ' + (e && e.message ? e.message : String(e)));
          });
        }

        return beforePromise.then(function() {
          return attemptFn(ctx, round, maxRounds);
        }).then(function(outcome) {
          // Reset infra + circuit breaker counters on successful attempt
          consecutiveInfra = 0;
          lastErrorSig = null;
          sameErrorStreak = 0;

          if (outcome.done) {
            return outcome.result;
          }
          // Not done — loop continues
          return next();
        }).catch(function(err) {
          var classified = classify(err, {
            stage: name,
            consecutiveInfra: consecutiveInfra,
          });

          ctx.addLog(name, 'Round ' + round + ' error [' + classified.type + ']: ' + classified.reason.slice(0, 200));

          // Circuit breaker — if the same CODE error repeats N rounds in a row,
          // the fix-loop is not converging. Abort instead of burning more rounds
          // (and more Claude Code agent tokens) on a fix that demonstrably isn't
          // working. Only applies to CODE (recode) — INFRA retries are expected
          // to repeat with the same message and have their own escalation path.
          if (classified.type === 'CODE') {
            var sig = (classified.reason || '').slice(0, 120);
            if (sig && sig === lastErrorSig) {
              sameErrorStreak++;
              if (sameErrorStreak >= sameErrorThreshold) {
                ctx.addLog(name, 'Circuit breaker: same CODE error repeated ' + sameErrorStreak + ' rounds — aborting fix-loop');
                var breakerErr = new Error(name + ' aborted: same CODE error repeated ' + sameErrorStreak + ' rounds, fix-loop not converging: ' + sig);
                breakerErr.code = 'FIX_LOOP_CIRCUIT_BREAKER';
                throw breakerErr;
              }
            } else {
              lastErrorSig = sig;
              sameErrorStreak = 1;
            }
          }

          // Let stage handle error if custom handler provided
          if (onErrorFn) {
            try {
              var handled = onErrorFn(ctx, round, err, classified);
              if (handled && handled.abort) {
                throw err; // Stage decided to abort
              }
            } catch(handlerErr) {
              if (handlerErr === err) throw err; // Re-thrown intentionally
              // Handler error — fall through to default behavior
            }
          }

          // MODEL_FATAL is the highest-priority terminal error — quota/auth/invalid-key.
          // Like FATAL, it must NOT retry (the model backend is unusable), but the
          // worker layer routes it to `cancelled` instead of `failed` via classification
          // lookup (see linux-worker-client.js processTask catch handler).
          if (classified.type === 'MODEL_FATAL') {
            ctx.addLog(name, 'MODEL_FATAL — aborting fix-loop immediately (task will be cancelled)');
            throw err;
          }

          if (classified.type === 'FATAL') {
            throw err;
          }

          if (classified.type === 'INFRA') {
            consecutiveInfra++;
            // Backoff then retry same round (no recode)
            if (classified.backoffMs > 0) {
              ctx.addLog(name, 'INFRA error, backing off ' + (classified.backoffMs / 1000) + 's before retry...');
              return new Promise(function(resolve) {
                setTimeout(resolve, classified.backoffMs);
              }).then(function() {
                round--; // Don't count INFRA retries against round limit
                return next();
              });
            }
            round--; // Don't count INFRA retries
            return next();
          }

          // CODE error — continue to next round (stage will recode)
          if (round >= maxRounds) {
            if (onExhausted === 'pass-through') {
              ctx.addLog(name, 'Exhausted ' + maxRounds + ' rounds after error, proceeding anyway');
              return { exhausted: true, rounds: maxRounds, lastError: classified.reason };
            }
            throw err;
          }
          return next();
        });
      }

      return next();
    },
  };
}

module.exports = { createFixLoop: createFixLoop };
