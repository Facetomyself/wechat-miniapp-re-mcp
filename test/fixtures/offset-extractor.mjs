import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (args.includes('--fail')) {
  console.error('fixture extractor failed');
  process.exit(2);
}

const version = Number(flag('--version') ?? '0');
const result = {
  Version: version,
  LoadStartHookOffset: '0x1000',
  CDPFilterHookOffset: '0x2000',
  SceneOffsets: [64, 1480, 8, 1416, 16, 456],
};
const text = `${JSON.stringify(result, null, 4)}\n`;
process.stdout.write(text);
const output = flag('--output');
if (output) writeFileSync(output, text, 'utf8');
