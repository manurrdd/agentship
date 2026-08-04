import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentshipError, ERROR_CODES } from '../src/errors.js';
import { createLogger, type LogRecord } from '../src/logger.js';
import { logsDir } from '../src/paths.js';
import { clearRegisteredSecrets, registerSecret } from '../src/redact.js';
import { withTempHome } from './helpers.js';

function collecting(): { records: LogRecord[]; sink: (r: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, sink: (r) => records.push(r) };
}

describe('logger', () => {
  it('emits structured records with level, time and message', () => {
    const { records, sink } = collecting();
    createLogger({ level: 'debug', sinks: [sink] }).info('hello', { appId: 'com.example' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 'info', msg: 'hello', appId: 'com.example' });
    expect(Date.parse(records[0]?.time ?? '')).not.toBeNaN();
  });

  it('filters below the configured level', () => {
    const { records, sink } = collecting();
    const log = createLogger({ level: 'warn', sinks: [sink] });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('merges child bindings', () => {
    const { records, sink } = collecting();
    createLogger({ level: 'debug', sinks: [sink] })
      .child({ tool: 'asc' })
      .child({ store: 'apple' })
      .info('run');
    expect(records[0]).toMatchObject({ tool: 'asc', store: 'apple' });
  });

  it('redacts secrets in fields and in the message payload', () => {
    clearRegisteredSecrets();
    registerSecret('CANARY-KEYRING-VALUE');
    const { records, sink } = collecting();
    createLogger({ level: 'debug', sinks: [sink] }).info('uploading', {
      privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      note: 'value CANARY-KEYRING-VALUE here',
      nested: { authorization: 'Bearer abc.def' },
    });
    const dumped = JSON.stringify(records[0]);
    expect(dumped).not.toContain('CANARY-KEYRING-VALUE');
    expect(dumped).not.toContain('BEGIN PRIVATE KEY');
    expect(dumped).toContain('[REDACTED]');
    clearRegisteredSecrets();
  });

  it('serialises AgentshipError under the `err` field', () => {
    const { records, sink } = collecting();
    createLogger({ level: 'debug', sinks: [sink] }).error('failed', {
      err: new AgentshipError(ERROR_CODES.STORE_RATE_LIMITED, 'slow down'),
    });
    expect(records[0]?.['err']).toMatchObject({
      code: 'STORE_RATE_LIMITED',
      retryable: true,
      message: 'slow down',
    });
  });

  it('writes JSON lines under AGENTSHIP_HOME/logs', async () => {
    await withTempHome(async () => {
      createLogger({ level: 'info' }).info('to disk', { marker: 'abc123' });
      const dir = logsDir();
      const files = await readdir(dir);
      expect(files.some((f) => f.startsWith('agentship-'))).toBe(true);
      const content = await readFile(join(dir, files[0] as string), 'utf8');
      const parsed = JSON.parse(content.trim().split('\n')[0] as string) as LogRecord;
      expect(parsed).toMatchObject({ msg: 'to disk', marker: 'abc123' });
    });
  });
});
