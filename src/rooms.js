import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImportError } from './importer.js';

export function openRooms(dataDir, importVideo) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(dataDir, 'worker.sqlite'));
  let db;
  const workRoot = join(dataDir, 'work');
  const mediaRoot = join(dataDir, 'media');
  const mediaPath = id => join(mediaRoot, id + '.mp4');
  try {
    // A second server must not recover or process the same local queue.
    lock.exec('BEGIN IMMEDIATE');
    rmSync(workRoot, { recursive: true, force: true });
    mkdirSync(workRoot, { mode: 0o700 });
    mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(join(dataDir, 'rooms.sqlite'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        bvid TEXT NOT NULL,
        part INTEGER NOT NULL,
        title TEXT,
        partTitle TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        attempt INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        duration REAL,
        UNIQUE (bvid, part)
      );
    `);
    const interrupted = db.prepare(`
      UPDATE rooms SET status = 'failed', error = 'interrupted'
      WHERE status IN ('downloading', 'preparing') RETURNING id
    `).all();
    for (const { id } of interrupted) rmSync(mediaPath(id), { force: true });
  } catch (error) {
    db?.close();
    lock.close();
    throw error;
  }

  const find = db.prepare('SELECT * FROM rooms WHERE id = ?');
  const findSource = db.prepare('SELECT * FROM rooms WHERE bvid = ? AND part = ?');
  const insert = db.prepare('INSERT INTO rooms (id, bvid, part) VALUES (?, ?, ?)');
  const next = db.prepare("SELECT * FROM rooms WHERE status = 'queued' ORDER BY rowid LIMIT 1");
  const requeue = db.prepare(`
    UPDATE rooms SET status = 'queued', error = NULL, duration = NULL, attempt = attempt + 1
    WHERE id = ? AND status = 'failed' AND attempt = ?
  `);
  const setStatus = db.prepare('UPDATE rooms SET status = ?, error = ?, duration = ? WHERE id = ?');
  const setMetadata = db.prepare('UPDATE rooms SET title = ?, partTitle = ? WHERE id = ?');
  const controller = new AbortController();
  let active;
  let scheduled;

  function get(id) {
    const room = find.get(id);
    if (!room) return null;
    return {
      ...room,
      error: room.error ? new ImportError(room.error).toJSON() : null,
      mediaUrl: room.status === 'ready' ? '/media/' + id + '.mp4' : null,
    };
  }

  async function process(room) {
    let workDir;
    setStatus.run('downloading', null, null, room.id);
    try {
      workDir = await mkdtemp(join(workRoot, 'import-'));
      const output = join(workDir, 'ready.mp4');
      const duration = await importVideo({
        source: { bvid: room.bvid, part: room.part },
        workDir,
        output,
        update(metadata) {
          if (metadata.status === 'preparing') setStatus.run('preparing', null, null, room.id);
          else setMetadata.run(metadata.title ?? null, metadata.partTitle ?? null, room.id);
        },
        signal: controller.signal,
      });
      await rename(output, mediaPath(room.id));
      setStatus.run('ready', null, duration, room.id);
    } catch (error) {
      const failure = controller.signal.aborted ? 'interrupted'
        : error instanceof ImportError ? error.code : 'processing';
      setStatus.run('failed', failure, null, room.id);
    } finally {
      if (workDir) await rm(workDir, { force: true, recursive: true });
    }
  }

  function schedule() {
    if (active || scheduled || controller.signal.aborted) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      const room = next.get();
      if (!room) return;
      active = process(room)
        .catch(() => console.error('无法保存导入状态或清理临时文件。请检查数据目录。'))
        .finally(() => {
          active = null;
          schedule();
        });
    });
  }

  schedule();
  return {
    get,
    mediaPath,
    submit({ bvid, part }) {
      const existing = findSource.get(bvid, part);
      if (existing) return { created: false, room: get(existing.id) };
      const id = randomUUID();
      insert.run(id, bvid, part);
      schedule();
      return { created: true, room: get(id) };
    },
    retry(id, attempt) {
      const room = get(id);
      if (!room) return null;
      if (room.status === 'failed' && room.error.retryable) {
        requeue.run(id, attempt);
        schedule();
      }
      return get(id);
    },
    async close() {
      controller.abort();
      clearImmediate(scheduled);
      await active;
      db.close();
      lock.close();
    },
  };
}
