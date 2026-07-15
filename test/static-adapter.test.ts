import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StaticAdapter } from '../src/static/adapter.js';
import type { AppConfig } from '../src/config.js';
import { WxmpError } from '../src/errors.js';

const BACKEND_FIXTURE = path.resolve('test', 'fixtures', 'gwxapkg-backend.mjs');

function mockConfig(workspaceRoot: string, gwxapkgPath: string | null = null): AppConfig {
  return {
    workspaceRoot,
    profileDirs: [],
    legacyProfileDirs: [],
    signatureDbPaths: [],
    gwxapkgPath,
    debugHost: '127.0.0.1',
    debugPort: 9421,
    eventLimit: 5000,
    maxEvidenceEvents: 100_000,
    maxEvidenceBytes: 256 * 1024 * 1024,
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

test('StaticAdapter decompile runs a backend subprocess and closes the static analysis loop', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-subprocess-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, 'input', 'fixture.wxapkg');
  await fs.mkdir(path.dirname(inputPath), { recursive: true });
  await fs.writeFile(inputPath, 'runtime-only fixture package', 'utf8');

  const adapter = new StaticAdapter(mockConfig(root, BACKEND_FIXTURE));
  const result = await adapter.decompile({
    inputPath,
    projectName: 'subprocess-fixture',
    appId: 'wxfixture123',
    outputName: 'decompiled',
  });
  const outputPath = result.outputPath as string;
  const invocation = JSON.parse(result.stdout as string) as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(result.appId, 'wxfixture123');
  assert.equal(invocation.mode, 'decompile');
  assert.equal(invocation.inputPath, path.resolve(inputPath));
  assert.equal(invocation.outputPath, outputPath);
  assert.equal(invocation.appId, 'wxfixture123');
  assert.deepEqual(invocation.args, result.args);
  assert.match(await fs.readFile(path.join(outputPath, 'app.js'), 'utf8'), /wx\.request/);

  const search = await adapter.search(outputPath, 'fixture.example.test');
  assert.equal(search.count, 1);
  const index = await adapter.buildIndex(outputPath, 'subprocess-fixture');
  assert.deepEqual(index.urls, ['https://fixture.example.test/v1/data']);
  assert.ok((index.wxApis as string[]).includes('request'));
  assert.ok((index.wxApis as string[]).includes('setStorage'));
  assert.ok((index.routes as string[]).includes('/pages/detail/detail'));
  assert.ok((index.fileCount as number) >= 4);
});

test('StaticAdapter repack runs the backend subprocess and requires a non-empty package', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-subprocess-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, 'restored');
  await fs.mkdir(inputPath, { recursive: true });
  await fs.writeFile(path.join(inputPath, 'app.js'), 'App({});\n', 'utf8');

  const adapter = new StaticAdapter(mockConfig(root, BACKEND_FIXTURE));
  const result = await adapter.repack({
    inputPath,
    projectName: 'subprocess-fixture',
    outputName: 'fixture-repacked.wxapkg',
  });
  const outputPath = result.outputPath as string;
  const invocation = JSON.parse(result.stdout as string) as Record<string, unknown>;
  const output = await fs.readFile(outputPath, 'utf8');

  assert.equal(invocation.mode, 'repack');
  assert.equal(invocation.inputPath, path.resolve(inputPath));
  assert.equal(invocation.outputPath, outputPath);
  assert.match(output, /^WXAPKG_FIXTURE\n/);
});

test('StaticAdapter maps backend subprocess failures to STATIC_ADAPTER_FAILED', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-subprocess-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, 'fixture.wxapkg');
  await fs.writeFile(inputPath, 'runtime-only fixture package', 'utf8');
  const adapter = new StaticAdapter(mockConfig(root, BACKEND_FIXTURE));

  await assert.rejects(
    () => adapter.decompile({
      inputPath,
      projectName: 'subprocess-failure',
      outputName: 'failed',
      extraArgs: ['--fixture-fail'],
    }),
    (error: unknown) => {
      assert.ok(error instanceof WxmpError);
      assert.equal(error.code, 'STATIC_ADAPTER_FAILED');
      assert.equal(error.details.code, 23);
      assert.match(String(error.details.stderr), /controlled fixture backend failure/);
      return true;
    },
  );
});

test('StaticAdapter rejects successful subprocesses that produce no output', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-subprocess-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputPath = path.join(root, 'fixture.wxapkg');
  await fs.writeFile(inputPath, 'runtime-only fixture package', 'utf8');
  const adapter = new StaticAdapter(mockConfig(root, BACKEND_FIXTURE));

  await assert.rejects(
    () => adapter.decompile({
      inputPath,
      projectName: 'subprocess-no-output',
      outputName: 'empty',
      extraArgs: ['--fixture-no-output'],
    }),
    (error: unknown) => {
      assert.ok(error instanceof WxmpError);
      assert.equal(error.code, 'STATIC_ADAPTER_NO_OUTPUT');
      assert.match(String(error.details.stdout), /\"noOutput\":true/);
      return true;
    },
  );
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

test('StaticAdapter buildIndex rejects nonexistent roots instead of producing an empty success', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-'));
  const adapter = new StaticAdapter(mockConfig(root));
  await assert.rejects(
    () => adapter.buildIndex(path.join(root, 'missing'), 'fixture'),
    (error: unknown) => error instanceof Error && error.message.includes('does not exist'),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('StaticAdapter rejects output overrides in decompile extra arguments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-'));
  const backend = path.join(root, 'gwxapkg.exe');
  await fs.writeFile(backend, 'fixture');
  const adapter = new StaticAdapter(mockConfig(root, backend));
  await assert.rejects(
    adapter.decompile({ inputPath: path.join(root, 'fixture.wxapkg'), projectName: 'fixture', extraArgs: ['-out=C:\\escape'] }),
    (error: unknown) => error instanceof Error && error.message.includes('cannot override'),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('StaticAdapter raw mode rejects caller-controlled output arguments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-static-'));
  const backend = path.join(root, 'gwxapkg.exe');
  await fs.writeFile(backend, 'fixture');
  const adapter = new StaticAdapter(mockConfig(root, backend));
  await assert.rejects(
    adapter.raw(['-out=C:\\escape'], 'fixture'),
    (error: unknown) => error instanceof Error && error.message.includes('cannot override'),
  );
  await fs.rm(root, { recursive: true, force: true });
});
