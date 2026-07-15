import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);

function option(name) {
  const prefix = `${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function decompile(inputPath, outputPath, appId, noOutput) {
  if (noOutput) return;
  await mkdir(path.join(outputPath, 'pages', 'index'), { recursive: true });
  await writeFile(path.join(outputPath, 'app.js'), [
    'App({',
    '  onLaunch() {',
    "    wx.request({ url: 'https://fixture.example.test/v1/data' });",
    "    wx.navigateTo({ url: '/pages/detail/detail' });",
    '  },',
    '});',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(outputPath, 'app.json'), `${JSON.stringify({
    pages: ['pages/index/index'],
    window: { navigationBarTitleText: 'Subprocess Fixture' },
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outputPath, 'pages', 'index', 'index.js'), [
    'Page({',
    '  onLoad() {',
    "    wx.setStorage({ key: 'fixture', data: true });",
    '  },',
    '});',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(outputPath, 'pages', 'index', 'index.wxml'), '<view>subprocess fixture</view>\n', 'utf8');
}

async function repack(inputPath, outputPath, appId, noOutput) {
  if (noOutput) return;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `WXAPKG_FIXTURE\n${JSON.stringify({ inputPath, appId })}\n`, 'utf8');
}

async function main() {
  if (args.includes('--fixture-fail')) {
    console.error('controlled fixture backend failure');
    process.exitCode = 23;
    return;
  }

  const inputPath = option('-in');
  const outputPath = option('-out');
  const appId = option('-id') ?? null;
  if (!inputPath || !outputPath) throw new Error('fixture backend requires -in and -out');
  await access(inputPath);

  const mode = args.some((value) => value.toLowerCase() === 'repack') ? 'repack' : 'decompile';
  const noOutput = args.includes('--fixture-no-output');
  if (mode === 'repack') await repack(inputPath, outputPath, appId, noOutput);
  else await decompile(inputPath, outputPath, appId, noOutput);

  process.stdout.write(`${JSON.stringify({ mode, inputPath, outputPath, appId, args, noOutput })}\n`);
}

main().catch((error) => {
  console.error(`fixture backend error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
