import type { ColumnDataType } from 'kysely';
import type { Dialect } from './schema.js';

/** Logical column types mapped to physical ones per dialect (ADR-0003). */
export function columnTypes(dialect: Dialect): {
  id: ColumnDataType;
  json: ColumnDataType;
  timestamp: ColumnDataType;
  bool: ColumnDataType;
} {
  return dialect === 'postgres'
    ? { id: 'uuid', json: 'jsonb', timestamp: 'timestamptz', bool: 'boolean' }
    : { id: 'text', json: 'text', timestamp: 'text', bool: 'integer' };
}
