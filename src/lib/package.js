import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

export const PACKAGE_NAME = metadata.name;
export const PACKAGE_VERSION = metadata.version;
export const DEFAULT_CLI_SPEC = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;