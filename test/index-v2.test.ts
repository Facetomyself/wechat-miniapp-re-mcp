import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStaticIndexFromFiles } from '../src/static/index-v2.js';
import { StaticAdapter } from '../src/static/adapter.js';
import { correlateRuntimeStatic } from '../src/workflows/correlate.js';
import type { AppConfig } from '../src/config.js';

function config(workspaceRoot: string): AppConfig {
  return {
    toolset: 'agent',
    workspaceRoot,
    profileDirs: [],
    legacyProfileDirs: [],
    signatureDbPaths: [],
    gwxapkgPath: null,
    debugHost: '127.0.0.1',
    debugPort: 0,
    eventLimit: 5000,
    maxEvidenceEvents: 100_000,
    maxEvidenceBytes: 256 * 1024 * 1024,
    protocolPreviewBytes: 2048,
    maxProtocolArtifactBytes: 8 * 1024 * 1024,
  };
}

test('index v2 classifies main, subpackage, plugin, and minigame fixtures', () => {
  const main = buildStaticIndexFromFiles('/main', [
    {
      relativePath: 'app.json',
      size: 100,
      content: JSON.stringify({
        pages: ['pages/index/index', 'pages/detail/detail'],
        subPackages: [{ root: 'pkg', pages: ['list/list'] }],
        tabBar: { list: [{ pagePath: 'pages/index/index', text: 'Home' }] },
        permission: { 'scope.userLocation': { desc: 'loc' } },
        plugins: { hello: { version: '1.0.0', provider: 'wxplugin' } },
        workers: 'workers/',
      }),
    },
    {
      relativePath: 'app.js',
      size: 80,
      content: 'wx.request({url:"https://api.example.com/v1"});\nwx.navigateTo({url:"/pages/detail/detail"});',
    },
    {
      relativePath: 'pages/index/index.json',
      size: 40,
      content: JSON.stringify({ usingComponents: { nav: '/components/nav/nav' } }),
    },
  ]);
  assert.equal(main.schemaVersion, 2);
  assert.equal(main.kind, 'main');
  assert.equal(main.manifest.pages.length, 2);
  assert.equal(main.manifest.subPackages[0]?.root, 'pkg');
  assert.equal(main.manifest.tabBar[0]?.pagePath, 'pages/index/index');
  assert.equal(main.manifest.plugins[0]?.name, 'hello');
  assert.ok(main.manifest.permissions.includes('scope.userLocation'));
  assert.equal(main.manifest.usingComponents[0]?.name, 'nav');
  assert.ok(main.urlHits.some((hit) => hit.value.includes('api.example.com') && hit.location?.file === 'app.js'));
  assert.equal(main.urlHits.find((hit) => hit.value.includes('api.example.com'))?.confidence, 'heuristic');
  assert.equal(main.manifest.pages[0]?.confidence, 'structure');

  const subpackage = buildStaticIndexFromFiles('/pkg', [
    { relativePath: 'pages/list/list.js', size: 20, content: 'Page({});' },
  ]);
  assert.equal(subpackage.kind, 'subpackage');

  const plugin = buildStaticIndexFromFiles('/plugin', [
    { relativePath: 'plugin.json', size: 40, content: JSON.stringify({ pages: ['pages/hello/hello'] }) },
    { relativePath: 'pages/hello/hello.js', size: 20, content: 'Component({});' },
  ]);
  assert.equal(plugin.kind, 'plugin');
  assert.equal(plugin.manifest.pages[0]?.value, 'pages/hello/hello');

  const minigame = buildStaticIndexFromFiles('/game', [
    { relativePath: 'game.json', size: 40, content: JSON.stringify({ deviceOrientation: 'portrait', subPackages: [{ root: 'stage', pages: [] }] }) },
    { relativePath: 'game.js', size: 30, content: 'wx.cloud.callFunction({name:"boot"});' },
  ]);
  assert.equal(minigame.kind, 'minigame');
  assert.ok(minigame.cloudHits.some((hit) => hit.value === 'cloud.callFunction'));
  assert.equal(minigame.summary.subPackages, 1);
});

test('StaticAdapter buildIndex writes v2 index and summary artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-index-v2-'));
  const srcDir = path.join(root, 'restored');
  await fs.mkdir(path.join(srcDir, 'pages', 'index'), { recursive: true });
  await fs.writeFile(path.join(srcDir, 'app.json'), `${JSON.stringify({ pages: ['pages/index/index'] }, null, 2)}\n`);
  await fs.writeFile(path.join(srcDir, 'app.js'), 'wx.request({url:"https://api.example.com/v1"});\n');
  const adapter = new StaticAdapter(config(root));
  const index = await adapter.buildIndex(srcDir, 'index-v2');
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.kind, 'main');
  assert.ok(typeof index.outputPath === 'string');
  assert.ok(typeof index.summaryPath === 'string');
  const written = JSON.parse(await fs.readFile(String(index.outputPath), 'utf8')) as { schemaVersion: number };
  const summary = JSON.parse(await fs.readFile(String(index.summaryPath), 'utf8')) as { kind: string };
  assert.equal(written.schemaVersion, 2);
  assert.equal(summary.kind, 'main');
  await fs.rm(root, { recursive: true, force: true });
});

test('correlate joins request URL to a sourced heuristic hit and initiator to a file', () => {
  const result = correlateRuntimeStatic({
    appId: 'wxfixture',
    scripts: [{ scriptId: 's1', url: 'https://usr/app-service.js' }],
    requests: [{
      requestId: 'r1',
      url: 'https://api.example.com/v1/user',
      initiator: { type: 'script', url: 'https://usr/app-service.js' },
    }],
    snapshotRoutes: ['pages/index/index'],
    packages: [{ appId: 'wxfixture', path: 'C:\\pkgs\\wxfixture\\app.wxapkg' }],
    index: {
      root: 'C:\\restored',
      kind: 'main',
      urls: ['https://api.example.com/v1/user'],
      routes: ['/pages/index/index'],
      files: ['app-service.js', 'pages/index/index.js'],
      urlHits: [{
        value: 'https://api.example.com/v1/user',
        confidence: 'heuristic',
        location: { file: 'app.js', line: 4 },
      }],
      pages: [{ value: 'pages/index/index', confidence: 'structure', location: { file: 'app.json', line: 1 } }],
    },
  });
  const request = result.joins.find((item) => item.kind === 'request');
  const initiator = result.joins.find((item) => item.kind === 'initiator');
  const route = result.joins.find((item) => item.kind === 'route');
  assert.equal(request?.confidence, 'medium');
  assert.match(request?.reason ?? '', /app\.js:4/);
  assert.equal(initiator?.confidence, 'medium');
  assert.equal(route?.confidence, 'high');
  assert.equal((route?.staticHit as { source?: string } | null)?.source, 'manifest-page');
  assert.equal(result.summary.initiatorJoins, 1);
  assert.equal(result.summary.indexKind, 'main');
});
