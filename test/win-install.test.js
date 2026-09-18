import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectWrapper, removeWrapper, psQuote, profilePathFor, MARKER_START, MARKER_END } from '../bin/cli.js';

const PS_TEMPLATE = join(import.meta.dirname, '..', 'src', 'wrapper.ps1');

async function tmpFile(name, content = '') {
  const dir = await mkdtemp(join(tmpdir(), 'car-win-'));
  const file = join(dir, name);
  if (content) await writeFile(file, content);
  return file;
}

describe('psQuote', () => {
  it('doubles apostrophes for a PowerShell single-quoted string', () => {
    assert.equal(psQuote("C:\\Users\\O'Brien\\launcher.js"), "C:\\Users\\O''Brien\\launcher.js");
  });
  it('leaves backslashes alone: they are literal inside single quotes', () => {
    assert.equal(psQuote('C:\\Program Files\\x\\launcher.js'), 'C:\\Program Files\\x\\launcher.js');
  });
});

describe('injectWrapper with the PowerShell template', () => {
  it('writes a claude function carrying the launcher path', async () => {
    const profile = await tmpFile('Profile.ps1');
    await injectWrapper(profile, 'C:\\tools\\car\\src\\launcher.js', PS_TEMPLATE);

    const out = await readFile(profile, 'utf-8');
    assert.match(out, /function claude \{/);
    assert.match(out, /C:\\tools\\car\\src\\launcher\.js/);
    assert.ok(out.includes(MARKER_START) && out.includes(MARKER_END));
  });

  it('escapes an apostrophe in the path so the profile still parses', async () => {
    const profile = await tmpFile('Profile.ps1');
    await injectWrapper(profile, "C:\\Users\\O'Brien\\launcher.js", PS_TEMPLATE);

    const out = await readFile(profile, 'utf-8');
    assert.match(out, /\$launcher = 'C:\\Users\\O''Brien\\launcher\.js'/);
  });

  it('preserves the user content already in the profile', async () => {
    const profile = await tmpFile('Profile.ps1', 'Set-Alias ll Get-ChildItem\n');
    await injectWrapper(profile, 'C:\\x\\launcher.js', PS_TEMPLATE);

    assert.match(await readFile(profile, 'utf-8'), /Set-Alias ll Get-ChildItem/);
  });

  it('is idempotent: a second install does not stack two functions', async () => {
    const profile = await tmpFile('Profile.ps1');
    await injectWrapper(profile, 'C:\\x\\launcher.js', PS_TEMPLATE);
    await injectWrapper(profile, 'C:\\y\\launcher.js', PS_TEMPLATE);

    const out = await readFile(profile, 'utf-8');
    assert.equal(out.split('function claude {').length - 1, 1);
    assert.match(out, /C:\\y\\launcher\.js/);
    assert.doesNotMatch(out, /C:\\x\\launcher\.js/);
  });

  it('removeWrapper takes the block back out and leaves the rest', async () => {
    const profile = await tmpFile('Profile.ps1', 'Set-Alias ll Get-ChildItem\n');
    await injectWrapper(profile, 'C:\\x\\launcher.js', PS_TEMPLATE);
    await removeWrapper(profile);

    const out = await readFile(profile, 'utf-8');
    assert.doesNotMatch(out, /function claude/);
    assert.match(out, /Set-Alias ll Get-ChildItem/);
  });
});

describe('profilePathFor', () => {
  it('returns the path the shell reports for itself', () => {
    const run = () => 'C:\\Users\\x\\OneDrive\\Documents\\PowerShell\\Profile.ps1\r\n';
    assert.equal(profilePathFor('pwsh.exe', run), 'C:\\Users\\x\\OneDrive\\Documents\\PowerShell\\Profile.ps1');
  });

  it('returns null when that PowerShell edition is not installed', () => {
    const run = () => { throw new Error('ENOENT'); };
    assert.equal(profilePathFor('pwsh.exe', run), null);
  });

  it('returns null on empty output rather than an empty path', () => {
    assert.equal(profilePathFor('pwsh.exe', () => '  \n'), null);
  });
});
