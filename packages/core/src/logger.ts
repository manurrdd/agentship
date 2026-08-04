import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentshipError } from './errors.js';
import { DIR_MODE, FILE_MODE, logsDir } from './paths.js';
import { redactValue } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogFields = Readonly<Record<string, unknown>>;

/** A fully built, already redacted log record. */
export interface LogRecord {
  readonly time: string;
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly msg: string;
  readonly [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` to every record. */
  child(bindings: LogFields): Logger;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly bindings?: LogFields;
  /** Overrides the default sinks entirely (used by tests). */
  readonly sinks?: readonly LogSink[];
}

function parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw === undefined) return fallback;
  const normalised = raw.trim().toLowerCase();
  return normalised in LEVEL_ORDER ? (normalised as LogLevel) : fallback;
}

/** Level configured by the operator through `AGENTSHIP_LOG_LEVEL`. */
export function defaultLogLevel(): LogLevel {
  return parseLevel(process.env['AGENTSHIP_LOG_LEVEL'], 'info');
}

/**
 * Appends JSON lines to `~/.agentship/logs/agentship-<date>.log`.
 *
 * Synchronous on purpose: log volume is low and a crash must not lose the last records
 * that explain it. Failures to write are swallowed — logging must never break a command.
 */
export function fileSink(): LogSink {
  let resolvedDir: string | undefined;
  return (record) => {
    try {
      if (resolvedDir === undefined) {
        resolvedDir = logsDir();
        mkdirSync(resolvedDir, { recursive: true, mode: DIR_MODE });
      }
      const day = record.time.slice(0, 10);
      appendFileSync(join(resolvedDir, `agentship-${day}.log`), `${JSON.stringify(record)}\n`, {
        mode: FILE_MODE,
      });
    } catch {
      // Never let logging fail a command.
    }
  };
}

/**
 * Writes to stderr. Never stdout: stdout is the MCP stdio transport and any stray byte
 * there corrupts the protocol.
 */
export function stderrSink(): LogSink {
  return (record) => {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  };
}

function defaultSinks(): LogSink[] {
  const sinks: LogSink[] = [fileSink()];
  const stderrFlag = process.env['AGENTSHIP_LOG_STDERR'];
  if (stderrFlag !== undefined && stderrFlag !== '' && stderrFlag !== '0') {
    sinks.push(stderrSink());
  }
  return sinks;
}

class StructuredLogger implements Logger {
  readonly level: LogLevel;
  readonly #bindings: LogFields;
  readonly #sinks: readonly LogSink[];
  readonly #threshold: number;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? defaultLogLevel();
    this.#threshold = LEVEL_ORDER[this.level];
    this.#bindings = options.bindings ?? {};
    this.#sinks = options.sinks ?? defaultSinks();
  }

  debug(msg: string, fields?: LogFields): void {
    this.#emit('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.#emit('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.#emit('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.#emit('error', msg, fields);
  }

  child(bindings: LogFields): Logger {
    return new StructuredLogger({
      level: this.level,
      bindings: { ...this.#bindings, ...bindings },
      sinks: this.#sinks,
    });
  }

  #emit(level: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.#threshold) return;
    const merged: Record<string, unknown> = { ...this.#bindings, ...fields };
    const err = merged['err'];
    if (AgentshipError.is(err)) merged['err'] = err.toJSON();
    const record = {
      time: new Date().toISOString(),
      level,
      msg,
      ...(redactValue(merged) as Record<string, unknown>),
    } as LogRecord;
    for (const sink of this.#sinks) sink(record);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}

let rootLogger: Logger | undefined;

/** Process-wide logger, created on first use so `AGENTSHIP_HOME` overrides are honoured. */
export function getLogger(): Logger {
  rootLogger ??= createLogger();
  return rootLogger;
}
