import pg from 'pg';
import './config';

const connectionString = process.env.DATABASE_URL;
export const pool = connectionString ? new pg.Pool({ connectionString }) : null;

pool?.on('error', (error) => {
  console.error('PostgreSQL idle connection failed:', error.message);
});

export async function readDataset<T>(name: 'bootstrap' | 'monthly'): Promise<T | null> {
  if (!pool) return null;
  try {
    const result = await pool.query<{ payload: T }>(
      'SELECT payload FROM welcomehome_api_datasets WHERE name = $1',
      [name],
    );
    return result.rows[0]?.payload ?? null;
  } catch (error) {
    console.error('PostgreSQL dataset lookup failed:', error instanceof Error ? error.message : error);
    return null;
  }
}
