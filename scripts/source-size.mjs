import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, basename } from 'node:path';

const reference = process.argv[2];
const files = execFileSync('git', reference
  ? ['ls-tree', '-r', '--name-only', reference]
  : ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .trim().split('\n');
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.py', '.sh', '.css']);
const groups = {};
let lines = 0;
let count = 0;
for (const path of new Set(files)) {
  if (!extensions.has(extname(path)) || /^(public|\.agents)\//.test(path)
    || /\.(test|spec)\./.test(path) || /^tests\//.test(path)
    || /\/(testing|__fixtures__)\//.test(path) || basename(path) === 'test-helpers.ts') continue;
  let source;
  try {
    source = reference
      ? execFileSync('git', ['show', `${reference}:${path}`], { encoding: 'utf8', maxBuffer: 16000000 })
      : readFileSync(path, 'utf8');
  } catch { continue; }
  const size = source ? source.split('\n').length - Number(source.endsWith('\n')) : 0;
  const group = path.split('/')[0];
  groups[group] ??= { files: 0, lines: 0 };
  groups[group].files++;
  groups[group].lines += size;
  lines += size;
  count++;
}
console.log(JSON.stringify({ reference: reference ?? 'working tree', files: count, lines, groups }, null, 2));
