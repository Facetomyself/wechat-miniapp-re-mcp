# 后续完善路线图

> 状态：当前后续规划的 canonical source。
>
> 最近更新：2026-07-18
>
> 适用基线：`main` / `0.3.1` / commit `26ef996`

当前实施状态：

- [x] `data/acceptance` schema、v19977/v20079 records 与 hash/depth checker；
- [x] package/source/build version、README tool count、`docs/api.md` tool inventory drift gate；
- [x] tracked `scripts/live-semantic-gate.mjs`、dry-run/路径门禁/结构化失败 evidence；
- [ ] v19977 新 runner 的完整 repeat pass（2026-07-18 当前尝试因 lifecycle 未触发停在 `runtimeBridge`，failure evidence 已闭环）；
- [ ] v20079 真实 target 与 3 次完整 semantic gate。

## 1. 目标

项目下一阶段不再以“继续增加 MCP tool 数量”为主目标，而是把现有动态调试、静态分析、Profile 和 evidence 四条链做成可重复验收、契约稳定、便于 Agent 使用且长期可维护的产品。

路线图遵循以下顺序：

1. 先让验收事实可重复、可机器读取；
2. 再补 MCP contract 与调试器高频缺口；
3. 然后做静态/动态证据关联与 Profile 外部适配；
4. 最后收口发布、兼容性和跨平台能力。

## 2. 当前基线

### 2.1 已确认事实

| 维度 | 当前状态 | 证据 |
|---|---|---|
| MCP surface | `53` 个 `wxmp_*` tools | `npm run contract` / `npm run smoke` |
| 自动化测试 | `92` tests，全部通过 | `npm run check` |
| 代码覆盖率 | Node.js 22 下 overall line `72.16%`（已包含 tracked acceptance/live scripts） | `node --experimental-test-coverage --test ...` |
| 关键低覆盖模块 | `sessions/manager.js` `14.75%`；`frida-adapter.js` `10.34%`；`dynamic.js` `54.11%` | Node.js 22 coverage report |
| 动态链 | WMPF v19977 完整 semantic gate 已通过 | [`progress.md`](progress.md) |
| 第二版本 | WMPF v20079 Profile/AOB/hash/attach/detach 已通过，完整 semantic gate 未完成 | [`progress.md`](progress.md) |
| 静态链 | subprocess decompile/search/index/repack 与失败门禁已通过 | `test/static-adapter.test.ts` |
| CI | Windows Node.js 20/22，最近 Actions 全绿 | [GitHub Actions](https://github.com/Facetomyself/wechat-miniapp-re-mcp/actions) |
| 依赖审计 | production vulnerabilities `0` | `npm audit --omit=dev`，2026-07-18 |
| 发布 | 无 Git tag、无 GitHub Release | Git/GitHub repository metadata |

### 2.2 当前事实源层级

后续维护按下面的优先级处理冲突：

1. 代码、自动化测试和真实 target evidence；
2. [`progress.md`](progress.md) 的 acceptance 状态；
3. 本文的后续路线图；
4. [`plan.md`](plan.md) 与 [`original-plan.md`](original-plan.md) 的历史交付决策；
5. [`deep-analysis-and-research-report.md`](deep-analysis-and-research-report.md) 的 2026-07-15 研究快照。

旧研究报告中的 `46 tools`、`43 tests`、缺少 request hook/API inventory、无 reconnect 等描述已经过期，不得再作为当前 backlog。

## 3. 外部对标结论

检索路径：先运行 `search-layer` 的 Exa/Tavily/Grok deep search，再通过 `gh` 直接核验仓库元数据、README、源码和官方 MCP SDK 文档。未使用并行子代理；本次工作围绕单一子仓的代码、验收和文档一致性，拆分会增加重复取证。

元数据截至 2026-07-18：

| 项目 | Stars / Forks | License | 可借鉴能力 | 不直接复制的原因 |
|---|---:|---|---|---|
| [evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger) | 2307 / 517 | GPL-2.0 | WMPF hook、版本适配样本、CDP bridge 行为 | GPL 与第三方代码边界；本项目保持 clean-room core |
| [an7ln/wmpf-mcp-bridge](https://github.com/an7ln/wmpf-mcp-bridge) | 97 / 13 | MIT | appservice 选择、request initiator、运行时快照、分析工作流 | 大量 `find_*` 是高层启发式，适合 skill，不宜继续膨胀 MCP core |
| [zhizhuodemao/miniapp-cdp-mcp](https://github.com/zhizhuodemao/miniapp-cdp-mcp) | 108 / 25 | MIT | XHR breakpoint、调用栈/作用域、WebSocket、WASM 保存 | 依赖外部 CDP endpoint；本项目仍需保留自带 WMPF attach/Profile 链 |
| [flagqaz/WMPFOffsetGen](https://github.com/flagqaz/WMPFOffsetGen) | 23 / 4 | 未声明 | 严格停止、scene 链推导、历史结构交叉校验 | 不应把 GUI/.NET/第三方规则直接嵌入 MCP；应定义 candidate import contract |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 12877 / 1988 | Other | structured output、tool annotations、in-process/stdio 测试、v2 migration | v2 当前为 `2.0.0-beta.4`，不宜在核心验收未闭环时抢跑迁移 |
| [modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector) | 10398 / 1418 | Other | stdio CLI smoke 与交互调试 | 仅作为开发/CI 工具，不引入生产 daemon |
| [modelcontextprotocol/conformance](https://github.com/modelcontextprotocol/conformance) | 79 / 62 | Other | specification conformance scenarios | server runner 当前偏 HTTP；需 test-only adapter 评估，不能改变 stdio-only 产品边界 |

对标后的核心判断：

- 不追求把竞品所有安全扫描工具搬进来；MCP 提供稳定原语与结构化证据，skill 负责 IDOR/auth/sign 等分析编排。
- 不把 PE/IDA/Profile 自动提取器塞入 MCP core；`wmpf-offset-adaptation` 或其他 extractor 生成 candidate，MCP 负责导入、校验、review、promotion 和 runtime gate。
- 不把“连上 9421”当成能力成功；CDP domain、AppService、trace、request hook、replay 继续分别验收。

## 4. 优先级总览

| 优先级 | 主题 | 目标版本 | 结果 |
|---|---|---|---|
| P0 | 第二版本 semantic gate 与 live harness | `0.3.2` | 当前能力从单次事实变成可重复验收 |
| P0 | 文档/版本/工具清单事实源治理 | `0.3.2` | 消除旧数字、旧结论和版本漂移 |
| P1 | MCP structured contract 与 annotations | `0.4.0` | Agent 更容易正确调用，客户端可识别读写/破坏性 |
| P1 | Debugger 高频原语 | `0.4.0` | 调用栈、作用域、XHR breakpoint、WebSocket、WASM 闭环 |
| P1 | Evidence 分层与脱敏 | `0.4.0` | 兼顾本地取证完整性和安全导出 |
| P1 | 静态/动态关联与 Profile candidate import | `0.5.0` | 形成区别于纯 CDP MCP 的完整逆向闭环 |
| P2 | 架构拆分、覆盖率和跨平台 CI | `0.5.x` | 降低状态机、Frida 和大型 tool 文件的维护风险 |
| P2 | Release/compatibility discipline | `1.0.0-rc` | 可回滚、可追踪、可对外复现 |
| 条件项 | macOS runtime、MCP SDK v2 正式迁移 | 独立里程碑 | 只在真实环境和上游稳定后推进 |

## 5. Phase R0：验收与事实源收口（P0，目标 `0.3.2`）

### R0.1 可重复 live semantic gate

交付：

- 新增可脚本化的 live gate runner，按固定序列执行：target discovery → attach → runtime wait → context probe/select → evaluate → real breakpoint → trace → request hook → Network body → replay → disconnect/reconnect → evidence export → detach。
- 每一步输出 `pending/passed/failed/skipped`，记录耗时、WMPF version、module SHA-256、profile provenance、session/context ID、失败 code 和 evidence 路径。
- 生成 sanitized machine-readable summary；真实包、Cookie、token、原始 body 和本机路径不得进入 Git。
- v20079 重复完整 semantic gate；后续新版本复用同一 runner，不再手写一次性验证记录。

验收：

- v20079 至少完成 3 次独立完整成功序列，其中至少 1 次包含 same-session reconnect。
- 另做不少于 10 次 attach/runtime-connect 采样，记录成功率、p50/p95 和失败分类；先建立基线，不伪造任意成功率目标。
- runner 对无 target、Profile mismatch、bridge timeout、无 AppService、trace wrappers 为 0、hook 未安装等情况均返回明确失败，不生成 synthetic pass。

### R0.2 Acceptance manifest

交付：

- 增加不含敏感数据的 `data/acceptance/` manifest schema，记录版本、模块 hash、Profile hash、验证深度和证据摘要 hash。
- README/Profile 表格从 manifest 生成或由 contract test 校验，避免文档手工漂移。
- `progress.md` 不再使用 `98%/96%` 这类不可复核百分比，只使用明确 gate 状态。

验收：

- `npm run contract` 能检测 tool count、package/source version、Profile 列表和 acceptance manifest 的不一致。
- 每个“已通过”状态都能映射到测试、manifest 或外部 workspace evidence。

### R0.3 文档治理

交付：

- 本文作为未来规划唯一事实源。
- `plan.md`、`original-plan.md` 明确标为历史交付计划。
- `deep-analysis-and-research-report.md` 保留研究价值，但明确其 capability matrix、tool/test 数和旧 roadmap 已过期。
- Tool inventory/API 文档尽量由 registry snapshot 生成，至少增加 drift check。

验收：

- 仓库内不再同时出现互相冲突的当前 tool/test/version 数字。
- 新增/删除/改 schema 时，CI 能提示 README/API/contract 未同步。

## 6. Phase R1：MCP contract 与调试器体验（P1，目标 `0.4.0`）

### R1.1 Structured output 和 tool metadata

当前所有成功结果主要包在 text JSON 中，虽然 SDK v1.29.0 已支持 `outputSchema`、`structuredContent` 和 `annotations`，项目尚未使用。

交付：

- 扩展 `ToolEntry`，让每个 tool 声明 `title`、`outputSchema`、`annotations` 和稳定的 result schema version。
- 成功结果同时返回简洁 `content` 和机器可读 `structuredContent`；大对象仍返回摘要与 artifact path。
- 为全部工具标注 `readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`。
- 明确高风险工具：`wxmp_evaluate`、`wxmp_raw_cdp`、`wxmp_replay_request`、`wxmp_call_wx_api`、`wxmp_call_cloud_function`、repack/profile promotion。
- 统一错误结构：`code/message/details/retryable/nextActions`；不要让模型靠解析自然语言猜下一步。

验收：

- 53 个工具全部有 output contract 和 annotations；contract test 校验缺失项。
- MCP client 集成测试断言 `structuredContent`，同时保留旧 text content 的兼容性。
- package version 与 `src/version.ts` 只保留一个事实源或由 CI 强制一致。

### R1.2 Inspector 与 conformance gate

交付：

- 增加 MCP Inspector CLI 的 stdio `tools/list`、`wxmp_health`、invalid-argument、unknown-tool 回归。
- 使用 SDK client 的 in-memory/stdio 集成测试覆盖真实 server factory，不只直接调用 handler。
- 评估 official conformance 的 test-only loopback adapter；不得把 Streamable HTTP/SSE/daemon 变成生产依赖或默认入口。

验收：

- Inspector CLI gate 可在 CI 无微信环境运行。
- conformance 若暂不能直接覆盖 stdio，记录 expected gap 和上游限制，不用“自测通过”冒充官方 conformance。

### R1.3 Debugger 高频原语

按下面顺序实现，避免先堆分析型工具：

1. `wxmp_get_paused_state`：规范化 call frames、reason、hit breakpoints、selected frame。
2. `wxmp_get_scope_variables`：通过 `Runtime.getProperties` 分页读取 local/closure/object 属性，限制 depth/bytes。
3. `wxmp_evaluate_on_call_frame`：调用 `Debugger.evaluateOnCallFrame`，保留 context/frame evidence。
4. `wxmp_break_on_xhr` / `wxmp_set_pause_on_exceptions` / `wxmp_list_breakpoints`。
5. `wxmp_get_request_initiator`：优先 CDP initiator，补充 hook call stack。
6. `wxmp_list_websockets` / `wxmp_get_websocket_messages`：接入 `Network.webSocket*` events，限制 message 数与字节。
7. `wxmp_save_wasm`：识别 `scriptLanguage=WebAssembly` 或 bytecode，保存到 controlled workspace，只返回 metadata/path。

验收：

- 每个新工具均有 unit/contract/stdio integration test 和 README/API 更新。
- pause/scopes/variables 支持分页与截断，不能把大型对象直接塞进 MCP response。
- reconnect 后明确区分可恢复的 logical breakpoint 与已失效的 CDP breakpoint ID。

## 7. Phase R2：Evidence、静态/动态关联与 Profile 生态（P1，目标 `0.5.0`）

### R2.1 Evidence 分层

当前 sanitizer 主要按 key 名脱敏，不能可靠处理 URL query、header value、Cookie/JWT、嵌套字符串和 body 中的凭据；同时直接抹掉 token 也可能破坏本地逆向证据。

交付：

- 区分 `sanitized event stream`、`local raw artifact` 和 `export bundle` 三层。
- 默认 export 始终脱敏；raw artifact 只能在显式本地配置下写入 ignored workspace，MCP response 不回显原文。
- 增加 header/query/body/JWT/private-key/credential URL 规则、hash/length/preview 元数据和 redaction findings。
- 增加 evidence retention/rotation/cleanup policy；清理操作必须有 destructive annotation 和明确项目/session 范围。

验收：

- fixture 覆盖 Authorization、Cookie、query token、JWT、PEM、JSON body、base64 blob 和嵌套数组。
- sanitized export 不泄漏 fixture secrets；local-raw 模式不改变默认行为。

### R2.2 静态索引 schema v2

当前 `buildIndex()` 主要依赖正则提取 URL、`wx.*` 和导航 route，适合作为 L1 triage，但不足以支撑复杂工程关联。

交付：

- 解析 `app.json`、pages、subPackages、tabBar、usingComponents、workers、plugins 等结构。
- 建立 file/symbol/reference/route/API/storage/cloud/permission 索引，记录来源文件、行号和置信度。
- 可选 AST analyzer 走 adapter/capability 接口；不要把 GPL engine 嵌入 MIT core。
- 增加 `wxmp_correlate_runtime_static`：把 runtime script URL、request initiator、API endpoint 和 restored source/index 关联起来。
- 输出 schema versioned JSON，并生成 route/API summary artifact；高层漏洞判断仍由 skill 完成。

验收：

- main package、subpackage、plugin、minigame fixture 均产生稳定 schema。
- 每条 route/API 结论带 source location 或明确标为 heuristic。
- 同一 endpoint 能从 runtime request 追到候选 restored source，无法关联时给出原因和 confidence。

### R2.3 Profile candidate import contract

交付：

- 定义 extractor-neutral candidate schema：module hash/version、offsets、scene chain、AOB match count、secondary constraints、extractor/version、evidence refs、confidence。
- 增加 candidate import/validate/promotion 流程，对接 `wmpf-offset-adaptation` 产物；MCP core 不执行 IDA/PE 全量分析。
- AOB 多命中时支持 section、function-bound、xref/nearby bytes 等 secondary constraints；仍然 fail closed。
- 维护脱敏 cross-version acceptance matrix，只提交 hash、pattern metadata 和 review 记录，不提交 DLL/IDA DB。

验收：

- 外部 extractor 的 candidate 未 review 前不可 inject。
- schema/version/hash/offset/scene evidence 缺失时 promotion 必须失败。
- 新 WMPF 版本的流程能够复用：extract → import → validate → promote → attach → semantic gate。

## 8. Phase R3：架构、测试与发布收口（P2，目标 `0.5.x` 到 `1.0.0-rc`）

### R3.1 模块拆分与测试 seam

当前 `src/sessions/manager.ts` 为 619 行，承担 attach、state、context、capability、finding、reconnect 和 Frida detach；`src/tools/dynamic.ts` 同时承载 source/debugger/trace/network/call/proxy。继续堆功能会明显放大回归面。

交付：

- 将 session lifecycle、context selection、capability probing、finding tracking 拆成独立模块/状态机。
- 将 dynamic tools 拆为 debugger、source、trace、network、runtime-call、proxy registry。
- 为 clock/process discovery/Frida/bridge/CDP transport 提供可注入 seam，不在 unit test 中依赖真实微信。
- 对 codec、bridge owner、reconnect、ID remap、path/redaction 增加 property/fuzz/soak test。

验收：

- `sessions/manager` 关键状态机 line coverage 提升到至少 `70%`；`dynamic` 至少 `75%`。
- Frida/hook 以 contract + syntax + controlled adapter fixture 验证，不用虚高 line coverage 冒充 real-target 证明。
- Node.js 22 coverage gate 稳定；Node.js 20 当前 coverage reporter 异常单独记录，不影响 20 的 type/test compatibility gate。

### R3.2 CI 和依赖治理

交付：

- Windows 保留 Node.js 20/22；增加 Ubuntu Node.js 22 的 cold-start/static/contract gate，验证 core 不被 Windows 假设污染。
- 增加 format/lint check、coverage summary、dependency audit、license check 和 package/source version check。
- 配置 Dependabot/Renovate 小步升级；优先评估 `frida 17.16.x`、`ws 8.21.x` patch，TypeScript major 单独验证。
- SDK v2 在独立 branch/spike 中迁移；当前上游为 `2.0.0-beta.4`，且 2026-07-28 protocol 需要显式 opt-in，不进入 P0。

验收：

- 所有 gate 在 fresh checkout + `npm ci` 下可复现。
- 依赖升级不得改变 cold-start、stdio 或 lazy Frida 约束。

### R3.3 Release discipline

交付：

- 增加 `CHANGELOG.md`、Git tag、GitHub Release 和 release checklist。
- public tool schema 变更按 semver 管理；acceptance manifest、tool snapshot 和 docs 与 release 一起冻结。
- 增加 issue templates：WMPF version support、runtime gate failure、static backend failure、tool contract regression。
- 保持 npm publication disabled，除非单独决定支持公共安装和 native Frida 分发。

验收：

- `0.3.2` 起每个发布都能从 tag 重建、运行 `npm ci && npm run check`，并找到对应 acceptance 状态。
- 不再出现 package version、server version、README 和 Git tag 四套版本号各说各话。

## 9. 条件路线与明确不做

### 9.1 macOS dynamic adapter

只有在具备真实 macOS/Apple Silicon 微信环境、可维护 Profile 来源和完整 runtime evidence 后启动。没有真实 target 时只保留 adapter boundary，不宣称支持。

### 9.2 MCP SDK v2 / 2026-07-28 protocol

上游 v2 仍为 beta。先完成 v1.29 可用的 structured output、annotations 和 integration tests；待 v2 稳定后使用官方 codemod，在独立分支验证 legacy stdio compatibility，再决定是否通过 `serveStdio()` 同时支持新旧 era。

### 9.3 不进入 MCP core 的能力

- 大量 `find_idor_candidates`、`analyze_auth_surface`、`find_sign_related_requests` 等启发式分析工具；放在 skill/report pipeline。
- 内置 GUI、SSE、always-on HTTP daemon；产品入口继续是 stdio。
- 复制 GPL/未声明许可证实现、第三方 profiles、WMPF 二进制、wxapkg 样本或反编译工程。
- 在 handshake-free `127.0.0.1:9421` 上伪造并发多 runtime 支持；继续 fail-safe single-owner。
- 未经 review 的 Profile 自动注入，或在 extractor 失败时回退历史 offset。

## 10. 建议实施顺序

1. `0.3.2-a`：文档事实源、version drift check、acceptance manifest schema。
2. `0.3.2-b`：live gate runner、v20079 完整 semantic gate、attach/reconnect 采样。
3. `0.4.0-a`：structured output、annotations、Inspector CLI gate。
4. `0.4.0-b`：paused state/scopes/frame evaluation/XHR breakpoint。
5. `0.4.0-c`：WebSocket、WASM、request initiator、evidence redaction v2。
6. `0.5.0-a`：static index v2 与 runtime/static correlation。
7. `0.5.0-b`：Profile candidate import contract 与 cross-version matrix。
8. `0.5.x`：session/dynamic 模块拆分、coverage/CI hardening。
9. `1.0.0-rc`：release discipline、兼容性冻结、第二版本 repeatable gate 复核。

每个子阶段都必须独立 PR、独立 acceptance，不能把 runtime gate、公共 schema 重构和大规模模块拆分塞进同一个 PR。那样出了问题，真就不是排查，是考古了。

## 11. 完成判定

项目进入 `1.0.0` 候选的最低条件：

- 两个 reviewed Windows WMPF 版本完成可重复 mini-program semantic gate；
- 关键 runtime 失败均有结构化 code、evidence 和 next action；
- 所有工具具备稳定 input/output contract 与 annotations；
- 调用栈/作用域、XHR breakpoint、WebSocket、WASM、静态/动态关联形成闭环；
- Profile candidate import、review、promotion、runtime validation 可复用；
- Windows/Ubuntu CI、coverage、Inspector、dependency/license/version gates 通过；
- release/tag/changelog/acceptance manifest 一致；
- 无目标二进制、第三方 profile、抓包、凭据或生成证据进入 Git。
