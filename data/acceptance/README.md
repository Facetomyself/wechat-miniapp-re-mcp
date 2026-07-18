# Acceptance Records

This directory is the machine-readable acceptance source for reviewed WMPF versions.

## Files

- `schema-v1.json`: JSON Schema for one acceptance record.
- `gates-v1.json`: canonical gate names, validation-depth requirements, and live-runner required gates.
- `index.json`: exact record inventory; unindexed or missing records fail the contract gate.
- `windows-<version>.<depth>.json`: version-specific acceptance records.

Validation depths are cumulative claims, not completion percentages:

- `profile-static`: profile schema, module hash, and static bounds are verified.
- `profile-runtime`: static gates plus unique AOB candidates, production hook attachment, and detach are verified.
- `full-semantic`: runtime bridge, AppService, evaluate, breakpoint, trace, request hook, Network body, replay, reconnect, evidence export, and detach are verified.

`recordStatus=verified` is accepted only when every gate required by the selected depth is `passed`. Pending deeper gates remain explicit and do not weaken a shallower verified claim.

## Update workflow

1. Run the tracked live runner or another evidence-producing gate below the configured workspace.
2. Keep WMPF binaries, package samples, raw captures, credentials, and session artifacts outside Git.
3. Add or update a sanitized record with repository/workspace/GitHub evidence references and hashes.
4. Update `index.json`.
5. Run:

```powershell
& "D:\reverse_ENV\tools\node\npm.cmd" run acceptance
& "D:\reverse_ENV\tools\node\npm.cmd" run contract
```

Do not promote a record by editing `recordStatus` alone. The checker validates the claimed depth, referenced profile metadata, profile file SHA-256, module SHA-256, evidence IDs, and record inventory.
