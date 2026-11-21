const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

const root = resolve(__dirname, '..');
for (const name of ['src', 'scripts', 'test']) {
  const dir = join(root, name);
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.(?:cjs|js|mjs)$/i.test(entry.name)) {
      execFileSync(process.execPath, ['--check', join(entry.parentPath, entry.name)], { stdio: 'inherit' });
    }
  }
}
