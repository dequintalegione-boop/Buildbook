import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = resolve(root, 'index.html');
const outputPath = resolve(root, 'Buildbook-standalone.html');

const html = await readFile(htmlPath, 'utf8');

function inlinePayload(id, source) {
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return `<script type="application/octet-stream" id="${id}">${encoded}</script>
<script>
(function () {
  const payload = document.getElementById('${id}');
  if (!payload) throw new Error('Missing bundled script payload: ${id}');
  const binary = atob(payload.textContent.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const bundled = document.createElement('script');
  bundled.textContent = new TextDecoder('utf-8').decode(bytes);
  document.head.appendChild(bundled);
})();
</script>`;
}

// Bundle every local script dependency, not just the original XLSX and
// IndexedDB files. New client modules must not silently break the standalone
// artifact when they are added to index.html.
const scriptTagPattern = /<script\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi;
const matches = [...html.matchAll(scriptTagPattern)];
if (matches.length === 0) {
  throw new Error('Expected at least one local script dependency in index.html.');
}

let standalone = html;
for (let index = matches.length - 1; index >= 0; index -= 1) {
  const match = matches[index];
  const sourcePath = match[3];
  if (/^(?:[a-z]+:|\/\/|\/)/i.test(sourcePath) || sourcePath.includes('?') || sourcePath.includes('#')) {
    throw new Error(`Standalone build cannot bundle a remote or ambiguous script dependency: ${sourcePath}`);
  }

  const absolutePath = resolve(root, sourcePath);
  const pathFromRoot = relative(root, absolutePath);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error(`Script dependency escapes the project root: ${sourcePath}`);
  }

  const source = await readFile(absolutePath, 'utf8');
  const id = `buildbook-script-payload-${index}`;
  standalone = standalone.slice(0, match.index)
    + inlinePayload(id, source)
    + standalone.slice(match.index + match[0].length);
}

if (/<script\b[^>]*\bsrc\s*=/i.test(standalone)) {
  throw new Error('The standalone template still contains an external script dependency.');
}

await writeFile(outputPath, standalone, 'utf8');
console.log(`Built ${outputPath} with ${matches.length} bundled scripts (${Buffer.byteLength(standalone, 'utf8')} bytes).`);
