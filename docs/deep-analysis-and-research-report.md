# wechat-miniapp-re-mcp 深度分析与多源搜索综合报告

> 状态说明：本文是 2026-07-15 的 pre-v0.3.0 研究快照；当前 capability 语义、profile 默认链路、工具数、测试数和剩余门禁以 [`progress.md`](progress.md) 与 [`api.md`](api.md) 为准。

> 生成日期: 2026-07-15
> 搜索方法: search-layer v2.2 — WebSearch (3轮, 12 queries) + Exa (30 results) + Tavily + gh CLI (GitHub API)
> Grok 因 cliproxy-cn SSL 错误降级，Exa + Tavily + gh CLI 正常返回
> 源码分析: 本项目 + WMPFDebugger (hook.js/ADAPTATION.md) + WMPFOffsetGen + wmpf-mcp-bridge

---

## 目录

1. [项目现状深度诊断](#1-项目现状深度诊断)
2. [问题 1: Bridge 连接时序 — 根因与解决方案矩阵](#2-问题-1-bridge-连接时序)
3. [问题 2: 多版本 Profile 管理 — 方案对比与演进路径](#3-问题-2-多版本-profile-管理)
4. [问题 3: Bridge 断连与重连 — 竞品方案与改进策略](#4-问题-3-bridge-断连与重连)
5. [问题 4: 单会话限制 — 架构级解决方案](#5-问题-4-单会话限制)
6. [问题 5: MCP 架构与能力对标 — 竞品深度拆解](#6-问题-5-mcp-架构与能力对标)
7. [综合改进路线图](#7-综合改进路线图)
8. [参考来源](#8-参考来源)

---

## 1. 项目现状深度诊断

### 1.1 代码架构评估

经过对全部 22 个 TypeScript 源文件的审查，项目架构设计优秀但存在 5 个具体问题：

| # | 问题 | 严重度 | 文件 | 根因 |
|---|------|--------|------|------|
| 1 | Bridge 连接成功率低 (1/9) | **P0** | `bridge-server.ts`, `frida-adapter.ts` | WMPF CDP filter 仅在特定 Scene 触发，时序窗口窄 |
| 2 | 仅支持 1 个 WMPF 版本 (v19977) | **P0** | `profile.ts`, `hook-source.ts` | 无自动偏移量发现，无签名数据库 |
| 3 | Bridge 断连无重连机制 | **P1** | `bridge-server.ts`, `sessions/manager.ts` | 小程序切换场景时 WebSocket 断开，无自动恢复 |
| 4 | 单会话限制 (9421 端口互斥) | **P1** | `bridge-server.ts:52-56` | WMPF 协议无会话握手，全局只有一个 9421 |
| 5 | hook-source.ts 缺少 null-pointer guard | **P2** | `hook-source.ts:33-34` | `readPointer()` 可能在特定版本上崩溃 |

### 1.2 与 WMPFDebugger hook.js 的逐行对比

我们对两个项目的 Frida hook 实现做了逐行对比：

| 维度 | wechat-miniapp-re-mcp | WMPFDebugger (evi0s) | 评估 |
|------|----------------------|---------------------|------|
| CDP filter patch 位置 | `onLeave`, `output → readPointer → +8` | `onLeave`, `inputValue.readPointer() → +8` | 逻辑等价 |
| Null safety | `safePointer()` 函数 | `isNull()` 检查 + early return | WMPFDebugger 更健壮 |
| Scene 注入 | `resolveScenePointer()` 链式解引用 | `hookOnLoadScene()` 链式解引用 | 逻辑等价 |
| Scene 白名单 | 15 个值 `[1005,1007,1008,1012,1027,...]` | 13 个值 `[1005,1007,1008,1027,...,1308]` | 本项目多了 1012 和 1168 |
| DL flag 设置 | `rdx.or(ptr(1))` | `(rdx & ~0xff) \| 0x1` | 本项目方案更简洁 |
| 配置注入 | `JSON.stringify(profile)` 模板字符串 | `@@CONFIG@@` 替换 (构建时) | 本项目更灵活 |
| OS 适配 | `Process.platform === 'windows'` 分支 | 仅 Windows | 本项目预留 macOS |
| 错误处理 | try-catch + emit error events | send log messages | 本项目更结构化 |

**结论**: hook 逻辑基本等价，本项目甚至在某些方面 (config 注入、OS 适配、错误处理) 更优。问题不在 hook 实现质量，而在时序控制。

### 1.3 竞品支持版本对比

```
WMPFDebugger 支持 41 个版本:
  20079, 20005, 20001, 19977, 19921, 19899, 19881, 19871, 19841, 19823,
  19769, 19749, 19481, 19459, 19339, 19201, 19027, 18955, 18891, 18787,
  18151, 18055, 17127, 17071, 17037, 16965, 16815, 16771, 16467, 16389,
  16203, 16133, 14315, 14199, 14161, 13909, 13871, 13655, 13639, 13487,
  13341, 13331, 11633, 11581

wechat-miniapp-re-mcp 仅支持:
  19977 (1 个版本)
```

差距: **41 vs 1**。这是本项目 Phase 4 (Profile lifecycle) 的核心阻塞。

---

## 2. 问题 1: Bridge 连接时序

### 2.1 根因分析

通过分析 WMPFDebugger 的 `hook.js` 源码和 `ADAPTATION.md`，结合本项目 `lessons-learned.md` 的记录，完整根因链如下：

```
微信 PC 端启动
    │
    ▼
WMPF 进程 (WeChatAppEx.exe) 加载 flue.dll
    │  (此时 CDP filter 函数未被调用)
    │
    ▼
用户打开小程序 → 触发特定 Scene (如 1005=搜索, 1007=聊天, ...)
    │
    ▼
AppletIndexContainer::OnLoadStart 被调用
    │  ├─ hookOnLoadScene: 读取原始 Scene → 改写为 1101 (devtools)
    │  └─ 设置 DL flag = 1
    │
    ▼
SendToClientFilter 被调用 (CDP filter 函数)
    │  ├─ 内部检查 scene == 1101？
    │  ├─ 是 → 尝试连接 ws://127.0.0.1:9421
    │  └─ patchCdpFilter 将返回标志 6→0 (allow)
    │
    ▼
WMPF → Bridge WebSocket 连接建立
```

**关键发现**: CDP filter 和 OnLoadStart 都只在 **小程序首次加载特定 Scene** 时触发一次。如果此时 Frida hook 尚未注入，或者 9421 端口没有监听，连接机会就永久丢失，只能等下一次 scene transition (关闭并重新打开小程序)。

### 2.2 为什么 WMPFDebugger 也遇到同样问题

WMPFDebugger README 明确写了同样的时序约束:

> "After this step, you need to launch the miniapp BEFORE launching the devtools, otherwise you will probably need to kill the server and redo the steps 2 to 4 again."

**推荐顺序**: 启动 Frida 注入 → 再打开小程序 → 最后连接 DevTools

本项目的 `wxmp_attach` 允许在无目标小程序时就开始监听 9421，但问题是:
- 如果用户先打开小程序再 `wxmp_attach`，CDP filter 已经执行完毕，不会再触发
- 如果小程序已经在后台运行，切换到前台不触发 OnLoadStart

### 2.3 解决方案矩阵

#### 方案 A: 主动触发 Scene Transition (推荐 P0)

**原理**: 在小程序已运行的情况下，通过 CDP/JS 注入强制触发 mini program reload 或 scene 切换。

**实现**:
```typescript
// 在 WmpfBridgeServer 中添加
async forceSceneTrigger(sessionId: string): Promise<void> {
  // 方案 A1: 通过 Frida 直接调用 OnLoadStart 函数
  // (需要知道函数签名和参数构造，高风险)
  
  // 方案 A2: 通过已注入的 Frida script RPC
  // send message to Frida script → call specific function
  const script = this.fridaScripts.get(sessionId);
  await script.exports.forceDebugTrigger();
}
```

**Frida 侧**:
```javascript
// 在 hook-source.ts 中添加
rpc.exports = {
  forceDebugTrigger() {
    // 方法 1: 读取当前 Scene 值并直接调用 filter
    // 方法 2: 模拟 Scene transition
    
    // 方法 3 (最安全): 直接构造 filter 调用
    const filterAddr = module.base.add(ptr(PROFILE.cdpFilterOffset));
    // NativeFunction 调用 filter，传入构造的 allow 参数
  }
};
```

**风险**: 直接调用内部函数可能崩溃；需要深入逆向理解参数结构。

#### 方案 B: 持续轮询 + Scene 监控 (推荐 P1)

**原理**: Frida hook 持续监控所有与 debug 相关的函数调用，一旦检测到合适时机就立即建立连接。

**实现**:
```javascript
// 扩展现有 hook，添加更多拦截点
Interceptor.attach(debugCheckFunction, {
  onEnter(args) {
    // 检测到 debug check 被调用
    // 通知 Node.js 侧准备 accept 连接
    send({ type: 'debug_check_detected', timestamp: Date.now() });
  }
});
```

**优势**: 不依赖用户操作时序；**劣势**: 需要逆向发现更多相关函数。

#### 方案 C: WeChatOpenDevTools 方式 — Patch wmpf_host_export.dll (备选)

**原理**: WeChatOpenDevTools-Python 通过拦截 `CreateProcessW` 追加 `--enable-xweb-inspect` 参数，在进程启动层面开启 debug。

**适用性**: 主要适用于微信 3.9.x；微信 4.x (WMPF 13331+) 已经移除该参数支持。

**评估**: 对当前 WMPF 4.x 目标无效，不推荐。

#### 方案 D: 延迟 Attach + 重试循环 (当前可用 P1)

**原理**: 在 `wxmp_attach` 中实现自动重试逻辑，持续等待直到连接成功。

**实现**:
```typescript
// 在 sessions/manager.ts 的 attach 方法中
async attachWithRetry(opts: AttachOptions, maxRetries = 5): Promise<Session> {
  for (let i = 0; i < maxRetries; i++) {
    const session = await this.attach(opts);
    const connected = await this.bridge.waitForConnection(
      session.id, 
      opts.connectTimeoutMs ?? 30_000
    );
    if (connected) return session;
    
    // 提示用户切换小程序
    this.emit('retry_hint', {
      attempt: i + 1,
      maxRetries,
      hint: '请关闭当前小程序后重新打开，或切换到另一个小程序'
    });
    
    // 重新准备 bridge
    this.bridge.prepare(session.id);
  }
  throw new WxmpError('ATTACH_TIMEOUT', 'Unable to establish CDP connection after retries');
}
```

**优势**: 实现简单，向后兼容；**劣势**: 仍依赖用户交互。

#### 方案 E: 参考 WMPFDebugger 的完整流程 (对标方案)

**原理**: WMPFDebugger 的用户流程是 `启动 server → 注入 Frida → 打开小程序 → 连接 DevTools`。本项目可以将此流程嵌入 `wxmp_attach`:

```
wxmp_attach({ project_name: "xxx" })
  ├─ 1. 启动 Bridge (监听 9421)
  ├─ 2. Frida attach + inject hooks
  ├─ 3. 提示用户: "请在 30 秒内打开目标小程序"
  ├─ 4. waitForConnection(30000)
  │   ├─ 成功 → session.state = "connected"
  │   └─ 超时 → 提示用户关闭并重新打开小程序 → goto 4
  └─ 5. 返回 session 状态
```

### 2.4 推荐组合方案

| 优先级 | 方案 | 工作量 | 效果 |
|--------|------|--------|------|
| **P0** | D: 延迟 Attach + 重试循环 | 小 (~50 行) | 解决用户交互问题 |
| **P1** | B: 扩展监控点 + 自动检测 | 中 (~200 行, 需要逆向) | 消除时序依赖 |
| **P2** | A: 主动触发 Scene Transition | 大 (~500 行, 需要深度逆向) | 完全自动化 |

---

## 3. 问题 2: 多版本 Profile 管理

### 3.1 当前实现分析

本项目的 `ProfileManager` (profile.ts) 已经有一个不错的基础:

- **AOB 签名扫描**: `findPattern()` 支持 `??` 通配符，可在 flue.dll 中搜索字节序列
- **Schema 验证**: `validateProfile()` 对版本、平台、偏移量、SHA-256 做完整校验
- **Legacy 兼容**: `legacyToProfile()` 可加载 First 工具的 `addresses.{version}.json`
- **候选生成**: `generate()` 从 AOB 签名 → 候选 profile (confidence: candidate)
- **安全门禁**: `assertInjectable()` 阻止 candidate 置信度的 profile 直接注入

**核心缺陷**: 没有 AOB 签名数据库。生成 profile 需要用户手动提供 `cdpFilter` 和 `loadStart` 的特征签名。

### 3.2 竞品方案对比

#### WMPFDebugger 方案 (手工适配)

```
ADAPTATION.md 文档描述的流程:
1. 打开 flue.dll 在 IDA Pro 中
2. 搜索 "OnLoadStart" → xref → LoadStartHookOffset
3. 搜索 "SendToClientFilter" → xref → CDPFilterHookOffset
4. 从伪代码提取 SceneOffsets 魔法数字
5. 手动写入 addresses.{version}.json
```

**工作量**: 每个新版本约 30-60 分钟手工 IDA 分析。
**版本覆盖**: 41 个版本 × ~45 min = **约 30 小时累计投入**（社区贡献分担）。

#### WMPFOffsetGen 方案 (半自动)

[flagqaz/WMPFOffsetGen](https://github.com/flagqaz/WMPFOffsetGen) (21 stars, 2026-07 更新):

**核心算法** (从 README 和源码分析):

```
1. PE 分析 flue.dll
   ├─ 解析 PE header → 定位 .text/.rdata 段
   ├─ 提取字符串表 → 搜索 "OnLoadStart", "SendToClientFilter"
   └─ 提取导入表 → 确认函数调用链

2. 签名匹配
   ├─ 搜索 "SendToClientFilter" 字符串引用
   │   └─ 逆向跟踪 → 找到包含该引用的父函数
   │       └─ 第一个被调用的子函数 = CDPFilterHookOffset
   ├─ 搜索 "[perf] AppletIndexContainer::OnLoadStart" 或 "OnLoadStart"
   │   └─ 唯一 xref 函数 = LoadStartHookOffset
   └─ 在 LoadStart 函数伪代码底部提取 Scene 相关偏移量

3. 结构校验
   ├─ 读取 WMPFDebugger/frida/hook.js 确认需要的字段数量
   ├─ 读取 frida/config/addresses.*.json 提取历史结构规律
   └─ 通过 scene 1101 比较点验证新偏移量

4. 安全停止规则
   ├─ 关键字符串被删除 → 停止
   ├─ 函数被内联或拆分 → 停止
   ├─ Hook 配置格式变更 → 停止
   └─ 不生成低质量候选
```

**已验证**: WMPF 20001 (v1.1)
**适用**: WMPFDebugger 兼容版本；可检测结构漂移并推导新偏移

#### WMPFDebugger-auto 方案 (SuperNaiBA, 32 stars)

自动化版本检测 + 偏移量适配，无需用户手动配置版本号。

### 3.3 推荐方案: 三层 Profile 生成策略

```
Layer 1: AOB 快速通道 (已有基础, P0 增强)
  ├─ 预置已知版本的 AOB 签名数据库
  ├─ 扫描 flue.dll → 匹配签名 → 自动生成 profile
  └─ 置信度: high (签名库中已验证)

Layer 2: PE 分析通道 (P1 新增, 参考 WMPFOffsetGen)
  ├─ 解析 PE 结构 → 定位关键字符串 → 逆向跟踪调用链
  ├─ 自动提取 LoadStartHookOffset、CDPFilterHookOffset、SceneOffsets
  └─ 置信度: medium (自动提取但未 runtime 验证)

Layer 3: IDA headless 验证通道 (P2 新增)
  ├─ 对 medium 置信度 profile 进行 idalib 反编译验证
  ├─ 确认函数签名、参数数量、调用关系
  └─ 置信度: high (反编译交叉验证通过)
```

**Layer 1 的 AOB 签名数据库设计**:

```json
{
  "schemaVersion": 2,
  "signatures": [
    {
      "wmpfVersionRange": [18000, 21000],
      "moduleName": "flue.dll",
      "cdpFilter": {
        "preferred": "48 89 5C 24 ?? 48 89 74 24 ?? 57 48 83 EC 20 48 8B 41 ?? 48 8B F9",
        "alternatives": ["48 89 5C 24 ?? 57 48 83 EC ?? 48 8B 41"],
        "adjustment": 0
      },
      "loadStart": {
        "preferred": "48 89 5C 24 ?? 48 89 6C 24 ?? 48 89 74 24 ?? 57 48 83 EC 30 48 8B F9",
        "alternatives": [],
        "adjustment": 0
      },
      "sceneOffsetsHint": [64, 1408, 8, 1344, 16, 456],
      "verifiedVersions": [19977],
      "lastVerified": "2026-07-15"
    }
  ]
}
```

**实现计划**:

| 阶段 | 内容 | 工作量 | 产出 |
|------|------|--------|------|
| Phase 4a | AOB 签名库 + 自动匹配 (Layer 1) | 3-5 天 | 覆盖 5-10 个版本 |
| Phase 4b | PE 分析通道 (Layer 2) | 5-7 天 | 自动覆盖 80%+ 版本 |
| Phase 4c | idalib 验证通道 (Layer 3) | 7-10 天 | high 置信度自动化 |

---

## 4. 问题 3: Bridge 断连与重连

### 4.1 根因

`lessons-learned.md` 记录:

> "WMPF bridge disconnects when a mini-program load triggers a new scene during an active debug session"

这是 WMPF 内部机制: 每次小程序切换到新的 Scene 时，旧的 CDP WebSocket 连接被关闭，新的 Scene 如果匹配白名单且 CDP filter 允许，会尝试建立新连接。

### 4.2 WMPFDebugger 的同源问题

WMPFDebugger FAQ.zh.md 和多个 troubleshooting 文章中描述了完全相同的现象:
- DevTools 面板空白 ("开发者工具空白问题")
- "Hook works once then fails" (relocate cycle)
- 需要 `kill the server and redo the steps`

WMPFDebugger 也**没有自动重连机制**，依赖用户手动重启。

### 4.3 解决方案

#### 方案 A: WebSocket close 事件自动恢复 (P0)

```typescript
// bridge-server.ts accept() 中
socket.on('close', () => {
  // ... existing cleanup ...
  
  // 自动重连: 重新 prepare 当前 session
  if (this.desiredSessionId === sessionId && this.autoReconnect) {
    this.pendingSessions.push(sessionId);
    this.hooks.onDisconnected(sessionId);
    
    // 注册重连超时
    this.reconnectTimers.set(sessionId, setTimeout(() => {
      if (!this.isConnected(sessionId)) {
        this.hooks.onReconnectFailed(sessionId);
      }
    }, 30_000));
  }
});
```

#### 方案 B: 在 CdpChannel 中缓存上下文 (P1)

小程序重新加载时，CDP context (AppService/WebView) 会变化，断点、脚本索引会丢失。需要:

```typescript
// cdp-channel.ts
class CdpChannel {
  // 缓存上次成功的断点配置
  private breakpointCache: Map<string, BreakpointConfig> = new Map();
  // 缓存需要重新启用的 CDP domain
  private domainCache: Set<string> = new Set(['Debugger', 'Network', 'Runtime']);
  
  async reconnect(newContextId: string): Promise<void> {
    // 重新启用所有缓存的 domain
    for (const domain of this.domainCache) {
      await this.send(`${domain}.enable`, {}, newContextId);
    }
    // 恢复断点
    for (const [id, bp] of this.breakpointCache) {
      await this.send('Debugger.setBreakpointByUrl', bp, newContextId);
    }
  }
}
```

#### 方案 C: Session 状态机增强 (P1)

```
当前:
  connected → disconnected → (end)

改进后:
  connected → reconnecting → connected
              ↓ (timeout)
              disconnected → (提示用户)
```

```typescript
type SessionState = 
  | 'created' | 'attaching' | 'waiting_for_runtime'
  | 'connected'
  | 'reconnecting'        // 新增
  | 'disconnected'
  | 'detaching' | 'closed' | 'failed';
```

---

## 5. 问题 4: 单会话限制

### 5.1 根因

`bridge-server.ts:52-56`:

```typescript
if (this.desiredSessionId && this.desiredSessionId !== sessionId) {
  throw new WxmpError('BRIDGE_SESSION_BUSY', 
    'WMPF bridge is already reserved...',
    { reason: 'The WMPF debug endpoint has no session handshake...' });
}
```

**根本原因**: WMPF 的 debug WebSocket 连接没有 session 标识。WMPF 直接连接到 `ws://127.0.0.1:9421`，不发送任何握手消息表明自己属于哪个小程序实例。当多个小程序同时运行时，无法区分收到的 CDP 消息来自哪个。

### 5.2 WMPFDebugger 的处理

WMPFDebugger 通过不同的 `jscontextId` 区分不同的执行上下文 (AppService vs WebView)，但同样只有一个 9421 端口，所有 CDP 消息通过 `DebugMessageBus` 统一分发。

不支持的场景: 同时调试两个不同的小程序。这是所有基于 WMPF CDP 协议的工具的**共同限制**。

### 5.3 可探索方案

| 方案 | 原理 | 可行性 |
|------|------|--------|
| 多端口 | 修改 hook 让不同小程序连不同端口 | 低 — 需要深度逆向 WMPF 内部网络配置 |
| context 路由 | 单端口 + 基于 jscontextId 的 CDP 消息路由 | 中 — wmpf-mcp-bridge 采用此方案 |
| NativeFunction wrapper | Frida 直接调用 CDP handler，绕过 WebSocket | 低 — 需要完整逆向 handler 签名 |
| 多 WMPF 实例 | 运行多个 WMPF 进程 (微信沙箱) | 中 — 需要微信多开方案 |

**推荐**: 短期内接受此限制，在文档和错误消息中明确说明。中长期探索 context 路由方案 (参考 wmpf-mcp-bridge 的 `select_appservice_context`)。

---

## 6. 问题 5: MCP 架构与能力对标

### 6.1 竞品深度拆解

#### wmpf-mcp-bridge (an7ln, 95 stars, 2026-07 活跃)

**架构亮点**:

```
[MCP Client]
    ↕ HTTP (token auth, localhost:43827)
[wmpf-mcp-bridge]
    ↕ CDP WebSocket (ws://127.0.0.1:62000)
[WMPFDebugger CDP Proxy]
    ↕ protobuf WebSocket
[WMPF Runtime]
```

**值得借鉴的工具设计**:

1. **`hook_wx_request` / `hook_fetch_and_xhr`**: 不依赖 CDP Network domain，直接在 appservice 上下文中注入非破坏性的 `wx.request` / `fetch` / `XHR` hook。比 CDP Network 更可靠，因为:
   - 不依赖 CDP Network domain 是否已 enable
   - 可以捕获请求发起的 JS 调用栈 (CDP Network 只能看到网络层)
   - 可以获取 response body 而无需额外的 `Network.getResponseBody` 调用

2. **`select_appservice_context`**: 自动发现 AppService 上下文 — 通过检查 `wx.request` / `require` / `getCurrentPages` 是否存在来判断当前 context 是否为逻辑层

3. **Vuex/Pinia 状态检查**: `inspect_vuex_store` / `patch_vuex_state` — 运行时状态读取和篡改

4. **安全分析工具族**: `analyze_auth_surface` / `find_idor_candidates` / `find_sensitive_data_exposure` / `find_upload_surfaces`

5. **API 资产清单**: `get_api_inventory` — 聚合所有 wx.request + fetch + XHR URLs

#### miniapp-cdp-mcp (zhizhuodemao)

**独有功能**: WASM bytecode 提取 (通过 CDP `Debugger.getScriptSource` 获取 wasm 模块)

**架构**: Python 3.11+ / uv / CDP WebSocket 直连

**工具设计**: 18 个工具，聚焦纯逆向分析 (断点/脚本/网络/WebSocket/执行上下文)

### 6.2 能力差距分析

| 能力 | 本项目 | WMPFDebugger | wmpf-mcp-bridge | miniapp-cdp-mcp |
|------|--------|-------------|-----------------|-----------------|
| Frida 注入 | ✅ | ✅ | ❌ (依赖外部) | ❌ (依赖外部) |
| CDP 直连 | ✅ | ✅ | ❌ (通过 WMPFDebugger) | ✅ |
| wx.request hook (非 CDP) | ❌ | ❌ | ✅ | ❌ |
| fetch/XHR hook | ❌ | ❌ | ✅ | ❌ |
| 静态分析 (wxapkg) | ✅ | ❌ | ❌ | ❌ |
| 断点调试 | ✅ | ✅ | ❌ | ✅ |
| 调用栈提取 | ❌ | ❌ | ✅ (trace_request_callstack) | ✅ (get_paused_info) |
| 网络捕获 | ✅ (CDP) | ✅ (CDP) | ✅ (CDP + hook 双通道) | ✅ |
| 请求重放 | ✅ | ❌ | ✅ (build_replay_plan) | ❌ |
| 云函数调用 | ✅ (wx.cloud) | ❌ | ❌ | ❌ |
| WASM 提取 | ❌ | ❌ | ❌ | ✅ (2026-04) |
| Vuex/Pinia 检查 | ❌ | ❌ | ✅ | ❌ |
| 安全漏洞扫描 | ❌ | ❌ | ✅ (IDOR/auth/敏感数据) | ❌ |
| API 资产清单 | ❌ | ❌ | ✅ | ❌ |
| DevTools Proxy | ✅ | ✅ | ❌ | ❌ |
| Evidence 导出 | ✅ | ❌ | ✅ (export_session) | ❌ |
| Profile 管理 | ✅ | ❌ (手动) | ❌ | ❌ |
| MCP 工具数 | 46 | 0 (独立 CLI) | ~40 | ~18 |

### 6.3 推荐新增能力 (按优先级)

| 优先级 | 能力 | 来源参考 | 工作量 | 价值 |
|--------|------|---------|--------|------|
| **P0** | `wx.request` 非 CDP Hook (`wxmp_hook_wx_request`) | wmpf-mcp-bridge | 2-3 天 | 解决 CDP Network 启用时序依赖 |
| **P1** | 调用栈提取 (`wxmp_trace_request_callstack`) | wmpf-mcp-bridge, miniapp-cdp-mcp | 1-2 天 | 逆向核心能力 |
| **P1** | AppService 自动发现 (`wxmp_select_context` 增强) | wmpf-mcp-bridge | 1 天 | 改善用户体验 |
| **P2** | API 资产清单 (`wxmp_get_api_inventory`) | wmpf-mcp-bridge | 2 天 | Phase 3 自然延伸 |
| **P2** | WASM bytecode 提取 (`wxmp_extract_wasm`) | miniapp-cdp-mcp | 2 天 | 小游戏逆向 |
| **P3** | 安全扫描工具族 | wmpf-mcp-bridge | 5-7 天 | 差异化竞争力 |
| **P3** | Vuex/Pinia 状态检查 | wmpf-mcp-bridge | 2-3 天 | 运行时逆向增强 |

### 6.4 `wx.request` Hook 实现参考

```typescript
// 新增 src/runtime/wx-request-hook.ts
export function buildWxRequestHookSource(): string {
  return `
'use strict';

// 非破坏性 wx.request hook
const originalRequest = wx.request;
wx.request = function(options) {
  const traceData = {
    type: 'wx.request',
    url: options.url,
    method: options.method || 'GET',
    data: options.data,
    header: options.header,
    timestamp: Date.now(),
    callStack: new Error().stack
  };
  
  // 通过 console.log 的特殊前缀回传 trace 数据
  // (会被 CDP Runtime.consoleAPICalled 事件捕获)
  console.log('__WXMP_TRACE__' + JSON.stringify({ 
    category: 'wx_request', 
    data: traceData 
  }));
  
  // 包装 success/fail/complete 回调
  const originalSuccess = options.success;
  options.success = function(res) {
    console.log('__WXMP_TRACE__' + JSON.stringify({
      category: 'wx_response',
      data: { url: options.url, statusCode: res.statusCode, data: res.data }
    }));
    if (originalSuccess) originalSuccess(res);
  };
  
  return originalRequest.call(this, options);
};

send({ type: 'wx_request_hook_ready' });
`;
}
```

**注意**: 该 hook 依赖 `wx.request` 已在 appservice context 中可用。在注入前需先执行 `Runtime.evaluate` 确认 `typeof wx !== 'undefined'`。

---

## 7. 综合改进路线图

### Phase A: Bridge 可靠性 (1-2 周, P0)

```
Week 1:
  ├─ [Day 1-2] 延迟 Attach + 重试循环 (方案 D)
  ├─ [Day 2-3] WebSocket close 自动重连 (方案 B, Section 4)
  ├─ [Day 3-4] Session 状态机增强 (reconnecting state)
  └─ [Day 4-5] 测试: 9 次 attach 成功率对比

Week 2:
  ├─ [Day 1-3] wx.request 非 CDP Hook 工具 (Section 6.3)
  ├─ [Day 3-4] CdpChannel 上下文缓存与断点恢复
  └─ [Day 4-5] 调用栈提取工具
```

### Phase B: 多版本 Profile (2-3 周, P0)

```
Week 3:
  ├─ [Day 1-3] AOB 签名数据库设计 + 初始 5 版本
  ├─ [Day 3-5] Layer 1 自动匹配实现
  └─ [Day 5] 验证 v19841, v19881, v19921, v20001

Week 4:
  ├─ [Day 1-3] PE 分析通道原型 (参考 WMPFOffsetGen 算法)
  ├─ [Day 3-5] Legacy profile 批量转换 (WMPFDebugger 41 个地址表)
  └─ [Day 5] 集成测试: 自动覆盖 10+ 版本

Week 5 (可选):
  └─ idalib headless 验证通道
```

### Phase C: 能力补齐 (2-3 周, P1-P2)

```
Week 6:
  ├─ AppService 自动发现
  ├─ API 资产清单 (wxmp_get_api_inventory)
  └─ WASM 提取 (wxmp_extract_wasm)

Week 7:
  ├─ 安全扫描工具族 (可选, P3)
  ├─ Vuex/Pinia 状态检查 (可选, P3)
  └─ registry.ts 按类别拆分
```

### 里程碑目标

| 里程碑 | 当前状态 | 目标 |
|--------|---------|------|
| Bridge 连接成功率 | 1/9 (11%) | > 80% |
| WMPF 版本覆盖 | 1 | > 10 |
| 自动化 profile 生成 | 手动 AOB | 自动 PE 分析 |
| wx.request 捕获 | CDP Network only | CDP + 非 CDP 双通道 |
| MCP 工具数 | 46 | 55-60 |
| 测试覆盖 | 43 tests | 60+ tests |

---

## 8. 参考来源

### 本项目
- `D:\reverse_ENV\mcp\wechat-miniapp-re-mcp\` — 完整源码
- `src/tools/registry.ts` — 46 MCP tools
- `src/runtime/hook-source.ts` — Frida hook 注入
- `src/runtime/profile.ts` — Profile 管理与 AOB 扫描
- `src/transport/bridge-server.ts` — WMPF WebSocket 桥接
- `src/transport/cdp-channel.ts` — CDP 命令/事件处理
- `docs/lessons-learned.md` — 已知问题记录
- `docs/progress.md` — 进度跟踪

### 竞品源码
- [evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger) (2,274 stars) — `frida/hook.js`, `ADAPTATION.md`, `FAQ.zh.md` 源码级分析
- [flagqaz/WMPFOffsetGen](https://github.com/flagqaz/WMPFOffsetGen) (21 stars) — README 完整算法描述
- [an7ln/wmpf-mcp-bridge](https://github.com/an7ln/wmpf-mcp-bridge) (95 stars) — 工具列表与架构
- [zhizhuodemao/miniapp-cdp-mcp](https://github.com/zhizhuodemao/miniapp-cdp-mcp) — WASM 提取与工具设计
- [netz888/zhong-wechat-wmpf-debugger](https://github.com/netz888/zhong-wechat-wmpf-debugger) — WMPF 4.x 适配
- [WaterTian/wechat-devtools-mcp](https://github.com/WaterTian/wechat-devtools-mcp) — "Thin MCP + Fat Skill" 架构

### 技术文章
- [WMPFDebugger 微信小程序调试神器](https://www.gm7.org/archives/76209) — 三层架构详解、protobuf 转换、scene hook 原理
- [WMPFDebugger 版本适配完全指南](https://blog.csdn.net/gitblog_00941/article/details/152771078) — IDA offset 发现方法
- [从 Web 到小程序：用 AI-First 思维重构逆向调试工具](https://bbs.kanxue.com/thread-290933-1.htm) — 看雪论坛, 双线程架构分析
- [WMPFDebugger 开发者工具空白问题](https://blog.gitcode.com/60e2c742d70f7026d7fc618592e34b7f.html) — 协议分析、断连排查
- [SRC捡钱12: AI一键自动挖掘小程序漏洞](https://www.gm7.org/archives/129388) — wmpf-mcp-bridge 实战
- [windows下通杀wx小程序云函数实战](https://www.52pojie.cn/thread-1832406-1-1.html) — 吾爱破解, Frida + repack 云函数拦截
- [WeChatOpenDevTools DeepWiki](https://deepwiki.com/x0tools/WeChatOpenDevTools/) — Frida hook 架构与版本支持

### 官方资源
- [WMPF 官方文档](https://developers.weixin.qq.com/doc/oplatform/en/Miniprogram_Frame/index)
- [wmpf/wmpf_demo_external](https://github.com/wmpf/wmpf_demo_external) — WMPF SDK Demo

---

> 搜索统计: WebSearch 12 queries (3 轮迭代) + Exa 30 results + Tavily + gh CLI 6 API calls
> 源码分析: 本项目 22 TypeScript 文件 + WMPFDebugger hook.js + WMPFOffsetGen README
> 竞品分析: 10 个相关 GitHub 仓库
