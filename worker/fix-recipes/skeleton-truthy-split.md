# Recipe: skeleton.split truthy check → fs.writeFileSync(undefined)

## Fingerprint signature
Error messages like:
- `TypeError: The "data" argument must be of type string or an instance of Buffer. Received undefined`
- Originating from `fs.writeFileSync` inside `prepareWorkDir` in `worker/codex-code-coder.js`
- Often retries 3-4 times within the same second because the throw is synchronous

## Root cause (known)
`String.prototype.split` is a function on every JavaScript string, so `if (skeleton.split)` is ALWAYS truthy when `skeleton` is a plain string — the branch meant for the object form `{ split: true, main, systems }` runs, and `skeleton.main` is `undefined`, so `fs.writeFileSync(csPath, undefined)` throws.

See memory: `feedback_skeleton_truthy_split.md`
Commit fix: `529136b` (check `typeof skeleton === 'object' && skeleton.split === true`)

## Diagnostic steps

1. **Read `codex-code-coder.js`**. Locate the `prepareWorkDir` function's `if (skeleton)` block.
2. Confirm whether line ~162 uses:
   - ❌ `if (skeleton.split)` — bug form, always true on strings
   - ❌ `if (skeleton && skeleton.split)` — still bug form
   - ✅ `if (typeof skeleton === 'object' && skeleton.split === true)` — correct

3. Check the generator: `adapters/skeleton-generator.cjs` — the split-mode return should be an object with a literal boolean `split: true`, not a truthy string. If the generator ever returns a plain string with a `split` property attached, that also needs fixing.

## Expected patch

If the check reverted to the buggy form, restore it to:

```javascript
// NOTE: check `typeof object` not `skeleton.split` — a plain string has `.split` as a
// method (String.prototype.split), so `if (skeleton.split)` is ALWAYS truthy
// and throws `fs.writeFileSync(path, undefined)`. The generator flags split mode with
// `split: true` on a returned object.
if (typeof skeleton === 'object' && skeleton.split === true) {
  // Multi-file skeleton: main + systems
  fs.writeFileSync(csPath, skeleton.main);
  fs.writeFileSync(sysPath, skeleton.systems);
  // ...
} else {
  // Single file skeleton (≤10 phases)
  const skeletonStr = typeof skeleton === 'string' ? skeleton : skeleton.main || String(skeleton);
  fs.writeFileSync(csPath, skeletonStr);
}
```

## Verification command

```bash
node -e "const s='hello'; console.log('.split truthy?', !!s.split, 'typeof object?', typeof s === 'object')"
# Expected: .split truthy? true   typeof object? false
```

And confirm the repo has the correct check:

```bash
grep -n "typeof skeleton === 'object' && skeleton.split === true" /opt/blueprint-editor/worker/codex-code-coder.js
```

If grep finds it, the code is fixed. If grep returns nothing, apply the patch above.

## Related memory / commits
- `feedback_skeleton_truthy_split.md` — why JS method-name truthy checks are dangerous
- `feedback_skeleton_protection.md` — skeleton constants need 3-layer defense
- Commit `529136b` — original fix
