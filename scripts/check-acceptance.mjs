import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
const repositoryRoot = rootArg >= 0 && process.argv[rootArg + 1]
  ? path.resolve(process.argv[rootArg + 1])
  : scriptRoot;

const acceptanceRoot = path.join(repositoryRoot, 'data', 'acceptance');
const schemaPath = path.join(acceptanceRoot, 'schema-v1.json');
const indexPath = path.join(acceptanceRoot, 'index.json');
const gatesPath = path.join(acceptanceRoot, 'gates-v1.json');
const schema = await readJson(schemaPath);
const index = await readJson(indexPath);
const gateContract = await readJson(gatesPath);
const validator = new AjvJsonSchemaValidator().getValidator(schema);
const failures = [];

if (index.schemaVersion !== 1 || !Array.isArray(index.records)) {
  failures.push({ code: 'INVALID_INDEX', path: relative(indexPath), message: 'Acceptance index must use schemaVersion=1 and contain a records array.' });
}

const indexedRecords = Array.isArray(index.records) ? index.records : [];
const discoveredRecords = (await fs.readdir(acceptanceRoot))
  .filter((name) => name.endsWith('.json') && !['gates-v1.json', 'index.json', 'schema-v1.json'].includes(name))
  .sort();
const normalizedIndex = [...indexedRecords].sort();
if (JSON.stringify(normalizedIndex) !== JSON.stringify(discoveredRecords)) {
  failures.push({
    code: 'INDEX_DRIFT',
    path: relative(indexPath),
    message: 'Acceptance index does not match the record files on disk.',
    indexed: normalizedIndex,
    discovered: discoveredRecords,
  });
}

const recordIds = new Set();
const versionDepths = new Set();
const schemaGateNames = Object.keys(schema.properties?.gates?.properties ?? {}).sort();
const contractGateNames = Array.isArray(gateContract.acceptanceGates) ? [...gateContract.acceptanceGates].sort() : [];
if (gateContract.schemaVersion !== 1 || JSON.stringify(schemaGateNames) !== JSON.stringify(contractGateNames)) {
  failures.push({
    code: 'GATE_CONTRACT_DRIFT',
    path: relative(gatesPath),
    schemaGates: schemaGateNames,
    contractGates: contractGateNames,
  });
}
const schemaDepths = [...(schema.properties?.validationDepth?.enum ?? [])].sort();
const contractDepths = Object.keys(gateContract.depths ?? {}).sort();
if (JSON.stringify(schemaDepths) !== JSON.stringify(contractDepths)) {
  failures.push({ code: 'DEPTH_CONTRACT_DRIFT', path: relative(gatesPath), schemaDepths, contractDepths });
}
for (const [depth, gates] of Object.entries(gateContract.depths ?? {})) {
  const unknown = gates.filter((gateName) => !contractGateNames.includes(gateName));
  const duplicates = gates.filter((gateName, index) => gates.indexOf(gateName) !== index);
  if (unknown.length || duplicates.length) failures.push({ code: 'INVALID_DEPTH_GATES', path: relative(gatesPath), depth, unknown, duplicates });
}
const fullSemanticGates = [...(gateContract.depths?.['full-semantic'] ?? [])].sort();
if (JSON.stringify(fullSemanticGates) !== JSON.stringify(contractGateNames)) {
  failures.push({ code: 'FULL_SEMANTIC_GATE_DRIFT', path: relative(gatesPath), expected: contractGateNames, actual: fullSemanticGates });
}
for (const [shallower, deeper] of [['profile-static', 'profile-runtime'], ['profile-runtime', 'full-semantic']]) {
  const missing = (gateContract.depths?.[shallower] ?? []).filter((gateName) => !(gateContract.depths?.[deeper] ?? []).includes(gateName));
  if (missing.length) failures.push({ code: 'DEPTH_NOT_CUMULATIVE', path: relative(gatesPath), shallower, deeper, missing });
}
const liveRunnerRequired = Array.isArray(gateContract.liveRunnerRequired) ? gateContract.liveRunnerRequired : [];
const liveMissing = contractGateNames.filter((gateName) => !liveRunnerRequired.includes(gateName));
if (liveMissing.length) failures.push({ code: 'LIVE_RUNNER_GATE_DRIFT', path: relative(gatesPath), missing: liveMissing });
for (const fileName of indexedRecords) {
  const recordPath = path.join(acceptanceRoot, fileName);
  let record;
  try {
    record = await readJson(recordPath);
  } catch (error) {
    failures.push({ code: 'RECORD_READ_FAILED', path: relative(recordPath), message: error.message });
    continue;
  }

  const validation = validator(record);
  if (!validation.valid) {
    failures.push({
      code: 'SCHEMA_INVALID',
      path: relative(recordPath),
      message: validation.errorMessage ?? 'Acceptance record does not match schema-v1.json.',
    });
    continue;
  }

  if (recordIds.has(record.recordId)) failures.push({ code: 'DUPLICATE_RECORD_ID', path: relative(recordPath), recordId: record.recordId });
  recordIds.add(record.recordId);
  const versionDepth = `${record.platform}:${record.wmpfVersion}:${record.validationDepth}`;
  if (versionDepths.has(versionDepth)) failures.push({ code: 'DUPLICATE_VERSION_DEPTH', path: relative(recordPath), versionDepth });
  versionDepths.add(versionDepth);

  const evidenceIds = new Set();
  for (const evidence of record.evidenceRefs) {
    if (evidenceIds.has(evidence.id)) failures.push({ code: 'DUPLICATE_EVIDENCE_ID', path: relative(recordPath), evidenceId: evidence.id });
    evidenceIds.add(evidence.id);
    if (evidence.kind === 'repository') {
      const referencePath = path.resolve(repositoryRoot, evidence.ref.split('#', 1)[0]);
      if (!isInside(repositoryRoot, referencePath) || !(await isFile(referencePath))) {
        failures.push({ code: 'MISSING_REPOSITORY_EVIDENCE', path: relative(recordPath), evidenceId: evidence.id, ref: evidence.ref });
      }
    }
  }
  for (const [gateName, gate] of Object.entries(record.gates)) {
    for (const evidenceId of gate.evidence ?? []) {
      if (!evidenceIds.has(evidenceId)) failures.push({ code: 'UNKNOWN_GATE_EVIDENCE', path: relative(recordPath), gate: gateName, evidenceId });
    }
  }

  const profilePath = path.resolve(repositoryRoot, record.profile.path);
  if (!isInside(repositoryRoot, profilePath) || !(await isFile(profilePath))) {
    failures.push({ code: 'PROFILE_NOT_FOUND', path: relative(recordPath), profilePath: record.profile.path });
    continue;
  }
  const profile = await readJson(profilePath);
  const profileHash = await sha256File(profilePath);
  if (profileHash !== record.profile.fileSha256) failures.push({ code: 'PROFILE_FILE_HASH_MISMATCH', path: relative(recordPath), expected: record.profile.fileSha256, actual: profileHash });
  if (profile.platform !== record.platform) failures.push({ code: 'PROFILE_PLATFORM_MISMATCH', path: relative(recordPath), expected: record.platform, actual: profile.platform });
  if (profile.wmpfVersion !== record.wmpfVersion) failures.push({ code: 'PROFILE_VERSION_MISMATCH', path: relative(recordPath), expected: record.wmpfVersion, actual: profile.wmpfVersion });
  if (profile.moduleName !== record.module.name) failures.push({ code: 'PROFILE_MODULE_MISMATCH', path: relative(recordPath), expected: record.module.name, actual: profile.moduleName });
  if (profile.moduleSha256 !== record.module.sha256) failures.push({ code: 'PROFILE_MODULE_HASH_MISMATCH', path: relative(recordPath), expected: record.module.sha256, actual: profile.moduleSha256 });
  if (profile.provenance?.source !== record.profile.provenance) failures.push({ code: 'PROFILE_PROVENANCE_MISMATCH', path: relative(recordPath), expected: record.profile.provenance, actual: profile.provenance?.source });
  if (profile.provenance?.confidence !== record.profile.confidence) failures.push({ code: 'PROFILE_CONFIDENCE_MISMATCH', path: relative(recordPath), expected: record.profile.confidence, actual: profile.provenance?.confidence });

  const recordGateNames = Object.keys(record.gates).sort();
  if (JSON.stringify(recordGateNames) !== JSON.stringify(contractGateNames)) {
    failures.push({ code: 'RECORD_GATE_DRIFT', path: relative(recordPath), expected: contractGateNames, actual: recordGateNames });
  }
  const requiredGates = gateContract.depths?.[record.validationDepth] ?? [];
  const missingPassed = requiredGates.filter((gateName) => record.gates[gateName]?.status !== 'passed');
  if (record.recordStatus === 'verified' && missingPassed.length) {
    failures.push({ code: 'VERIFIED_DEPTH_INCOMPLETE', path: relative(recordPath), validationDepth: record.validationDepth, gates: missingPassed });
  }
  if (record.recordStatus === 'pending' && missingPassed.length === 0) {
    failures.push({ code: 'PENDING_DEPTH_ALREADY_COMPLETE', path: relative(recordPath), validationDepth: record.validationDepth });
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, count: indexedRecords.length, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, count: indexedRecords.length, records: indexedRecords }, null, 2));

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function isFile(filePath) {
  return (await fs.stat(filePath).catch(() => null))?.isFile() === true;
}

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function relative(filePath) {
  return path.relative(repositoryRoot, filePath).replaceAll(path.sep, '/');
}

async function sha256File(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}
