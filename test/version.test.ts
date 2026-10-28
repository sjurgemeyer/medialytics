import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitVersion, resolveVersion } from '../src/server/version.js';
import { tempDir } from './helpers.js';

const commitAt = (repo: string, date: string) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
        'commit', '--allow-empty', '-q', '-m', date], { cwd: repo, env });
};

describe('version', () => {
    it('is the latest commit date followed by its number within that day', () => {
        const repo = tempDir();
        execFileSync('git', ['init', '-q'], { cwd: repo });
        commitAt(repo, '2026-10-27T20:00:00+00:00');
        commitAt(repo, '2026-10-28T09:00:00+00:00');
        commitAt(repo, '2026-10-28T11:00:00+00:00');
        commitAt(repo, '2026-10-28T15:30:00+00:00');
        expect(gitVersion(repo)).toBe('2026.10.28.3');
    });

    it('is null outside a git checkout', () => {
        expect(gitVersion(tempDir())).toBeNull();
    });

    it('prefers a stamped version file', () => {
        const file = join(tempDir(), 'version.json');
        writeFileSync(file, JSON.stringify({ version: '2026.01.02.4' }));
        expect(resolveVersion(file)).toBe('2026.01.02.4');
    });

    it('falls back to git history without a version file', () => {
        expect(resolveVersion(join(tempDir(), 'missing.json'))).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d+$/);
    });
});
