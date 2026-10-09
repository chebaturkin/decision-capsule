import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const copy = async (name) => {
  const source = join(root, name);
  try { await stat(source); } catch { return; }
  await cp(source, join(dist, name), { recursive: true });
};
for (const item of ['index.html', 'styles.css', 'app.js', 'lib', 'assets']) await copy(item);
