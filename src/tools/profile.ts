import { promises as fs } from 'node:fs';
import { WxmpApp } from '../app.js';
import { WxmpError } from '../errors.js';
import { SignatureSpec } from '../runtime/profile.js';
import { resolveInside, safeProjectName } from '../security.js';
import { entry, int, numberProp, objectSchema, optionalText, result, stringArray, stringProp, text } from './helpers.js';
import { ToolEntry } from './types.js';

export function buildProfileTools(app: WxmpApp): ToolEntry[] {
  return [
    entry('wxmp_detect_wmpf', 'Detect WMPF versions and process roles.', objectSchema({}), async () => result(await app.sessions.listTargets())),

    entry('wxmp_profile_probe', 'Load and statically probe an offset profile against a WMPF module.', objectSchema({ pid: numberProp('WMPF PID.'), profile_path: stringProp('Optional profile path.') }, ['pid']), async (args) => {
      const targets = await app.sessions.listTargets();
      const target = targets.find((item) => item.pid === int(args, 'pid', undefined, 1));
      if (!target || !target.version) throw new WxmpError('TARGET_NOT_FOUND', 'Target or version not found');
      const loaded = await app.sessions.profileManager().load(target.version, optionalText(args, 'profile_path'));
      return result(await app.sessions.profileManager().probe(target, loaded.profile));
    }),

    entry('wxmp_profile_generate', 'Generate a candidate profile from explicit AOB signatures; never auto-inject candidates.', objectSchema({
      pid: numberProp('WMPF PID.'), project_name: stringProp('Workspace project.'),
      signatures: { type: 'array', items: { type: 'object', properties: { name: { enum: ['cdpFilter', 'loadStart'] }, pattern: { type: 'string' }, adjustment: { type: 'number' } }, required: ['name', 'pattern'] } },
      scene_offsets: { type: 'array', items: { type: 'number' } },
    }, ['pid', 'project_name', 'scene_offsets']), async (args) => {
      const target = (await app.sessions.listTargets()).find((item) => item.pid === int(args, 'pid', undefined, 1));
      if (!target) throw new WxmpError('TARGET_NOT_FOUND', 'Target not found');
      const signatures = Array.isArray(args.signatures)
        ? args.signatures as SignatureSpec[]
        : await app.sessions.profileManager().signaturesForVersion(target.version ?? 0);
      const sceneOffsets = (args.scene_offsets as number[]).map(Number);
      const profile = await app.sessions.profileManager().generate(target, signatures, sceneOffsets);
      const project = safeProjectName(text(args, 'project_name'));
      const dir = resolveInside(app.config.workspaceRoot, project, 'wechat-miniapp', 'profiles');
      await fs.mkdir(dir, { recursive: true });
      const outputPath = resolveInside(dir, `windows-${profile.wmpfVersion}-candidate.json`);
      await fs.writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
      return result({ profile, outputPath, signatures, warning: 'candidate profile requires validation and runtime review' });
    }),

    entry('wxmp_profile_validate', 'Validate profile schema, module hash, offset bounds, and injection readiness without injection.', objectSchema({ pid: numberProp('WMPF PID.'), profile_path: stringProp('Profile path.') }, ['pid', 'profile_path']), async (args) => {
      const target = (await app.sessions.listTargets()).find((item) => item.pid === int(args, 'pid', undefined, 1));
      if (!target || !target.version) throw new WxmpError('TARGET_NOT_FOUND', 'Target not found');
      const manager = app.sessions.profileManager();
      const loaded = await manager.load(target.version, text(args, 'profile_path'));
      const probe = await manager.probe(target, loaded.profile);
      let injectable = true; let injectionBlock: Record<string, unknown> | null = null;
      try { manager.assertInjectable(loaded.profile); } catch (error) {
        injectable = false;
        injectionBlock = error instanceof WxmpError ? { code: error.code, message: error.message, details: error.details } : { message: String(error) };
      }
      return result({ ...probe, injectable: injectable && probe.valid === true, injectionBlock });
    }),

    entry('wxmp_profile_promote', 'Promote a hash-matched generated candidate with explicit review evidence; writes a reviewed profile inside the controlled workspace.', objectSchema({
      pid: numberProp('WMPF PID.'), candidate_path: stringProp('Generated candidate profile path.'), project_name: stringProp('Workspace project.'),
      confidence: { enum: ['medium', 'high'] }, reviewer: stringProp('Reviewer identifier.'),
      evidence: { type: 'array', items: { type: 'string' }, minItems: 1 }, note: stringProp('Optional review note.'),
    }, ['pid', 'candidate_path', 'project_name', 'confidence', 'reviewer', 'evidence']), async (args) => {
      const target = (await app.sessions.listTargets()).find((item) => item.pid === int(args, 'pid', undefined, 1));
      if (!target || !target.version) throw new WxmpError('TARGET_NOT_FOUND', 'Target not found');
      const manager = app.sessions.profileManager();
      const loaded = await manager.load(target.version, text(args, 'candidate_path'));
      const probe = await manager.probe(target, loaded.profile);
      if (probe.hashValidated !== true || probe.valid !== true) throw new WxmpError('PROFILE_REVIEW_FAILED', 'Candidate must match target module hash and pass offset bounds', probe);
      const confidence = text(args, 'confidence') as 'medium' | 'high';
      if (!['medium', 'high'].includes(confidence)) throw new WxmpError('INVALID_ARGUMENT', 'confidence must be medium or high');
      const reviewEvidence = stringArray(args, 'evidence').map((item) => item.trim()).filter(Boolean);
      if (reviewEvidence.length === 0) throw new WxmpError('INVALID_ARGUMENT', 'evidence must contain at least one review reference');
      const profile = manager.promote(loaded.profile, {
        confidence, reviewer: text(args, 'reviewer'),
        evidence: [...reviewEvidence, `module-sha256:${String(probe.sha256)}`], note: optionalText(args, 'note'),
      });
      const project = safeProjectName(text(args, 'project_name'));
      const dir = resolveInside(app.config.workspaceRoot, project, 'wechat-miniapp', 'profiles');
      await fs.mkdir(dir, { recursive: true });
      const outputPath = resolveInside(dir, `windows-${profile.wmpfVersion}-reviewed-${Date.now()}.json`);
      await fs.writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
      return result({ profile, outputPath, probe });
    }),

    entry('wxmp_export_evidence', 'Export evidence manifest plus report/findings/triage artifacts for one session.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => {
      const session = app.sessions.get(text(args, 'session_id'));
      const paths = await session.evidence.exportBundle(app.sessions.publicStatus(session), session.findings);
      return result(paths);
    }),
  ];
}
