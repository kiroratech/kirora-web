import type { LogLevel } from '../types.js';

export type Log = (level: 'error' | 'debug', message: string, detail?: unknown) => void;

export function logger(logLevel: LogLevel = 'error'): Log {
  return (level, message, detail) => {
    if (logLevel === 'none' || (level === 'debug' && logLevel !== 'debug')) return;
    console[level](`Kirora: ${message}`, ...(detail === undefined ? [] : [detail]));
  };
}
