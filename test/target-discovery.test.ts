import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget } from '../src/runtime/target-discovery.js';

test('WMPF target parser identifies main and renderer metadata', () => {
  const main = parseTarget({
    ProcessId: 10,
    ParentProcessId: 2,
    ExecutablePath: String.raw`C:\Users\u\AppData\Roaming\Tencent\xwechat\xplugin\plugins\RadiumWMPF\19977\extracted\runtime\WeChatAppEx.exe`,
    CommandLine: '"WeChatAppEx.exe" --instance-index=0',
  });
  assert.equal(main?.version, 19977);
  assert.equal(main?.isMain, true);

  const renderer = parseTarget({
    ProcessId: 11,
    ParentProcessId: 10,
    ExecutablePath: main?.executablePath,
    CommandLine: '"WeChatAppEx.exe" --type=renderer --wmpf-render-type=4 --wmpf-appid=wx123',
  });
  assert.equal(renderer?.processType, 'renderer');
  assert.equal(renderer?.renderType, 4);
  assert.equal(renderer?.appId, 'wx123');
});
