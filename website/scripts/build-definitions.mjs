#!/usr/bin/env node
/**
 * Prebuild pipeline: packages model/provider definitions into JSON manifests
 * used by the website and external consumers.
 *
 * Context:
 * - Source data lives in <repoRoot>/models.dev/providers (git submodule)
 * - Data format is TOML (provider.toml + models/ recursively-discovered .toml files)
 *
 * This script is intentionally pedantic + defensive. It is build infrastructure.
 * It should never hard-crash because one provider/model has a bad file.
 */

import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseToml } from 'smol-toml';

const VERSION = '1.0.0';
const BASE_URL = 'https://www.llmspec.dev';

// If models ever gain a description field, we keep the public manifest tidy.
const PUBLIC_DESC_MAX_CHARS = 500;

const ALLOWED_STATUSES = new Set(['alpha', 'beta', 'deprecated']);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const websiteDir = path.resolve(__dirname, '..');
const repoRootDir = path.resolve(websiteDir, '..');

const providersRootDir = path.resolve(repoRootDir, 'models.dev', 'providers');

const publicDir = path.resolve(websiteDir, 'public');
const publicDefinitionsDir = path.resolve(publicDir, 'definitions');
const publicManifestPath = path.resolve(publicDefinitionsDir, 'definitions.json');
const schemaPath = path.resolve(publicDefinitionsDir, 'schema.json');

const astroDataDir = path.resolve(websiteDir, 'src', 'data');
const internalCatalogPath = path.resolve(astroDataDir, 'definitions-catalog.json');

/**
 * Keep filtering logic in one place. DRY or suffer.
 *
 * Mirrors the style/pattern from build-skills.mjs.
 */
function shouldExcludePath(relPathLike, { isDirectory = false } = {}) {
  // Normalize to forward slashes so matching is consistent across platforms.
  // NOTE: relPathLike may be a nested path (e.g. "models/.git/config").
  const rel = relPathLike.split(path.sep).join('/');
  const base = path.posix.basename(rel);
  const baseLower = base.toLowerCase();

  // Basename-based exclusions (files)
  if (base === '.DS_Store') return true;
  if (baseLower.endsWith('.pyc')) return true;

  // VCS + repo metadata (dir or file)
  if (base === '.git' || base === '.svn' || base === '.hg') return true;
  if (rel.includes('/.git/') || rel.includes('/.svn/') || rel.includes('/.hg/')) return true;

  // Sensitive config files
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === '.npmrc') return true;
  if (base === '.yarnrc' || base === '.yarnrc.yml') return true;
  if (base === '.pypirc') return true;

  // Secrets / keys / certs
  if (baseLower === 'id_rsa' || baseLower === 'id_ed25519') return true;
  if (baseLower.endsWith('.pem')) return true;
  if (baseLower.endsWith('.key')) return true;
  if (baseLower.endsWith('.p12')) return true;
  if (baseLower.endsWith('.pfx')) return true;

  // Vim swap files
  if (baseLower.endsWith('.swp') || baseLower.endsWith('.swo')) return true;

  // Directory-based exclusions (and anything inside)
  const segments = rel.split('/').filter(Boolean);
  const excludedDirNames = new Set([
    '__pycache__',
    '.ssh',
    'node_modules',
    '.venv',
    'venv',
    'env',
    'dist',
    '.idea',
    '.vscode',
    '.terraform',
  ]);

  if (segments.some((seg) => excludedDirNames.has(seg))) return true;

  // Any dot-prefixed directory (but NOT dotfiles like .gitkeep).
  // We can only safely do this when the caller tells us it's a directory.
  if (isDirectory && base.startsWith('.')) return true;

  return false;
}

function truncate(str, maxChars) {
  if (typeof str !== 'string') return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (str.length <= maxChars) return str;
  if (maxChars === 1) return '…';
  return `${str.slice(0, maxChars - 1)}…`;
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function toPosixPath(p) {
  return p.split(path.sep).join('/');
}

function assertInsideDir(baseDirAbs, targetAbs, label = '') {
  const rel = path.relative(baseDirAbs, targetAbs);
  const relPosix = rel.split(path.sep).join('/');
  if (path.isAbsolute(rel) || relPosix === '..' || relPosix.startsWith('../')) {
    throw new Error(
      `Output boundary violation${label ? ` (${label})` : ''}: ${targetAbs} is outside ${baseDirAbs}`,
    );
  }
}

function sortAlphaCaseInsensitive(values) {
  return [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

async function ensureDirs() {
  await fsp.mkdir(publicDefinitionsDir, { recursive: true });
  await fsp.mkdir(astroDataDir, { recursive: true });
}

async function safeReadDir(dirAbs, { label = '' } = {}) {
  try {
    return await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch (err) {
    if (label) {
      warn(`Failed to read directory (${label}): ${dirAbs}`);
      warn(`  ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }
}

function warn(msg) {
  console.warn(`\u001b[33m[warn]\u001b[0m ${msg}`);
}

function error(msg) {
  console.error(`\u001b[31m[error]\u001b[0m ${msg}`);
}

function isPlainObject(val) {
  return val != null && typeof val === 'object' && !Array.isArray(val);
}

function asString(val) {
  return typeof val === 'string' ? val : undefined;
}

function asStringArray(val) {
  if (!Array.isArray(val)) return undefined;
  const out = [];
  for (const v of val) {
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

function asBoolean(val) {
  return typeof val === 'boolean' ? val : undefined;
}

function asNumber(val) {
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

function normalizeProviderToml(providerId, providerToml, providerTomlPath) {
  // The provider TOML schema is simple; we still validate types.
  const name = asString(providerToml?.name)?.trim();
  const env = asStringArray(providerToml?.env);
  const npm = asString(providerToml?.npm)?.trim();
  const doc = asString(providerToml?.doc)?.trim();
  const api = asString(providerToml?.api)?.trim();

  if (!name) warn(`Provider '${providerId}' missing required string field: name (${providerTomlPath})`);
  if (!env || env.length === 0) warn(`Provider '${providerId}' missing required string[] field: env (${providerTomlPath})`);
  if (!npm) warn(`Provider '${providerId}' missing required string field: npm (${providerTomlPath})`);
  if (!doc) warn(`Provider '${providerId}' missing required string field: doc (${providerTomlPath})`);

  return {
    id: providerId,
    name: name || providerId,
    env: env || [],
    npm: npm || '',
    doc: doc || '',
    api: api || undefined,
  };
}

function normalizeModelToml({ providerId, modelId, modelToml, modelTomlPath }) {
  // Required strings
  const nameRaw = asString(modelToml?.name)?.trim();
  const family = asString(modelToml?.family)?.trim();
  const releaseDate = asString(modelToml?.release_date)?.trim();
  const lastUpdated = asString(modelToml?.last_updated)?.trim();

  if (!nameRaw) warn(`Model '${providerId}/${modelId}' missing required string field: name (${modelTomlPath})`);
  if (!releaseDate) warn(`Model '${providerId}/${modelId}' missing required string field: release_date (${modelTomlPath})`);
  if (!lastUpdated) warn(`Model '${providerId}/${modelId}' missing required string field: last_updated (${modelTomlPath})`);

  // Required booleans
  const attachment = asBoolean(modelToml?.attachment);
  const reasoning = asBoolean(modelToml?.reasoning);
  const toolCall = asBoolean(modelToml?.tool_call);
  const openWeights = asBoolean(modelToml?.open_weights);

  if (attachment === undefined) warn(`Model '${providerId}/${modelId}' missing required boolean field: attachment (${modelTomlPath})`);
  if (reasoning === undefined) warn(`Model '${providerId}/${modelId}' missing required boolean field: reasoning (${modelTomlPath})`);
  if (toolCall === undefined) warn(`Model '${providerId}/${modelId}' missing required boolean field: tool_call (${modelTomlPath})`);
  if (openWeights === undefined) warn(`Model '${providerId}/${modelId}' missing required boolean field: open_weights (${modelTomlPath})`);

  // Optional booleans
  const temperature = asBoolean(modelToml?.temperature);
  const structuredOutput = asBoolean(modelToml?.structured_output);

  // Optional strings
  const knowledge = asString(modelToml?.knowledge)?.trim();

  const statusRaw = asString(modelToml?.status)?.trim()?.toLowerCase();
  const status = statusRaw && ALLOWED_STATUSES.has(statusRaw) ? statusRaw : undefined;
  if (statusRaw && !ALLOWED_STATUSES.has(statusRaw)) {
    warn(
      `Model '${providerId}/${modelId}' has unknown status '${statusRaw}' — omitting from output (${modelTomlPath})`,
    );
  }

  // Optional description (future-proofing)
  const description = asString(modelToml?.description)?.trim();

  // cost table
  const cost = isPlainObject(modelToml?.cost) ? modelToml.cost : undefined;

  // limit table (required)
  const limit = isPlainObject(modelToml?.limit) ? modelToml.limit : undefined;

  if (!limit) warn(`Model '${providerId}/${modelId}' missing required table: [limit] (${modelTomlPath})`);

  const limitContext = asNumber(limit?.context);
  const limitOutput = asNumber(limit?.output);
  const limitInput = asNumber(limit?.input);

  if (limitContext === undefined) warn(`Model '${providerId}/${modelId}' missing required number field: limit.context (${modelTomlPath})`);
  if (limitOutput === undefined) warn(`Model '${providerId}/${modelId}' missing required number field: limit.output (${modelTomlPath})`);

  // modalities table (required)
  const modalities = isPlainObject(modelToml?.modalities) ? modelToml.modalities : undefined;
  if (!modalities) warn(`Model '${providerId}/${modelId}' missing required table: [modalities] (${modelTomlPath})`);

  const modInput = asStringArray(modalities?.input) || [];
  const modOutput = asStringArray(modalities?.output) || [];

  return {
    id: modelId,
    name: nameRaw || modelId,
    family: family || undefined,
    provider: providerId,

    release_date: releaseDate || null,
    last_updated: lastUpdated || null,

    attachment: attachment ?? false,
    reasoning: reasoning ?? false,
    tool_call: toolCall ?? false,
    open_weights: openWeights ?? false,

    temperature: temperature ?? undefined,
    structured_output: structuredOutput ?? undefined,
    knowledge: knowledge || undefined,
    status: status || undefined,

    description: description || undefined,

    cost: cost || undefined,
    limit: {
      context: limitContext ?? null,
      output: limitOutput ?? null,
      ...(limitInput === undefined ? {} : { input: limitInput }),
    },
    modalities: {
      input: modInput,
      output: modOutput,
    },
  };
}

function toPublicModel(modelInternal) {
  // Public output is intentionally smaller / cleaner.
  // - cost keeps only { input, output }
  // - description truncated if it exists (future-proof)

  const publicCost = (() => {
    const c = modelInternal?.cost;
    if (!isPlainObject(c)) return undefined;

    const input = asNumber(c.input);
    const output = asNumber(c.output);

    // Only include if at least one is present.
    if (input === undefined && output === undefined) return undefined;
    return {
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
    };
  })();

  const out = {
    id: modelInternal.id,
    name: modelInternal.name,
    ...(modelInternal.family ? { family: modelInternal.family } : {}),
    provider: modelInternal.provider,

    release_date: modelInternal.release_date,
    last_updated: modelInternal.last_updated,

    attachment: modelInternal.attachment,
    reasoning: modelInternal.reasoning,
    tool_call: modelInternal.tool_call,
    open_weights: modelInternal.open_weights,

    ...(modelInternal.temperature === undefined ? {} : { temperature: modelInternal.temperature }),
    ...(modelInternal.structured_output === undefined
      ? {}
      : { structured_output: modelInternal.structured_output }),
    ...(modelInternal.knowledge ? { knowledge: modelInternal.knowledge } : {}),
    ...(modelInternal.status ? { status: modelInternal.status } : {}),

    ...(modelInternal.description ? { description: truncate(modelInternal.description, PUBLIC_DESC_MAX_CHARS) } : {}),

    modalities: modelInternal.modalities,
    limit: modelInternal.limit,
    ...(publicCost ? { cost: publicCost } : {}),
  };

  return out;
}

async function readTomlFile(tomlAbs, labelForWarnings) {
  try {
    const raw = await fsp.readFile(tomlAbs, 'utf8');
    return parseToml(raw);
  } catch (err) {
    warn(`Failed to parse TOML (${labelForWarnings}): ${tomlAbs}`);
    warn(`${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function listProviderDirs() {
  const entries = await safeReadDir(providersRootDir, { label: 'providers root' });

  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (shouldExcludePath(ent.name, { isDirectory: true })) continue;
    out.push(ent.name);
  }

  // Deterministic initial order (final sort is by provider TOML name).
  return sortAlphaCaseInsensitive(out);
}

async function listModelTomlFiles(modelsRootAbs) {
  // Async DFS. Explicit > clever.
  const out = [];

  async function walk(dirAbs, relFromModelsRoot) {
    const entries = await safeReadDir(dirAbs, { label: relFromModelsRoot ? `models scan: ${relFromModelsRoot}` : 'models scan: <root>' });
    for (const ent of entries) {
      const childAbs = path.resolve(dirAbs, ent.name);
      const childRel = relFromModelsRoot ? `${relFromModelsRoot}/${ent.name}` : ent.name;

      if (shouldExcludePath(childRel, { isDirectory: ent.isDirectory() })) continue;

      if (ent.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (ent.isFile()) {
        if (!ent.name.toLowerCase().endsWith('.toml')) continue;
        out.push({ abs: childAbs, rel: childRel });
      } else {
        // ignore symlinks/sockets/etc (YAGNI)
      }
    }
  }

  await walk(modelsRootAbs, '');

  // Deterministic; parsing/sorting by name happens later.
  out.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { sensitivity: 'base' }));
  return out;
}

function buildJsonSchema() {
  // Schema is based on the public manifest format.
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${BASE_URL}/definitions/schema.json`,
    title: 'LLMSpec Model Definitions Manifest',
    type: 'object',
    additionalProperties: false,
    required: ['version', 'generated_at', 'base_url', 'total_providers', 'total_models', 'providers'],
    properties: {
      version: { type: 'string' },
      generated_at: { type: 'string', format: 'date-time' },
      base_url: { type: 'string' },
      total_providers: { type: 'integer', minimum: 0 },
      total_models: { type: 'integer', minimum: 0 },
      providers: {
        type: 'array',
        items: { $ref: '#/$defs/provider' },
      },
    },
    $defs: {
      provider: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'npm', 'doc', 'has_logo', 'model_count', 'models'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          npm: { type: 'string' },
          doc: { type: 'string' },
          api: { type: 'string' },
          has_logo: { type: 'boolean' },
          model_count: { type: 'integer', minimum: 0 },
          models: {
            type: 'array',
            items: { $ref: '#/$defs/model' },
          },
        },
      },
      model: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'name',
          'provider',
          'release_date',
          'last_updated',
          'attachment',
          'reasoning',
          'tool_call',
          'open_weights',
          'modalities',
          'limit',
        ],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          family: { type: 'string' },
          provider: { type: 'string' },

          release_date: { type: ['string', 'null'] },
          last_updated: { type: ['string', 'null'] },

          attachment: { type: 'boolean' },
          reasoning: { type: 'boolean' },
          tool_call: { type: 'boolean' },
          temperature: { type: 'boolean' },
          structured_output: { type: 'boolean' },
          knowledge: { type: 'string' },
          open_weights: { type: 'boolean' },
          status: { type: 'string', enum: ['alpha', 'beta', 'deprecated'] },

          description: { type: 'string' },

          modalities: {
            type: 'object',
            additionalProperties: false,
            required: ['input', 'output'],
            properties: {
              input: { type: 'array', items: { type: 'string' } },
              output: { type: 'array', items: { type: 'string' } },
            },
          },
          limit: {
            type: 'object',
            additionalProperties: false,
            required: ['context', 'output'],
            properties: {
              context: { type: ['number', 'null'], minimum: 0 },
              output: { type: ['number', 'null'], minimum: 0 },
              input: { type: 'number', minimum: 0 },
            },
          },
          cost: {
            type: 'object',
            additionalProperties: false,
            properties: {
              input: { type: 'number', minimum: 0 },
              output: { type: 'number', minimum: 0 },
            },
          },
        },
      },
    },
  };
}

async function writeJsonPretty(fileAbs, data) {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await fsp.writeFile(fileAbs, json, 'utf8');
}

async function main() {
  await ensureDirs();

  if (!(await isDirectory(providersRootDir))) {
    // Guard clause: the models repo is a git submodule. We should explain the fix.
    error(`Definitions source directory not found: ${providersRootDir}`);
    console.log('');
    console.log('This repo expects the model definitions to be present as a git submodule.');
    console.log('Run:');
    console.log('  git submodule update --init --recursive');
    console.log('');
    console.log('Skipping definitions build (skills build can still succeed).');
    console.log('');
    return;
  }

  const providerIds = await listProviderDirs();

  const generatedAt = new Date().toISOString();

  const manifestPublic = {
    version: VERSION,
    generated_at: generatedAt,
    base_url: BASE_URL,
    total_providers: 0,
    total_models: 0,
    providers: [],
  };

  const manifestInternal = {
    version: VERSION,
    generated_at: generatedAt,
    base_url: BASE_URL,
    total_providers: 0,
    total_models: 0,
    providers: [],
  };

  console.log(`\nBuilding definitions from: ${providersRootDir}`);

  let modelTotal = 0;

  for (const providerId of providerIds) {
    const providerDirAbs = path.resolve(providersRootDir, providerId);
    const providerTomlPath = path.resolve(providerDirAbs, 'provider.toml');

    let providerToml = null;
    if (await pathExists(providerTomlPath)) {
      providerToml = await readTomlFile(providerTomlPath, `provider:${providerId}`);
    } else {
      warn(`Missing provider.toml for provider '${providerId}': ${providerTomlPath}`);
    }

    const providerMeta = normalizeProviderToml(providerId, providerToml || {}, providerTomlPath);

    const logoAbs = path.resolve(providerDirAbs, 'logo.svg');
    const hasLogo = await pathExists(logoAbs);

    const modelsRootAbs = path.resolve(providerDirAbs, 'models');
    if (!(await isDirectory(modelsRootAbs))) {
      warn(`Provider '${providerId}' has no models/ directory: ${modelsRootAbs}`);
    }

    const modelFiles = (await isDirectory(modelsRootAbs)) ? await listModelTomlFiles(modelsRootAbs) : [];

    const modelsInternal = [];
    for (const f of modelFiles) {
      const relPosix = toPosixPath(f.rel);
      const modelId = relPosix.replace(/\.toml$/i, '');

      const parsed = await readTomlFile(f.abs, `model:${providerId}/${modelId}`);
      if (!parsed) continue;

      try {
        const normalized = normalizeModelToml({
          providerId,
          modelId,
          modelToml: parsed,
          modelTomlPath: f.abs,
        });
        modelsInternal.push(normalized);
      } catch (err) {
        // normalizeModelToml should never throw, but we still guard.
        warn(`Unexpected error normalizing model TOML: ${providerId}/${modelId}`);
        warn(`${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    }

    // Deterministic ordering by visible name.
    modelsInternal.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const providerOutInternal = {
      id: providerMeta.id,
      name: providerMeta.name,
      env: providerMeta.env,
      npm: providerMeta.npm,
      doc: providerMeta.doc,
      ...(providerMeta.api ? { api: providerMeta.api } : {}),
      has_logo: hasLogo,
      model_count: modelsInternal.length,
      models: modelsInternal,
    };

    const providerOutPublic = {
      id: providerMeta.id,
      name: providerMeta.name,
      npm: providerMeta.npm,
      doc: providerMeta.doc,
      ...(providerMeta.api ? { api: providerMeta.api } : {}),
      has_logo: hasLogo,
      model_count: modelsInternal.length,
      models: modelsInternal.map(toPublicModel),
    };

    manifestInternal.providers.push(providerOutInternal);
    manifestPublic.providers.push(providerOutPublic);

    modelTotal += modelsInternal.length;
  }

  // Providers sorted alphabetically by display name.
  // (We sort public + internal independently to keep them aligned.)
  manifestInternal.providers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  manifestPublic.providers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  manifestInternal.total_providers = manifestInternal.providers.length;
  manifestPublic.total_providers = manifestPublic.providers.length;
  manifestInternal.total_models = modelTotal;
  manifestPublic.total_models = modelTotal;

  const schema = buildJsonSchema();

  assertInsideDir(publicDefinitionsDir, publicManifestPath, 'public manifest');
  assertInsideDir(astroDataDir, internalCatalogPath, 'internal catalog');
  assertInsideDir(publicDefinitionsDir, schemaPath, 'schema');

  await writeJsonPretty(publicManifestPath, manifestPublic);
  await writeJsonPretty(internalCatalogPath, manifestInternal);
  await writeJsonPretty(schemaPath, schema);

  console.log(`Providers: ${manifestPublic.total_providers}`);
  console.log(`Models:    ${manifestPublic.total_models}`);
  console.log(`Manifest:  ${path.relative(websiteDir, publicManifestPath)}`);
  console.log(`Catalog:   ${path.relative(websiteDir, internalCatalogPath)}`);
  console.log(`Schema:    ${path.relative(websiteDir, schemaPath)}`);
  console.log('');
}

try {
  await main();
} catch (err) {
  error('build-definitions.mjs failed');
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
}
