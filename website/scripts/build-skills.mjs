#!/usr/bin/env node
/**
 * Prebuild pipeline: packages all skills into downloadable ZIPs and generates
 * JSON manifests used by the website and LLM consumers.
 *
 * Requirements:
 * - ESM (project has "type": "module")
 * - Uses gray-matter for YAML frontmatter parsing
 * - Uses archiver for streaming ZIP creation (binary-safe)
 *
 * This script is intentionally pedantic + defensive. It is critical build infra.
 */

import { createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import archiver from 'archiver';
import matter from 'gray-matter';

const VERSION = '1.0.0';
const BASE_URL = 'https://www.llmspec.dev';
const PUBLIC_DESC_MAX_CHARS = 500;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const websiteDir = path.resolve(__dirname, '..');
const repoRootDir = path.resolve(websiteDir, '..');
const skillsRootDir = path.resolve(repoRootDir, 'skills');

const publicDir = path.resolve(websiteDir, 'public');
const downloadsDir = path.resolve(publicDir, 'skills', 'downloads');
const publicManifestPath = path.resolve(publicDir, 'skills', 'skills.json');
const schemaPath = path.resolve(publicDir, 'skills', 'schema.json');

const astroDataDir = path.resolve(websiteDir, 'src', 'data');
const internalCatalogPath = path.resolve(astroDataDir, 'skills-catalog.json');

/**
 * Keep filtering logic in one place. DRY or suffer.
 */
function shouldExcludePath(relPathLike, { isDirectory = false } = {}) {
  // Normalize to forward slashes so matching is consistent across platforms.
  // NOTE: relPathLike may be a nested path (e.g. "skill/.git/config").
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

function slugifyGroupName(groupName) {
  // Add separators for camelCase / PascalCase -> product-management
  const withDashes = groupName.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
  return withDashes
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function truncate(str, maxChars) {
  if (typeof str !== 'string') return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (str.length <= maxChars) return str;
  if (maxChars === 1) return '…';
  return `${str.slice(0, maxChars - 1)}…`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let u = 0;
  while (size >= 1024 && u < units.length - 1) {
    size /= 1024;
    u += 1;
  }
  return `${size.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
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

function sortAlphaCaseInsensitive(values) {
  return [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

async function ensureDirs() {
  await fsp.mkdir(downloadsDir, { recursive: true });
  await fsp.mkdir(path.dirname(publicManifestPath), { recursive: true });
  await fsp.mkdir(path.dirname(schemaPath), { recursive: true });
  await fsp.mkdir(astroDataDir, { recursive: true });
}

async function listGroups() {
  const entries = await fsp.readdir(skillsRootDir, { withFileTypes: true });
  const groups = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  return sortAlphaCaseInsensitive(groups);
}

async function listSkillDirs(groupDirAbs) {
  const entries = await fsp.readdir(groupDirAbs, { withFileTypes: true });

  const candidates = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({
      dirName: e.name,
      absPath: path.resolve(groupDirAbs, e.name),
    }));

  const skills = [];
  for (const c of candidates) {
    const skillMd = path.resolve(c.absPath, 'SKILL.md');
    if (await pathExists(skillMd)) skills.push(c);
  }

  skills.sort((a, b) => a.dirName.localeCompare(b.dirName, undefined, { sensitivity: 'base' }));
  return skills;
}

async function parseSkillFrontmatter(skillMdAbs, fallbackName) {
  try {
    const raw = await fsp.readFile(skillMdAbs, 'utf8');
    const parsed = matter(raw);

    const name = typeof parsed.data?.name === 'string' && parsed.data.name.trim()
      ? parsed.data.name.trim()
      : fallbackName;

    const description = typeof parsed.data?.description === 'string'
      ? parsed.data.description.trim()
      : '';

    if (!description) {
      console.warn(`[33m[warn][0m Missing/empty description in frontmatter: ${skillMdAbs}`);
    }

    return { name, description };
  } catch (err) {
    console.warn(`[33m[warn][0m Failed to parse SKILL.md frontmatter: ${skillMdAbs}`);
    console.warn(`       ${err instanceof Error ? err.message : String(err)}`);
    return { name: fallbackName, description: '' };
  }
}

async function countIncludedFiles(rootAbs) {
  // Async DFS. We keep it simple and explicit so behavior is obvious.
  let count = 0;

  async function walk(dirAbs, relFromRoot) {
    const entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    for (const ent of entries) {
      const childAbs = path.resolve(dirAbs, ent.name);
      const childRel = relFromRoot ? `${relFromRoot}/${ent.name}` : ent.name;

      if (shouldExcludePath(childRel, { isDirectory: ent.isDirectory() })) continue;

      if (ent.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (ent.isFile()) {
        count += 1;
      } else {
        // ignore symlinks/sockets/etc (YAGNI)
      }
    }
  }

  await walk(rootAbs, '');
  return count;
}

async function detectSkillContents(skillDirAbs) {
  const scriptsDir = path.resolve(skillDirAbs, 'scripts');
  const refsDir = path.resolve(skillDirAbs, 'references');

  const licenseCandidates = ['LICENSE.txt', 'LICENSE.md', 'LICENSE'];
  const hasLicense = await (async () => {
    for (const f of licenseCandidates) {
      if (await pathExists(path.resolve(skillDirAbs, f))) return true;
    }
    return false;
  })();

  return {
    has_scripts: await isDirectory(scriptsDir),
    has_references: await isDirectory(refsDir),
    has_license: hasLicense,
  };
}

async function createSkillZip({ skillDirAbs, skillFolderName, zipOutAbs }) {
  // Overwrites existing zip atomically-ish (write stream truncates).
  return await new Promise((resolve, reject) => {
    const output = createWriteStream(zipOutAbs);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    output.on('error', (err) => reject(err));
    archive.on('warning', (err) => {
      // Archiver uses warning for non-fatal things like missing files.
      console.warn(`[33m[warn][0m Archiver warning for ${skillFolderName}: ${err.message}`);
    });
    archive.on('error', (err) => reject(err));

    archive.pipe(output);

    archive.directory(skillDirAbs, skillFolderName, (entry) => {
      // entry.name is the path inside the archive.
      const isDirectory =
        entry?.type === 'directory' ||
        (typeof entry?.stats?.isDirectory === 'function' && entry.stats.isDirectory());

      if (shouldExcludePath(entry.name, { isDirectory })) return false;
      return entry;
    });

    void archive.finalize();
  });
}

function buildJsonSchema() {
  // A reasonably strict schema. Not perfect, but useful and future-proof-ish.
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${BASE_URL}/skills/schema.json`,
    title: 'LLMSpec Skills Manifest',
    type: 'object',
    additionalProperties: false,
    required: ['version', 'generated_at', 'base_url', 'total_skills', 'groups'],
    properties: {
      version: { type: 'string' },
      generated_at: { type: 'string', format: 'date-time' },
      base_url: { type: 'string' },
      total_skills: { type: 'integer', minimum: 0 },
      groups: {
        type: 'array',
        items: { $ref: '#/$defs/group' },
      },
    },
    $defs: {
      group: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'slug', 'skill_count', 'skills'],
        properties: {
          name: { type: 'string' },
          slug: { type: 'string' },
          skill_count: { type: 'integer', minimum: 0 },
          skills: {
            type: 'array',
            items: { $ref: '#/$defs/skill' },
          },
        },
      },
      skill: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name',
          'description',
          'group',
          'download_url',
          'zip_size_bytes',
          'file_count',
          'contents',
        ],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          group: { type: 'string' },
          download_url: { type: 'string' },
          zip_size_bytes: { type: 'integer', minimum: 0 },
          file_count: { type: 'integer', minimum: 0 },
          contents: {
            type: 'object',
            additionalProperties: false,
            required: ['has_scripts', 'has_references', 'has_license'],
            properties: {
              has_scripts: { type: 'boolean' },
              has_references: { type: 'boolean' },
              has_license: { type: 'boolean' },
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

  if (!(await isDirectory(skillsRootDir))) {
    throw new Error(`Skills root not found: ${skillsRootDir}`);
  }

  const groupNames = await listGroups();

  const generatedAt = new Date().toISOString();
  const manifestPublic = {
    version: VERSION,
    generated_at: generatedAt,
    base_url: BASE_URL,
    total_skills: 0,
    groups: [],
  };

  const manifestInternal = {
    version: VERSION,
    generated_at: generatedAt,
    base_url: BASE_URL,
    total_skills: 0,
    groups: [],
  };

  const seenSkillFolderNames = new Set();
  let packagedCount = 0;
  let errorCount = 0;
  let totalZipBytes = 0;

  console.log(`\nBuilding skills artifacts from: ${skillsRootDir}`);
  console.log(`Output downloads dir: ${downloadsDir}`);

  for (const groupName of groupNames) {
    const groupSlug = slugifyGroupName(groupName);
    const groupDirAbs = path.resolve(skillsRootDir, groupName);

    const skillDirs = await listSkillDirs(groupDirAbs);
    const groupOutPublic = {
      name: groupName,
      slug: groupSlug,
      skill_count: 0,
      skills: [],
    };
    const groupOutInternal = {
      name: groupName,
      slug: groupSlug,
      skill_count: 0,
      skills: [],
    };

    for (const s of skillDirs) {
      const skillFolderName = s.dirName;
      const skillDirAbs = s.absPath;
      const skillMdAbs = path.resolve(skillDirAbs, 'SKILL.md');

      const { name: skillName, description: fullDescription } = await parseSkillFrontmatter(
        skillMdAbs,
        skillFolderName,
      );

      if (seenSkillFolderNames.has(skillFolderName)) {
        console.warn(
          `[33m[warn][0m Duplicate skill folder name '${skillFolderName}' found (folder ${groupName}/${skillFolderName}). ZIP would collide. Skipping.`,
        );
        errorCount += 1;
        continue;
      }
      seenSkillFolderNames.add(skillFolderName);

      // IMPORTANT: use the folder name as the ZIP identifier (never frontmatter)
      // to prevent path traversal via untrusted YAML.
      const zipOutAbs = path.resolve(downloadsDir, `${skillFolderName}.zip`);

      // Output boundary check: zipOutAbs MUST stay inside downloadsDir.
      const relToDownloads = path.relative(downloadsDir, zipOutAbs);
      const relToDownloadsPosix = relToDownloads.split(path.sep).join('/');
      if (
        path.isAbsolute(relToDownloads) ||
        relToDownloadsPosix === '..' ||
        relToDownloadsPosix.startsWith('../')
      ) {
        console.warn(
          `[33m[warn][0m Refusing to write zip outside downloads dir. skill=${groupName}/${skillFolderName} zipOutAbs=${zipOutAbs}`,
        );
        errorCount += 1;
        continue;
      }

      console.log(`
📦 Packaging ${skillName}...`);

      let zipSizeBytes = 0;
      let fileCount = 0;
      try {
        // Keep counts aligned with archive contents by using the same exclude rules.
        fileCount = await countIncludedFiles(skillDirAbs);

        await createSkillZip({ skillDirAbs, skillFolderName, zipOutAbs });
        const st = await fsp.stat(zipOutAbs);
        zipSizeBytes = st.size;

        console.log(`   ✅ ${skillFolderName}.zip  ${formatBytes(zipSizeBytes)}  (${fileCount} files)`);

        totalZipBytes += zipSizeBytes;
        packagedCount += 1;
      } catch (err) {
        errorCount += 1;
        console.warn(`[33m[warn][0m Failed to package ${skillName}: ${zipOutAbs}`);
        console.warn(`       ${err instanceof Error ? err.stack ?? err.message : String(err)}`);

        // Continue gracefully, but still emit metadata with 0 size.
        zipSizeBytes = 0;
      }

      const contents = await detectSkillContents(skillDirAbs);

      const skillPublic = {
        name: skillName,
        description: truncate(fullDescription, PUBLIC_DESC_MAX_CHARS),
        group: groupSlug,
        download_url: `/skills/downloads/${skillFolderName}.zip`,
        zip_size_bytes: zipSizeBytes,
        file_count: fileCount,
        contents,
      };

      const skillInternal = {
        name: skillName,
        description: fullDescription,
        group: groupSlug,
        download_url: `/skills/downloads/${skillFolderName}.zip`,
        zip_size_bytes: zipSizeBytes,
        file_count: fileCount,
        contents,
      };

      groupOutPublic.skills.push(skillPublic);
      groupOutInternal.skills.push(skillInternal);
    }

    // Ensure deterministic ordering by the manifest-visible name field.
    groupOutPublic.skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    groupOutInternal.skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    groupOutPublic.skill_count = groupOutPublic.skills.length;
    groupOutInternal.skill_count = groupOutInternal.skills.length;

    manifestPublic.groups.push(groupOutPublic);
    manifestInternal.groups.push(groupOutInternal);
  }

  manifestPublic.total_skills = manifestPublic.groups.reduce((acc, g) => acc + g.skill_count, 0);
  manifestInternal.total_skills = manifestInternal.groups.reduce((acc, g) => acc + g.skill_count, 0);

  // Schema is based on public manifest format.
  const schema = buildJsonSchema();

  await writeJsonPretty(publicManifestPath, manifestPublic);
  await writeJsonPretty(internalCatalogPath, manifestInternal);
  await writeJsonPretty(schemaPath, schema);

  console.log(`\n--- Summary ---`);
  console.log(`Groups:        ${manifestPublic.groups.length}`);
  console.log(`Skills:        ${manifestPublic.total_skills}`);
  console.log(`Packaged:      ${packagedCount}`);
  console.log(`ZIP total:     ${formatBytes(totalZipBytes)}`);
  console.log(`Warnings:      ${errorCount}`);
  console.log(`Manifest:      ${path.relative(websiteDir, publicManifestPath)}`);
  console.log(`Catalog:       ${path.relative(websiteDir, internalCatalogPath)}`);
  console.log(`Schema:        ${path.relative(websiteDir, schemaPath)}`);
  console.log('');
}

try {
  await main();
} catch (err) {
  console.error(`\n[31m[error][0m build-skills.mjs failed`);
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
}
