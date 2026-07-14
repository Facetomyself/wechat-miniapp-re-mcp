# Development and PR Workflow

1. Keep transport, runtime, evidence, static adapters, and MCP tool registration separated.
2. Add unit fixtures before changing the wire codec or profile schema.
3. Validate cold startup without WeChat, then mock bridge behavior, then real WMPF attach.
4. A real-target failure must be recorded as a capability gap with reproducible evidence.
5. Push the child repository commit before updating the parent repository gitlink.

## Acceptance commands

```powershell
& "D:\reverse_ENV\tools\node\npm.cmd" run check
git diff --check
git status --short --branch
```
