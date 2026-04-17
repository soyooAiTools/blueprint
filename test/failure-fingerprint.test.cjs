const { extractKeywords, findAutoFixRecipe, loadRecipes } = require('../engine/failure-fingerprint.cjs');

describe('failure-fingerprint', () => {
  describe('extractKeywords', () => {
    test('returns empty for null/empty', () => {
      expect(extractKeywords(null)).toEqual([]);
      expect(extractKeywords('')).toEqual([]);
    });

    test('extracts all-caps error codes (>=4 chars)', () => {
      const kws = extractKeywords('ENOENT: file not found');
      expect(kws).toContain('ENOENT');
    });

    test('extracts PascalCase identifiers', () => {
      const kws = extractKeywords('MonoBehaviour not found in GameFlowManagerMain');
      expect(kws).toContain('MonoBehaviour');
      expect(kws).toContain('GameFlowManagerMain');
    });

    test('extracts quoted strings', () => {
      const kws = extractKeywords('Cannot read property "csCode" of undefined');
      expect(kws).toContain('csCode');
    });

    test('extracts domain phrases', () => {
      const kws = extractKeywords('skeleton generation failed with black screen');
      expect(kws).toContain('skeleton');
      expect(kws).toContain('black screen');
    });

    test('extracts MODEL_FATAL', () => {
      const kws = extractKeywords('MODEL_FATAL: quota exceeded');
      expect(kws).toContain('MODEL_FATAL');
    });

    test('deduplicates keywords', () => {
      const kws = extractKeywords('FATAL error FATAL again');
      const fatalCount = kws.filter(k => k === 'FATAL').length;
      expect(fatalCount).toBe(1);
    });

    test('extracts CUA-related phrases', () => {
      const kws = extractKeywords('CUA total time limit exceeded (51min > 45min)');
      expect(kws).toContain('CUA');
    });

    test('extracts SetActive from domain phrases', () => {
      const kws = extractKeywords('Code uses SetActive which is forbidden');
      expect(kws).toContain('SetActive');
    });
  });

  describe('findAutoFixRecipe', () => {
    test('returns null for unmatched fingerprint', () => {
      const result = findAutoFixRecipe('completely random string that matches nothing xyz123');
      expect(result).toBeNull();
    });
  });

  describe('loadRecipes', () => {
    test('returns array', () => {
      const recipes = loadRecipes();
      expect(Array.isArray(recipes)).toBe(true);
    });

    test('each recipe has required fields', () => {
      const recipes = loadRecipes();
      for (const r of recipes) {
        expect(r).toHaveProperty('fingerprintPattern');
        expect(typeof r.fingerprintPattern).toBe('string');
      }
    });
  });
});
