import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDataName, NOTE_FILE_RE, type DataName } from './content.js';
import { isImageFilename } from './image-assets.js';

const LOCAL_REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LOCAL_REPO_DIRECTORIES = new Set(['src/content/posts', 'src/content/notes', 'src/pages']);
const PAGE_SLUG_RE = /^[A-Za-z0-9_-]+$/;
const LOCAL_NOTES_DIRECTORY = 'src/content/notes';
const LOCAL_POSTS_DIRECTORY = 'src/content/posts';

function getDataPath(name: string): string {
  if (!isDataName(name)) throw new Error('Unsupported local data file');
  return fileURLToPath(new URL(`../../../src/data/${name}.jsonc`, import.meta.url));
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(path);
    return entry.isFile() ? [path] : [];
  }));
  return nested.flat();
}

export async function listLocalRepoFiles(
  directory: string,
): Promise<Array<{ path: string; content: string }>> {
  if (!LOCAL_REPO_DIRECTORIES.has(directory)) throw new Error('Unsupported local repository directory');
  const absoluteDirectory = join(LOCAL_REPO_ROOT, directory);
  const paths = await collectFiles(absoluteDirectory);
  return Promise.all(paths.map(async (absolutePath) => ({
    path: relative(LOCAL_REPO_ROOT, absolutePath).split(sep).join('/'),
    content: await readFile(absolutePath, 'utf8'),
  })));
}

function getLocalNotePath(file: string): string {
  if (!NOTE_FILE_RE.test(file)) throw new Error('Unsupported local note filename');
  return join(LOCAL_REPO_ROOT, LOCAL_NOTES_DIRECTORY, file);
}

export async function readLocalNote(file: string): Promise<{ content: string; sha: string }> {
  const content = await readFile(getLocalNotePath(file), 'utf8');
  return { content, sha: hashLocalContent(content) };
}

export async function createLocalNote(file: string, content: string): Promise<void> {
  await writeFile(getLocalNotePath(file), content, { encoding: 'utf8', flag: 'wx' });
}

export async function writeLocalNote(file: string, content: string, expectedSha: string): Promise<string> {
  const filePath = getLocalNotePath(file);
  const currentContent = await readFile(filePath, 'utf8');
  if (hashLocalContent(currentContent) !== expectedSha) {
    throw Object.assign(new Error('Local file changed since it was loaded'), { code: 'CONFLICT' });
  }
  await writeFile(filePath, content, 'utf8');
  return hashLocalContent(content);
}

export async function updateLocalNote(
  file: string,
  nextFile: string,
  content: string,
  expectedSha: string,
): Promise<string> {
  const filePath = getLocalNotePath(file);
  const nextPath = getLocalNotePath(nextFile);
  const currentContent = await readFile(filePath, 'utf8');
  if (hashLocalContent(currentContent) !== expectedSha) {
    throw Object.assign(new Error('Local file changed since it was loaded'), { code: 'CONFLICT' });
  }
  if (file === nextFile) {
    await writeFile(filePath, content, 'utf8');
    return hashLocalContent(content);
  }

  await writeFile(nextPath, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await unlink(filePath);
  } catch (error) {
    await unlink(nextPath).catch((cleanupError) => {
      console.error('Failed to clean up renamed local note after rename error', cleanupError);
    });
    throw error;
  }
  return hashLocalContent(content);
}

export async function deleteLocalNote(file: string, expectedSha: string): Promise<void> {
  const filePath = getLocalNotePath(file);
  const currentContent = await readFile(filePath, 'utf8');
  if (hashLocalContent(currentContent) !== expectedSha) {
    throw Object.assign(new Error('Local file changed since it was loaded'), { code: 'CONFLICT' });
  }
  await unlink(filePath);
}

export async function readLocalNoteTemplate(): Promise<string | null> {
  try {
    return await readFile(join(LOCAL_REPO_ROOT, 'templates/notes/note.md'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeLocalImageAsset(filename: string, content: Uint8Array): Promise<void> {
  if (!isImageFilename(filename)) throw new Error('Unsupported local image filename');
  const imageDirectory = join(LOCAL_REPO_ROOT, 'public', 'img');
  await mkdir(imageDirectory, { recursive: true });
  await writeFile(join(imageDirectory, filename), content, { flag: 'wx' });
}

export async function deleteLocalImageAsset(filename: string): Promise<void> {
  if (!isImageFilename(filename)) throw new Error('Unsupported local image filename');
  await unlink(join(LOCAL_REPO_ROOT, 'public', 'img', filename));
}

export function hashLocalContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function getLocalPostPath(path: string): string {
  const segments = path.split('/');
  if (
    !path.startsWith(`${LOCAL_POSTS_DIRECTORY}/`) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    !/\.(md|mdx)$/i.test(path)
  ) {
    throw new Error('Unsupported local post path');
  }
  return join(LOCAL_REPO_ROOT, ...segments);
}

export async function writeLocalPost(path: string, content: string, expectedSha: string): Promise<string> {
  const filePath = getLocalPostPath(path);
  const currentContent = await readFile(filePath, 'utf8');
  if (hashLocalContent(currentContent) !== expectedSha) {
    throw Object.assign(new Error('Local file changed since it was loaded'), { code: 'CONFLICT' });
  }
  await writeFile(filePath, content, 'utf8');
  return hashLocalContent(content);
}

function getLocalPagePath(slug: string): string {
  if (!PAGE_SLUG_RE.test(slug)) throw new Error('Unsupported local page');
  return join(LOCAL_REPO_ROOT, 'src/pages', `${slug}.astro`);
}

export async function readLocalPage(slug: string): Promise<{ content: string; sha: string }> {
  const content = await readFile(getLocalPagePath(slug), 'utf8');
  return { content, sha: hashLocalContent(content) };
}

export async function writeLocalPage(slug: string, content: string, expectedSha: string): Promise<string> {
  const filePath = getLocalPagePath(slug);
  const currentContent = await readFile(filePath, 'utf8');
  if (hashLocalContent(currentContent) !== expectedSha) {
    throw Object.assign(new Error('Local file changed since it was loaded'), { code: 'CONFLICT' });
  }
  await writeFile(filePath, content, 'utf8');
  return hashLocalContent(content);
}

export async function createLocalPage(slug: string, content: string): Promise<void> {
  await writeFile(getLocalPagePath(slug), content, { encoding: 'utf8', flag: 'wx' });
}

export async function deleteLocalPage(slug: string, expectedSha: string): Promise<void> {
  const filePath = getLocalPagePath(slug);
  const currentContent = await readFile(filePath, 'utf8');
  if (hashLocalContent(currentContent) !== expectedSha) {
    throw Object.assign(new Error('Local file changed since it was loaded'), { code: 'CONFLICT' });
  }
  await unlink(filePath);
}

export async function readLocalPageTemplate(): Promise<string | null> {
  try {
    return await readFile(join(LOCAL_REPO_ROOT, 'templates/pages/page.astro.txt'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readLocalData(name: DataName): Promise<{ content: string; sha: string }> {
  const content = await readFile(getDataPath(name), 'utf8');
  return { content, sha: hashLocalContent(content) };
}

export async function writeLocalData(name: DataName, content: string, expectedSha: string): Promise<string> {
  const filePath = getDataPath(name);
  const currentContent = await readFile(filePath, 'utf8');
  if (hashLocalContent(currentContent) !== expectedSha) {
    throw Object.assign(new Error('Local file changed since it was loaded'), { code: 'CONFLICT' });
  }
  await writeFile(filePath, content, 'utf8');
  return hashLocalContent(content);
}
