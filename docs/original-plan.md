# Original `/plan` Session Output

This file preserves the two complete `<proposed_plan>` blocks emitted by the original Codex planning session. The plan text below is copied verbatim and must not be updated to match later implementation decisions.

- Session ID: `019f5fce-165c-7613-b910-0da6b14b80dd`
- Initial architecture plan: 2026-07-14 17:08:49 +08:00
- Private subrepository delivery plan: 2026-07-14 17:52:38 +08:00
- Normalized implementation plan: [`plan.md`](plan.md)
- Current implementation status: [`progress.md`](progress.md)

## 1. Initial architecture plan

<proposed_plan>
# `wechat-miniapp-re-mcp` 重写方案

## 总体方案

在 `mcp/wechat-miniapp-re-mcp/` 新建 TypeScript stdio MCP，工具前缀统一为 `wxmp_*`。服务启动时不连接微信、不启动 GUI；调用 `attach` 后才加载 Frida、探测 WMPF 并建立 protobuf/CDP 通道。

- `tools/First/` 仅作行为与协议参考，现有脏改动保持不动。
- 采用 clean-room 重写，不复制 First 的闭源部分或 WMPFDebugger 的 GPL 实现。
- Windows v1 完整交付，平台层预留 macOS adapter。
- 普通小程序提供完整动态调试；小游戏静态完整，动态能力根据 runtime 探测结果返回 capability，不虚报断点支持。
- 默认允许 JS 执行、请求重放、参数修改和云函数调用，但所有主动操作写入审计日志。
- 保留可选 Chrome DevTools proxy，MCP 才是主控制面。

## 核心架构与接口

### 1. 运行时内核

拆成五个边界清晰的子系统：

- `WmpfProfileManager`：版本检测、Profile 加载、签名扫描、候选验证与 Profile 生成。
- `FridaRuntimeAdapter`：进程发现、attach/detach、Hook 注入、崩溃与重连处理。
- `WmpfDebugTransport`：9421 WebSocket、最小 protobuf wire codec、序列号和 context 生命周期。
- `CdpSessionManager`：显式多会话模型，使用 `session_id + context_id` 隔离小程序、小游戏和多窗口状态。
- `EvidenceStore`：事件、脚本、网络、断点、主动操作和错误证据统一落盘。

服务必须支持微信未运行时正常 MCP handshake；目标断开后保留 session 证据并进入 `disconnected`，不得静默串到新目标。

### 2. MCP 工具面

采用“逆向工作流工具 + raw escape hatch”，返回摘要和 artifact 路径，禁止把大型源码或响应体整块塞进 MCP 消息。

- 生命周期：`wxmp_health`、`wxmp_list_targets`、`wxmp_attach`、`wxmp_detach`、`wxmp_session_status`
- Context：`wxmp_list_contexts`、`wxmp_select_context`、`wxmp_get_runtime_info`
- 源码与调试：`wxmp_list_scripts`、`wxmp_get_source`、`wxmp_search_sources`、`wxmp_set_breakpoint`、`wxmp_pause_info`、`wxmp_step`、`wxmp_resume`
- 动态追踪：`wxmp_trace_start`、`wxmp_trace_query`、`wxmp_trace_stop`，覆盖函数调用、`wx.*`、storage、导航、cloud 和 bridge
- 网络与主动验证：`wxmp_capture_start`、`wxmp_list_requests`、`wxmp_get_request`、`wxmp_replay_request`、`wxmp_call_wx_api`、`wxmp_call_cloud_function`
- 静态链：`wxmp_scan_packages`、`wxmp_unpack`、`wxmp_decompile`、`wxmp_static_search`、`wxmp_build_index`、`wxmp_repack`
- Profile：`wxmp_detect_wmpf`、`wxmp_profile_probe`、`wxmp_profile_generate`、`wxmp_profile_validate`
- 底层逃生口：`wxmp_evaluate`、`wxmp_raw_cdp`、`wxmp_raw_adapter`
- 交付：`wxmp_export_evidence`，生成 evidence manifest，并为逆向三件套提供结构化输入

所有工具涉及动态目标时必须显式传 `session_id`；多 context 操作同时传 `context_id`，不做危险的自动猜测。

### 3. 静态分析插件

默认接入 MIT 许可、仍活跃维护的 `25smoking/Gwxapkg`，固定版本后放在 `tools/Gwxapkg/` 作为公共 submodule，构建产物留在忽略目录。

- MCP 通过 JSON adapter 调用，不解析彩色 CLI 文本。
- 支持缓存扫描、AppID 检测、解密、主包/分包/插件/小游戏还原、资源提取、API/路由索引和 repack。
- 提供 generic CLI adapter，允许后续接入其他引擎；GPL 的 `unveilr/wedecode` 不作为内置依赖。
- 所有输入、临时文件和产物限制在 `workspace/<项目名>/wechat-miniapp/`，执行前验证 resolved path，防止输出越界。

## 实施阶段

1. **先刷新治理文档**：更新 `AGENTS.md`、`CLAUDE.md`，明确新 MCP 路由、目录、前缀、小游戏能力边界和 First 退役策略。
2. **建立最小 MCP 骨架**：完成 stdio handshake、类型定义、session registry、结构化错误、分页结果和 artifact contract。
3. **重写动态内核**：独立实现 WMPF wire codec、Frida adapter、CDP command/event 调度、多 context 和可选 DevTools proxy。
4. **实现专用逆向能力**：断点/调用栈、网络因果链、`wx.*`/cloud/bridge Hook、重放、路由与 storage 观察、审计日志。
5. **接入静态插件**：增加 Gwxapkg submodule、adapter contract、源码索引及动态脚本与静态文件映射。
6. **实现半自动 Profile**：AOB/结构特征扫描候选，沙箱式运行时校验；低置信候选只输出证据，交给 IDA/radare2 复核，不自动注入。
7. **完成项目接入**：同步 `.mcp.json`、`.codex/config.toml`、`mcp/README.md`、工具与 MCP 文档、reverse-coordinator 路由；旧 `first-mcp` 标记 deprecated，`tools/First` 暂不删除。
8. **稳定后再进入默认配置**：只有 stdio 冷启动、无微信 handshake、真实 attach 三项均通过，才加入项目冷启动 MCP 清单。

## 验证与验收

- 单元测试：protobuf golden fixtures、CDP request/response 配对、session/context 隔离、断连清理、路径边界、分页和审计事件。
- Mock 集成：伪 WMPF WebSocket + 假 Frida adapter，覆盖重连、并发命令、超时、乱序响应和多个 context。
- 真实动态门禁：至少验证 WMPF `19977` 与当前最新可用版本；完成 attach、脚本枚举、evaluate、断点命中、调用栈、网络捕获、wx API Hook、重放和 detach。
- 静态 fixtures：加密/未加密主包、分包、插件、小游戏各一套，校验文件树、索引、资源哈希和缺包诊断。
- Profile 门禁：已知版本可重复生成并验证；未知版本不得因低置信候选造成目标崩溃。
- MCP 门禁：微信和 Gwxapkg 均未运行时仍能正常 list tools；无 PySide、GUI、SSE 或 First 后台依赖。
- 性能目标：空闲服务不执行扫描或 attach；大型源码和流量按页读取；事件缓冲有上限并可落盘。
- 最终运行 `npm run typecheck/build/test/smoke`、`git diff --check` 和 workspace governance audit。

## 已锁定假设

- 技术栈为 TypeScript + `@modelcontextprotocol/sdk`，使用项目便携 Node。
- Profile、Hook 和协议 codec 均 clean-room 实现；外部项目只用于证据对照和独立 adapter。
- 主动操作默认开放，但每次调用必须记录参数摘要、目标 session、时间和结果。
- 小游戏动态能力以 capability probe 为准，v1 不承诺与普通小程序完全对齐。
- GitHub 调研采用本地上下文直接核验，未使用 sub-agent，避免对紧密耦合的协议与许可证判断做重复拆分。
</proposed_plan>

## 2. Private subrepository delivery plan

<proposed_plan>
# `wechat-miniapp-re-mcp` Private 子仓落地计划

## 总结

创建 Private GitHub 仓库 `Facetomyself/wechat-miniapp-re-mcp`，作为主仓 `mcp/wechat-miniapp-re-mcp` submodule。采用 TypeScript + MCP SDK，提供轻量 stdio 服务；微信、Frida、静态引擎均按工具调用懒加载，不依赖 First GUI/SSE。

- 工具前缀：`wxmp_*`
- 首版平台：Windows 完整支持，预留 macOS adapter
- 普通小程序：完整静态与动态逆向
- 微信小游戏：静态完整，动态能力按 runtime capability 探测
- `tools/First` 保持原状，只作 clean-room 行为参考
- 仓库暂不公开，但从首日采用 MIT、来源记录和 clean-room 约束，为未来公开做准备

## 仓库与 PR 流程

1. 使用 `gh` 创建 `Facetomyself/wechat-miniapp-re-mcp` Private repo，默认分支 `main`，初始化 `README.md`、MIT License、Node `.gitignore`。
2. 主仓创建 `feat/wechat-miniapp-re-mcp-integration` 分支，将 Private repo 挂载为 `mcp/wechat-miniapp-re-mcp` submodule，并先更新 `AGENTS.md`、`CLAUDE.md`，满足“大任务先刷新治理文档”要求。
3. 子仓创建 `feat/bootstrap-re-mcp` 分支实施代码；先提交最小 MCP 骨架，再按能力分层提交，避免一个巨型 commit。
4. 子仓完成验证后 push，使用 `gh pr create` 向子仓 `main` 发起 PR；合并后主仓更新 gitlink。
5. 主仓完成 MCP 配置、文档、路由与治理验证后，再向 `reverse_ENV/main` 发起独立 PR。
6. 跨仓顺序固定为：子仓测试 → 子仓 PR/merge → 主仓更新 gitlink → 主仓测试 → 主仓 PR。不得让主仓引用尚未推送的子仓 commit。

## 子仓实现

### 运行时架构

- `WmpfProfileManager`：WMPF 版本探测、Profile 管理、AOB 候选扫描、运行时验证和半自动 Profile 生成。
- `FridaRuntimeAdapter`：发现 `WeChatAppEx.exe`、attach/detach、Hook 注入、崩溃隔离和自动重连。
- `WmpfDebugTransport`：9421 WebSocket、clean-room protobuf wire codec、消息序列和 context 生命周期。
- `CdpSessionManager`：显式 `session_id + context_id` 多会话模型，支持多个小程序窗口和运行时切换。
- `EvidenceStore`：脚本、网络、断点、Hook、重放和主动调用统一写入 `workspace/<项目>/wechat-miniapp/`。
- `StaticAdapterRegistry`：默认适配 `tools/Gwxapkg`，同时提供 generic CLI adapter；外部引擎只在调用静态工具时启动。
- `DevToolsProxy`：默认关闭，需要人工协同时按 session 开启本地 CDP proxy。

MCP 必须在微信、Frida 目标或 Gwxapkg 不可用时仍正常完成 stdio handshake，并通过 health/capability 返回缺失条件。

### MCP 公共接口

- 会话：`wxmp_health`、`wxmp_list_targets`、`wxmp_attach`、`wxmp_detach`、`wxmp_session_status`
- Context：`wxmp_list_contexts`、`wxmp_select_context`、`wxmp_get_runtime_info`
- 源码调试：`wxmp_list_scripts`、`wxmp_get_source`、`wxmp_search_sources`、`wxmp_set_breakpoint`、`wxmp_pause_info`、`wxmp_step`、`wxmp_resume`
- 动态追踪：`wxmp_trace_start/query/stop`，覆盖函数、`wx.*`、cloud、storage、导航和 bridge
- 网络验证：`wxmp_capture_start/stop`、`wxmp_list_requests`、`wxmp_get_request`、`wxmp_replay_request`
- 主动调用：`wxmp_call_wx_api`、`wxmp_call_cloud_function`
- 静态链：`wxmp_scan_packages`、`wxmp_unpack`、`wxmp_decompile`、`wxmp_static_search`、`wxmp_build_index`、`wxmp_repack`
- Profile：`wxmp_detect_wmpf`、`wxmp_profile_probe`、`wxmp_profile_generate`、`wxmp_profile_validate`
- 逃生口：`wxmp_evaluate`、`wxmp_raw_cdp`、`wxmp_raw_adapter`
- 交付：`wxmp_export_evidence`

动态工具必须显式传 `session_id`；多 context 操作同时传 `context_id`。源码、流量和 trace 使用分页与 artifact 路径，禁止把大文件整块返回给 MCP client。主动操作默认开放，但写入审计事件。

## 主仓接入

- 在 `tools/Gwxapkg` 固定 MIT 静态后端版本，作为独立公共 submodule 或可复现本地构建依赖；运行产物不纳入 Git。
- 同步 `.mcp.json`、`.codex/config.toml`、`mcp/README.md`、`docs/MCP服务详情.md`、`docs/工具与环境.md`、`AGENTS.md`、`CLAUDE.md`。
- reverse-coordinator 新增路由：本地 `.wxapkg`、PC 微信 WMPF、小程序/小游戏动态调试优先进入 `wxmp_*`；普通网页小程序相关 H5 仍走 ruyi/js-reverse。
- `first-mcp` 标记 deprecated；`tools/First` 暂不删除、不迁移、不清理其现有脏改动。
- MCP 通过全部门禁后再决定是否加入默认冷启动清单；未达标时只保留按需配置示例。

## 测试与验收

- 单元测试：wire codec golden fixtures、CDP 乱序响应、session/context 隔离、断连清理、路径边界、分页和审计日志。
- Mock 集成：伪 WMPF WebSocket 与 Frida adapter，覆盖并发调用、超时、重连、多 context 和小游戏 capability 降级。
- 真实动态门禁：至少验证 WMPF `19977` 与当前最新可用版本，完成 attach、脚本枚举、evaluate、断点、调用栈、网络捕获、wx/cloud Hook、重放和 detach。
- 静态 fixtures：加密/未加密主包、分包、插件、小游戏各一套，验证目录还原、资源哈希、API/路由索引和缺包诊断。
- Profile 门禁：已知版本可稳定复现；低置信候选不得自动注入或导致目标崩溃。
- 工程验证：`typecheck`、`build`、`test`、MCP list-tools smoke、无微信冷启动 smoke、`git diff --check`、submodule 状态及 workspace governance audit。
- PR 验收：子仓和主仓均保持 clean；无凭据、微信缓存、wxapkg、源码全集、抓包、Profile 原始二进制或调试日志进入 Git。

## 已锁定默认值

- GitHub owner：`Facetomyself`
- 子仓：`Facetomyself/wechat-miniapp-re-mcp`
- 可见性：Private
- 主仓挂载点：`mcp/wechat-miniapp-re-mcp`
- 默认分支：`main`
- 实现：TypeScript + `@modelcontextprotocol/sdk`
- 默认静态后端：MIT `Gwxapkg` adapter
- 发布策略：当前 Private，设计与许可证保持未来可公开
</proposed_plan>
