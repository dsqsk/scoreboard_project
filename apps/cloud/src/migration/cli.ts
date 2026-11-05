import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createMysqlPool, decode, rows, type SqlConnection } from '../repositories/mysql-store'
import { COLLECTIONS, schemaStatements, table } from '../repositories/mysql-schema'
import { validateArchive, archiveDigest, type Archive } from './archive'
import type { Collections } from '../domain/models'
import { avatarKey } from '../http/avatars'
import { validateAvatarContent } from '../services/avatar'

async function exportArchive(c: SqlConnection): Promise<Archive> {
  const collections = {} as Archive['collections']
  for (const name of COLLECTIONS) {
    const result = await rows<{ doc: unknown }>(c, `SELECT doc FROM ${table(name)} ORDER BY id`)
    Object.assign(collections, {
      [name]: result.map((row) => decode<Collections[typeof name]>(row.doc)),
    })
  }
  return {
    schemaVersion: 1,
    environmentId: process.env.MIGRATION_ENVIRONMENT_ID ?? 'mysql-export',
    exportedAt: new Date().toISOString(),
    consistentSnapshot: true,
    collections,
  }
}
export async function rebuildHot(c: SqlConnection, archive: Archive) {
  for (const activity of archive.collections.activities) {
    const cards = archive.collections.activity_cards
      .filter((card) => card.activityId === activity._id)
      .sort((a, b) => a.number - b.number)
    const scores = archive.collections.activity_scores.filter(
      (score) => score.activityId === activity._id,
    )
    await c.execute(
      'INSERT INTO sb_activity_hot(id,activity,cards,scores) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE activity=VALUES(activity),cards=VALUES(cards),scores=VALUES(scores)',
      [activity._id, JSON.stringify(activity), JSON.stringify(cards), JSON.stringify(scores)],
    )
  }
}
async function main() {
  const [command, file] = process.argv.slice(2)
  if (!['schema', 'validate', 'stage', 'activate', 'export', 'verify', 'avatars'].includes(command))
    throw new Error(
      'Usage: migrate.cjs schema|validate|stage|activate|export|verify|avatars [file] [--final]',
    )
  const archive =
    command === 'schema' || command === 'export' || command === 'avatars'
      ? null
      : validateArchive(JSON.parse(await readFile(file, 'utf8')))
  if (command === 'validate') {
    console.info(
      JSON.stringify({
        ok: true,
        digest: archiveDigest(archive!),
        counts: Object.fromEntries(
          COLLECTIONS.map((name) => [name, archive!.collections[name].length]),
        ),
        consistentSnapshot: archive!.consistentSnapshot,
      }),
    )
    return
  }
  if (command === 'avatars') {
    // Manifest entries reference separately exported local objects. Never fetch arbitrary remote URLs.
    const manifest = JSON.parse(await readFile(file, 'utf8')) as { fileId: string; path: string }[]
    if (!Array.isArray(manifest)) throw new Error('Invalid avatar manifest')
    const directory = process.env.AVATAR_DIRECTORY
    if (!directory) throw new Error('AVATAR_DIRECTORY required')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const entry of manifest) {
      if (
        typeof entry.fileId !== 'string' ||
        !entry.fileId.startsWith('cloud://') ||
        typeof entry.path !== 'string'
      )
        throw new Error('Invalid avatar mapping')
      const source = resolve(dirname(file), entry.path),
        bytes = await readFile(source)
      validateAvatarContent(bytes)
      const target = resolve(directory, avatarKey(entry.fileId))
      try {
        const current = await readFile(target)
        if (!current.equals(bytes)) throw new Error('Avatar mapping conflict')
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
          throw error
        await copyFile(source, target, 1)
      }
    }
    console.info(JSON.stringify({ ok: true, objects: manifest.length }))
    return
  }
  if (!process.env.DB_NAME || !process.env.DB_USER)
    throw new Error('Database configuration missing')
  if (
    !/(?:rehearsal|staging|test)(?:_|$)/.test(process.env.DB_NAME) &&
    !process.argv.includes('--final')
  )
    throw new Error('Non-isolated database requires --final and consistent stopped-write export')
  if (
    process.argv.includes('--final') &&
    ((archive && !archive.consistentSnapshot) || process.env.WRITE_ENABLED === 'true')
  )
    throw new Error('Final migration requires a consistent archive and writes disabled')
  const pool = createMysqlPool({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME,
  })
  const c = await pool.getConnection()
  try {
    if (command === 'schema') {
      for (const sql of schemaStatements) await c.execute(sql)
      console.info(JSON.stringify({ ok: true, schema: 1 }))
      return
    }
    await c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await c.beginTransaction()
    if (command === 'export') {
      const snapshot = validateArchive(await exportArchive(c))
      await writeFile(file, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' })
      await c.commit()
      console.info(JSON.stringify({ ok: true, digest: archiveDigest(snapshot) }))
      return
    }
    const digest = archiveDigest(archive!)
    if (command === 'stage') {
      await c.execute('DELETE FROM sb_staging WHERE batch_id=?', [digest])
      for (const name of COLLECTIONS) {
        const docs = archive!.collections[name]
        for (let start = 0; start < docs.length; start += 100) {
          const batch = docs.slice(start, start + 100)
          await c.execute(
            `INSERT INTO sb_staging(batch_id,collection_name,id,doc) VALUES ${batch.map(() => '(?,?,?,?)').join(',')}`,
            batch.flatMap((doc) => [digest, name, doc._id, JSON.stringify(doc)]),
          )
        }
      }
    } else if (command === 'verify') {
      const current = validateArchive(await exportArchive(c))
      if (archiveDigest(current) !== digest) throw new Error('Database archive digest mismatch')
    } else if (command === 'activate') {
      const staged = { ...archive!, collections: {} as Archive['collections'] }
      for (const name of COLLECTIONS) {
        const records = await rows<{ doc: unknown }>(
          c,
          'SELECT doc FROM sb_staging WHERE batch_id=? AND collection_name=? ORDER BY id FOR UPDATE',
          [digest, name],
        )
        Object.assign(staged.collections, { [name]: records.map((row) => decode(row.doc)) })
      }
      validateArchive(staged)
      if (archiveDigest(staged) !== digest) throw new Error('Staging digest mismatch')
      const active = await rows<{ value_text: string }>(
        c,
        "SELECT value_text FROM sb_migration_meta WHERE id='active_batch' FOR UPDATE",
      )
      if (active.length) {
        if (
          active[0].value_text !== digest ||
          archiveDigest(validateArchive(await exportArchive(c))) !== digest
        )
          throw new Error('Target is active or changed; refusing overwrite')
      } else {
        for (const name of COLLECTIONS) {
          const existing = await rows<{ n: number }>(c, `SELECT COUNT(*) n FROM ${table(name)}`)
          if (Number(existing[0].n) !== 0) throw new Error('Target must be empty')
          await c.execute(
            `INSERT INTO ${table(name)}(id,doc) SELECT id,doc FROM sb_staging WHERE batch_id=? AND collection_name=?`,
            [digest, name],
          )
        }
        await rebuildHot(c, staged)
        const current = validateArchive(await exportArchive(c))
        if (archiveDigest(current) !== digest) throw new Error('Promotion verification failed')
        await c.execute("INSERT INTO sb_migration_meta(id,value_text) VALUES('active_batch',?)", [
          digest,
        ])
      }
    }
    await c.commit()
    console.info(
      JSON.stringify({
        ok: true,
        command,
        digest,
        consistentSnapshot: archive!.consistentSnapshot,
      }),
    )
  } catch (error) {
    try {
      await c.rollback()
    } catch {}
    throw error
  } finally {
    c.release()
    await pool.end()
  }
}
if (require.main === module)
  main().catch((error) => {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code
        : 'MIGRATION_FAILED'
    const validation =
      error instanceof Error && error.message.startsWith('Archive invalid:')
        ? error.message
        : undefined
    console.error(
      JSON.stringify({
        ok: false,
        stage: process.argv[2] ?? 'arguments',
        code,
        ...(validation ? { validation } : {}),
      }),
    )
    process.exitCode = 1
  })
