import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StaticAdapter } from '../src/static/adapter.js';
import type { AppConfig } from '../src/config.js';

function mockConfig(workspaceRoot: string, gwxapkgPath: string | null = null): AppConfig {
  return {
    workspaceRoot,
    profileDirs: [],
    legacyProfileDirs: [],
    gwxapkgPath,
    debugHost: '127.0.0.1',
    debugPort: 9421,
    eventLimit: 5000,
  };
}

test('StaticAdapter scan discovers .wxapkg files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-'));
  const packagesDir = path.join(root, 'packages');
  await fs.mkdir(path.join(packagesDir, 'wxapp1'), { recursive: true });
  await fs.mkdir(path.join(packagesDir, 'wxapp2'), { recursive: true });
  await fs.writeFile(path.join(packagesDir, 'wxapp1', 'app.wxapkg'), 'dummy');
  await fs.writeFile(path.join(packagesDir, 'wxapp2', '_sub_1.wxapkg'), 'dummy');
  await fs.writeFile(path.join(packagesDir, 'not-a-package.txt'), 'ignored');

  const adapter = new StaticAdapter(mockConfig(root));
  const results = await adapter.scan([packagesDir]);
  assert.ok(results.length >= 2);
  assert.ok(results.every((item) => item.path.endsWith('.wxapkg')));
  assert.ok(results.some((item) => item.name === 'app.wxapkg'));
  assert.ok(results.some((item) => item.name === '_sub_1.wxapkg'));

  await fs.rm(root, { recursive: true, force: true });
});

test('StaticAdapter scan respects limit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-'));
  const packagesDir = path.join(root, 'pkgs');
  await fs.mkdir(packagesDir, { recursive: true });
  await fs.writeFile(path.join(packagesDir, 'a.wxapkg'), '');
  await fs.writeFile(path.join(packagesDir, 'b.wxapkg'), '');
  await fs.writeFile(path.join(packagesDir, 'c.wxapkg'), '');

  const adapter = new StaticAdapter(mockConfig(root));
  const results = await adapter.scan([packagesDir], 2);
  assert.equal(results.length, 2);

  await fs.rm(root, { recursive: true, force: true });
});

test('StaticAdapter info reports backend status', () => {
  const adapter = new StaticAdapter(mockConfig('/tmp'));
  const info = adapter.info();
  assert.equal(info.backend, 'Gwxapkg');
  assert.equal(info.available, false);
});

test('StaticAdapter search finds text in restored sources', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-'));
  const srcDir = path.join(root, 'decompiled');
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(path.join(srcDir, 'app.js'), 'wx.request({url:"https://api.test/data"})\nconsole.log("done")');
  await fs.writeFile(path.join(srcDir, 'app.json'), '{"pages":["pages/index/index"]}');
  await fs.writeFile(path.join(srcDir, 'page.wxml'), '<view>{{title}}</view>');

  const adapter = new StaticAdapter(mockConfig(root));
  const results = await adapter.search(srcDir, 'wx.request');
  assert.ok((results.count as number) >= 1);
  assert.ok((results.matches as Array<{ text: string }>).some((match) => match.text.includes('wx.request')));

  // Regex mode
  const regexResults = await adapter.search(srcDir, 'https?://api[^"\'\\s]+', { regex: true });
  assert.ok((regexResults.count as number) >= 1);

  await fs.rm(root, { recursive: true, force: true });
});

test('StaticAdapter buildIndex extracts URLs, wx APIs, routes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-'));
  const srcDir = path.join(root, 'decompiled');
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(path.join(srcDir, 'app.js'), [
    'wx.request({url:"https://api.example.com/v1"})',
    'wx.setStorage({key:"token",data:"abc"})',
    'wx.navigateTo({url:"/pages/detail/detail"})',
    'wx.cloud.callFunction({name:"getUser"})',
  ].join('\n'));

  const adapter = new StaticAdapter(mockConfig(root));
  const index = await adapter.buildIndex(srcDir, 'testproject');
  assert.ok((index.urls as string[]).some((u) => u.includes('api.example.com')));
  assert.ok((index.wxApis as string[]).includes('request'));
  assert.ok((index.wxApis as string[]).includes('setStorage'));
  assert.ok((index.routes as string[]).some((r) => r.includes('pages/detail/detail')));

  await fs.rm(root, { recursive: true, force: true });
});

test('StaticAdapter decompile requires backend and rejects missing executable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-'));
  const adapter = new StaticAdapter(mockConfig(root, null));

  await assert.rejects(
    () => adapter.decompile({ inputPath: '/nonexistent/app.wxapkg', projectName: 'test' }),
    (error: unknown) => error instanceof Error && error.message.includes('Gwxapkg executable'),
  );

  await fs.rm(root, { recursive: true, force: true });
});

test('StaticAdapter search rejects nonexistent roots', async () => {
  const adapter = new StaticAdapter(mockConfig('/tmp'));
  await assert.rejects(
    () => adapter.search('/nonexistent/path', 'query'),
    (error: unknown) => error instanceof Error && error.message.includes('does not exist'),
  );
});
