// Stamps version.json at the project root from git history; run by the Docker build
import { versionFile, writeVersionFile } from './version.js';

console.log(`${writeVersionFile()} -> ${versionFile}`);
