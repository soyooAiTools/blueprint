const { validatePath } = require('../engine/auto-fix.cjs');

const REPO_ROOT = '/opt/blueprint-editor';

describe('auto-fix validatePath', () => {
  describe('normal paths ALLOW', () => {
    test('simple relative path', () => {
      expect(validatePath('engine/static-check.cjs', [], REPO_ROOT)).toBeNull();
    });

    test('nested relative path', () => {
      expect(validatePath('worker/code-reviewer.js', [], REPO_ROOT)).toBeNull();
    });

    test('deep nested path', () => {
      expect(validatePath('engine/stages/review.cjs', [], REPO_ROOT)).toBeNull();
    });
  });

  describe('path traversal REJECT', () => {
    test('../etc/passwd', () => {
      expect(validatePath('../etc/passwd', [], REPO_ROOT)).toBe('traversal');
    });

    test('../../../etc/shadow', () => {
      expect(validatePath('../../../etc/shadow', [], REPO_ROOT)).toBe('traversal');
    });

    test('engine/../../.env', () => {
      expect(validatePath('engine/../../.env', [], REPO_ROOT)).toBe('traversal');
    });

    test('backslash traversal ..\\', () => {
      expect(validatePath('..\\etc\\passwd', [], REPO_ROOT)).toBe('traversal');
    });
  });

  describe('absolute path REJECT', () => {
    test('/etc/shadow', () => {
      expect(validatePath('/etc/shadow', [], REPO_ROOT)).toBe('traversal');
    });

    test('/root/.bashrc', () => {
      expect(validatePath('/root/.bashrc', [], REPO_ROOT)).toBe('traversal');
    });
  });

  describe('affectedFiles whitelist', () => {
    test('path in whitelist ALLOW', () => {
      const allowed = ['engine/static-check.cjs', 'worker/code-reviewer.js'];
      expect(validatePath('engine/static-check.cjs', allowed, REPO_ROOT)).toBeNull();
    });

    test('path not in whitelist REJECT', () => {
      const allowed = ['engine/static-check.cjs'];
      expect(validatePath('worker/code-reviewer.js', allowed, REPO_ROOT)).toBe('not-allowed');
    });

    test('empty whitelist allows all', () => {
      expect(validatePath('any/path.js', [], REPO_ROOT)).toBeNull();
    });
  });

  describe('resolved path escape REJECT', () => {
    test('path resolving outside repo via symlink-like name', () => {
      const result = validatePath('engine/static-check.cjs', [], REPO_ROOT);
      expect(result).toBeNull();
    });
  });
});
