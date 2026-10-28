import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Versions look like 2026.10.28.3: the date of the latest commit, then which commit of that day it is
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const versionFile = join(projectRoot, 'version.json');

export const gitVersion = (cwd: string = projectRoot): string | null => {
    try {
        const dates = execFileSync('git', ['log', '--format=%cd', '--date=format:%Y.%m.%d'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .split('\n')
            .filter(Boolean);
        if (!dates.length) return null;
        const count = dates.filter(date => date === dates[0]).length;
        return `${dates[0]}.${count}`;
    } catch {
        return null;
    }
};

// The Docker image has no git history, so its build stamps version.json; development checkouts ask git
export const resolveVersion = (file: string = versionFile): string => {
    try {
        const { version } = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
        if (typeof version === 'string' && version) return version;
    } catch {
        // no stamped version
    }
    return gitVersion() ?? 'unknown';
};

export const writeVersionFile = (file: string = versionFile): string => {
    const version = gitVersion() ?? 'unknown';
    writeFileSync(file, `${JSON.stringify({ version })}\n`);
    return version;
};
