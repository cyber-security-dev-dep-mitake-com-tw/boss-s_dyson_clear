import { describe, it, expect } from 'vitest';
import { parseUninstallString } from '../src/executor/uninstaller.js';
import { parseRegUninstallOutput } from '../src/scanners/apps.js';
import { killProcess } from '../src/executor/prockiller.js';

describe('parseUninstallString (win32 — never shell:true)', () => {
  it('parses MsiExec /X{guid}', () => {
    expect(parseUninstallString('MsiExec.exe /X{ABC-123}')).toEqual({
      cmd: 'MsiExec.exe',
      args: ['/X{ABC-123}'],
    });
  });

  it('parses quoted exe paths with args', () => {
    expect(parseUninstallString('"C:\\Program Files\\Foo\\unins000.exe" /SILENT')).toEqual({
      cmd: 'C:\\Program Files\\Foo\\unins000.exe',
      args: ['/SILENT'],
    });
  });

  it('rejects empty / unterminated strings', () => {
    expect(parseUninstallString('')).toBeNull();
    expect(parseUninstallString('"C:\\broken')).toBeNull();
  });
});

describe('parseRegUninstallOutput', () => {
  it('extracts DisplayName/Version/Publisher/InstallLocation per key', () => {
    const sample = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID-1}',
      '    DisplayName    REG_SZ    Foo App',
      '    DisplayVersion    REG_SZ    1.2.3',
      '    Publisher    REG_SZ    Foo Corp',
      '    InstallLocation    REG_SZ    C:\\Program Files\\Foo',
      '    UninstallString    REG_SZ    MsiExec.exe /X{GUID-1}',
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NoName',
      '    SystemComponent    REG_DWORD    0x1',
      '',
    ].join('\r\n');
    const apps = parseRegUninstallOutput(sample);
    expect(apps).toHaveLength(1); // entries without DisplayName are skipped
    expect(apps[0]).toMatchObject({
      name: 'Foo App',
      version: '1.2.3',
      publisher: 'Foo Corp',
      installPath: 'C:\\Program Files\\Foo',
      platform: 'win32',
    });
    expect(apps[0].key).toContain('{GUID-1}');
  });
});

describe('killProcess refusal guards', () => {
  it('refuses pid 0, 1, low pids and itself', async () => {
    expect((await killProcess(0)).ok).toBe(false);
    expect((await killProcess(1)).ok).toBe(false);
    expect((await killProcess(99)).ok).toBe(false);
    expect((await killProcess(process.pid)).ok).toBe(false);
    expect((await killProcess(1.5)).ok).toBe(false);
  });

  it('kills a real child process via SIGTERM', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 100));
    const res = await killProcess(child.pid!);
    expect(res.ok).toBe(true);
  });
});
