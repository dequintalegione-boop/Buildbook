import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.BROWSER || 'chromium';
const browserTypes = { chromium, firefox, webkit };
const browserType = browserTypes[browserName];

if (!browserType) {
  throw new Error(`Unsupported browser "${browserName}". Choose chromium, firefox or webkit.`);
}

const browser = await browserType.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
const consoleErrors = [];

page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

console.log(`Браузер: ${browserName}`);

try {
  await page.goto('http://127.0.0.1:4173/tests/test-runner.html', {
    waitUntil: 'load',
    timeout: 30000
  });

  await page.waitForFunction(
    () => document.querySelector('#summary')?.dataset.finished === 'true',
    null,
    { timeout: 90000 }
  );

  const summary = await page.locator('#summary').innerText();
  const results = await page.locator('#results li').allTextContents();
  const failed = results.filter(line => line.startsWith('✗'));

  console.log(summary);
  for (const line of results) console.log(line);

  if (failed.length || pageErrors.length) {
    if (pageErrors.length) console.error('Ошибки JavaScript:', pageErrors.join('; '));
    if (consoleErrors.length) console.error('Ошибки консоли браузера:', consoleErrors.join('; '));
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Не удалось выполнить браузерные тесты:', error);
  const summary = await page.locator('#summary').innerText().catch(() => 'Статус тестов недоступен.');
  console.error('Последний статус тестов:', summary);
  if (pageErrors.length) console.error('Ошибки JavaScript:', pageErrors.join('; '));
  if (consoleErrors.length) console.error('Ошибки консоли браузера:', consoleErrors.join('; '));
  process.exitCode = 1;
} finally {
  await browser.close();
}
