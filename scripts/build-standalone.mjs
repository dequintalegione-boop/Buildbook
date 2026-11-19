import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = resolve(root, 'index.html');
const repositoryPath = resolve(root, 'repository.js');
const xlsxPath = resolve(root, 'vendor/xlsx.full.min.js');
const outputPath = resolve(root, 'Buildbook-standalone.html');

const [html, repository, xlsx] = await Promise.all([
  readFile(htmlPath, 'utf8'),
  readFile(repositoryPath, 'utf8'),
  readFile(xlsxPath, 'utf8')
]);

function assertOneReference(source, needle, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`Expected exactly one ${label} reference in index.html, found ${count}.`);
  }
}

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

const xlsxTag = '<script src="./vendor/xlsx.full.min.js"></script>';
const repositoryTag = '<script src="./repository.js"></script>';
const xlsxSlot = '<!-- BUILDBOOK_XLSX_BUNDLE -->';
const repositorySlot = '<!-- BUILDBOOK_REPOSITORY_BUNDLE -->';
assertOneReference(html, xlsxTag, 'SheetJS');
assertOneReference(html, repositoryTag, 'IndexedDB repository');

let standalone = html.replace(xlsxTag, xlsxSlot).replace(repositoryTag, repositorySlot);
if (standalone.includes('<script src=')) {
  throw new Error('The standalone template still contains an external script dependency.');
}
standalone = standalone.replace(xlsxSlot, inlinePayload('buildbook-xlsx-payload', xlsx));
standalone = standalone.replace(repositorySlot, inlinePayload('buildbook-repository-payload', repository));

if (standalone.includes(xlsxSlot) || standalone.includes(repositorySlot)) {
  throw new Error('A standalone bundle placeholder was not replaced.');
}

await writeFile(outputPath, standalone, 'utf8');
console.log(`Built ${outputPath} (${Buffer.byteLength(standalone, 'utf8')} bytes).`);
