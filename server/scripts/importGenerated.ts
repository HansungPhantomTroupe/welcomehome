import { readFile } from 'node:fs/promises';
import { FILES } from '../src/config';
import { pool } from '../src/postgres';

async function main() {
  if (!pool) throw new Error('Set DATABASE_URL in the project root .env file.');
  const [cells, dongStats, places, meta, monthly] = await Promise.all(
    [FILES.cells, FILES.dongStats, FILES.places, FILES.meta, FILES.cellMonthly]
      .map(async (file) => JSON.parse(await readFile(file, 'utf8'))),
  );

  if (!Array.isArray(cells) || !cells.length || !Array.isArray(dongStats) ||
      !Array.isArray(places) || !meta || !Array.isArray(monthly?.months) ||
      !Array.isArray(monthly.cols) || !monthly.cells) {
    throw new Error('The generated files have an unexpected format.');
  }

  const ids = new Set(cells.map((cell) => cell.id));
  const monthlyIds = Object.keys(monthly.cells);
  const valueCount = monthly.months.length * 2 * 4 * monthly.cols.length;
  if (ids.size !== cells.length || monthlyIds.length !== ids.size ||
      monthlyIds.some((id) => !ids.has(id) || !Array.isArray(monthly.cells[id]) ||
        monthly.cells[id].length !== valueCount)) {
    throw new Error('Monthly data does not match the generated cell IDs or array lengths.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS welcomehome_api_datasets (
      name text PRIMARY KEY CHECK (name IN ('bootstrap', 'monthly')),
      payload jsonb NOT NULL
    )
  `);
  await pool.query(`
    INSERT INTO welcomehome_api_datasets (name, payload)
    VALUES ('bootstrap', $1::jsonb), ('monthly', $2::jsonb)
    ON CONFLICT (name) DO UPDATE SET payload = EXCLUDED.payload
  `, [JSON.stringify({ cells, dongStats, places, meta }), JSON.stringify(monthly)]);
  console.log(`Imported ${cells.length} cells, ${places.length} places, ${dongStats.length} districts, and ${monthlyIds.length} monthly records.`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
