#!/usr/bin/env node
// Apply db/schema.sql to the Tiger Data service (no psql needed).
//
//   node --env-file=.env db/apply-schema.mjs
//
// Runs each statement in schema.sql in order and prints what was created.
// The schema is written to be re-runnable (IF NOT EXISTS everywhere), so it
// is safe to apply again after a feed refresh changes nothing structurally.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.TIGER_DATABASE_URL) {
    console.error('Set TIGER_DATABASE_URL in .env (copy .env.example). Aborting.');
    process.exit(1);
}

// schema.sql contains no string literals, so stripping "--" comments (whole
// line or trailing) is safe. Statements are then split on ";" — except that
// semicolons inside $$ dollar-quoted bodies (the DO block that wraps
// CREATE VIEW) must not split, so the scanner tracks $$ quoting.
function splitStatements(sqlText) {
    const withoutComments = sqlText
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n');

    const statements = [];
    let current = '';
    let inDollarQuote = false;
    for (let i = 0; i < withoutComments.length; i++) {
        const twoChars = withoutComments.slice(i, i + 2);
        if (twoChars === '$$') {
            inDollarQuote = !inDollarQuote;
            current += '$$';
            i++;
            continue;
        }
        if (withoutComments[i] === ';' && !inDollarQuote) {
            const statement = current.trim();
            if (statement) statements.push(statement);
            current = '';
            continue;
        }
        current += withoutComments[i];
    }
    const last = current.trim();
    if (last) statements.push(last);
    return statements;
}

const client = new pg.Client({ connectionString: process.env.TIGER_DATABASE_URL });
await client.connect();

try {
    const schemaText = await readFile(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
    const statements = splitStatements(schemaText);
    for (const [i, statement] of statements.entries()) {
        // Show the first line of each statement so progress is readable.
        const label = statement.split('\n')[0].slice(0, 72);
        try {
            await client.query(statement);
            console.log(`[${i + 1}/${statements.length}] ok: ${label}`);
        } catch (error) {
            // "already exists" on a re-run is fine; anything else stops here.
            if (/already exists/i.test(error.message)) {
                console.log(`[${i + 1}/${statements.length}] skip (exists): ${label}`);
            } else {
                throw error;
            }
        }
    }

    // Summarize what the service now contains.
    const { rows } = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
    `);
    console.log('\nTables now in the service:');
    for (const row of rows) console.log(`  ${row.table_name}`);
    console.log('\nSchema applied. Next: node --env-file=.env db/load.mjs');
} finally {
    await client.end();
}
