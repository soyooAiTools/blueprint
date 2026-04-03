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

  return {
    run: function(ctx) {
      var round = 0;
      var consecutiveInfra = 0;

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

        // beforeRound hook (status reporting etc)
        if (beforeRoundFn) {
          try { beforeRoundFn(ctx, round, maxRounds); } catch(e) {}
        }

        return Promise.resolve().then(function() {
          return attemptFn(ctx, round, maxRounds);
        }).then(function(outcome) {
          // Reset infra counter on success
          consecutiveInfra = 0;

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
