import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAdmission } from './admission.js';
import { ImportError } from './importer.js';

export function openRooms(dataDir, importVideo, { now, retentionMs, r2Media }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(dataDir, 'worker.sqlite'));
  let db;
  let admission;
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
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
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
      CREATE TABLE IF NOT EXISTS ended_rooms (id TEXT PRIMARY KEY, endedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS room_publications (
        roomId TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
        objectKey TEXT NOT NULL UNIQUE,
        duration REAL NOT NULL
      );
    `);
    admission = openAdmission(db, now);
    db.prepare(`
      UPDATE rooms SET status = 'failed', error = 'interrupted'
      WHERE status IN ('downloading', 'preparing', 'publishing')
    `).run();
    for (const { id } of db.prepare(`
      SELECT id FROM rooms
      WHERE (status IN ('ready', 'media-expired') AND id IN (SELECT roomId FROM room_publications))
         OR (error = 'interrupted' AND id NOT IN (SELECT roomId FROM room_publications))
    `).all()) rmSync(mediaPath(id), { force: true });
  } catch (error) {
    db?.close();
    lock.close();
    throw error;
  }

  const find = db.prepare('SELECT * FROM rooms WHERE id = ?');
  const findSource = db.prepare('SELECT * FROM rooms WHERE bvid = ? AND part = ?');
  const insert = db.prepare('INSERT INTO rooms (id, bvid, part) VALUES (?, ?, ?)');
  const next = db.prepare("SELECT * FROM rooms WHERE status = 'queued' ORDER BY rowid LIMIT 1");
  const publication = db.prepare('SELECT objectKey, duration FROM room_publications WHERE roomId = ?');
  const stage = db.prepare('INSERT INTO room_publications VALUES (?, ?, ?)');
  const expire = db.prepare(`
    UPDATE rooms SET status = 'media-expired', error = 'media-expired', duration = NULL
    WHERE id = ? AND status = 'ready'
      AND id IN (SELECT roomId FROM room_publications WHERE objectKey = ?)
  `);
  const discardPublication = db.prepare('DELETE FROM room_publications WHERE roomId = ?');
  const requeue = db.prepare(`
    UPDATE rooms SET status = 'queued', error = NULL, duration = NULL, attempt = attempt + 1
    WHERE id = ? AND status IN ('failed', 'media-expired') AND attempt = ?
  `);
  const setStatus = db.prepare('UPDATE rooms SET status = ?, error = ?, duration = ? WHERE id = ?');
  const setMetadata = db.prepare('UPDATE rooms SET title = ?, partTitle = ? WHERE id = ?');
  const findEnded = db.prepare('SELECT 1 FROM ended_rooms WHERE id = ?');
  const markEnded = db.prepare('INSERT INTO ended_rooms VALUES (?, ?)');
  const removeRoom = db.prepare('DELETE FROM rooms WHERE id = ?');
  const expiredRooms = db.prepare('SELECT id FROM ended_rooms WHERE endedAt <= ?');
  const removeEnded = db.prepare('DELETE FROM ended_rooms WHERE id = ?');
  let job;
  let active;
  let scheduled;
  let closing = false;
  const mediaChecks = new Map();

  function get(id) {
    const room = find.get(id);
    if (!room) return null;
    const published = publication.get(id);
    let mediaUrl = null;
    if (room.status === 'ready') {
      mediaUrl = published ? r2Media?.url(published.objectKey) ?? null : '/media/' + id + '.mp4';
    }
    return {
      ...room,
      error: room.error ? new ImportError(room.error).toJSON() : null,
      mediaUrl,
      ...(mediaUrl && published && { mediaPublic: true }),
    };
  }

  async function refreshMedia(id) {
    const published = r2Media && publication.get(id);
    if (!published || find.get(id)?.status !== 'ready') return;
    const { objectKey } = published;
    let check = mediaChecks.get(id);
    if (check?.objectKey !== objectKey || (check.nextAt !== undefined && check.nextAt <= now())) {
      check = { objectKey };
      mediaChecks.set(id, check);
      // A transport or permission failure does not establish deletion.
      check.pending = r2Media.exists(objectKey).catch(() => undefined).then(exists => {
        if (exists === false && !closing) expire.run(id, objectKey);
      }).finally(() => {
        check.nextAt = now() + 5000;
        check.pending = undefined;
      });
    }
    await check.pending;
  }

  async function process(room, signal) {
    let workDir;
    const { id } = room;
    let staged = publication.get(id);
    let publishing = Boolean(staged);
    try {
      let duration = staged?.duration;
      if (!staged) {
        setStatus.run('downloading', null, null, id);
        workDir = await mkdtemp(join(workRoot, 'import-'));
        const output = join(workDir, 'ready.mp4');
        duration = await importVideo({
          source: { bvid: room.bvid, part: room.part },
          workDir,
          output,
          update(metadata) {
            if (metadata.status === 'preparing') setStatus.run('preparing', null, null, id);
            else setMetadata.run(metadata.title ?? null, metadata.partTitle ?? null, id);
          },
          signal,
        });
        signal.throwIfAborted();
        await rename(output, mediaPath(id));
        // Room end or shutdown can race the asynchronous rename.
        signal.throwIfAborted();
        if (r2Media) {
          const objectKey = randomUUID();
          stage.run(id, objectKey, duration);
          staged = { objectKey, duration };
        }
      }
      if (staged) {
        publishing = true;
        setStatus.run('publishing', null, null, id);
        if (!r2Media) throw new Error('R2 配置不可用。');
        await r2Media.publish(staged.objectKey, mediaPath(id), signal);
        signal.throwIfAborted();
      }
      setStatus.run('ready', null, duration, id);
      if (staged) await rm(mediaPath(id), { force: true }).catch(() =>
        console.error('无法清理已发布视频的临时文件。请检查数据目录。'));
    } catch (error) {
      const failure = signal.aborted ? 'interrupted'
        : publishing ? 'publication' : error instanceof ImportError ? error.code : 'processing';
      setStatus.run('failed', failure, null, id);
    } finally {
      if (workDir) await rm(workDir, { force: true, recursive: true });
    }
  }

  function schedule() {
    if (active || scheduled || closing) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      const room = next.get();
      if (!room) return;
      job = { id: room.id, controller: new AbortController() };
      active = process(room, job.controller.signal)
        .catch(() => console.error('无法保存导入状态或清理临时文件。请检查数据目录。'))
        .finally(() => {
          job = null;
          active = null;
          schedule();
        });
    });
  }

  function sweep() {
    admission.sweep();
    for (const { id } of expiredRooms.all(now() - retentionMs)) {
      if (job?.id === id) continue;
      try {
        rmSync(mediaPath(id), { force: true });
        removeEnded.run(id);
      } catch {
        console.error('无法清理已结束房间的文件。请检查数据目录。');
      }
    }
  }

  sweep();
  const cleanup = setInterval(sweep, 60_000);
  cleanup.unref();
  schedule();
  return {
    admission,
    isEnded: id => Boolean(findEnded.get(id)),
    end(id) {
      if (!find.get(id)) return false;
      db.exec('BEGIN');
      try {
        markEnded.run(id, now());
        removeRoom.run(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (job?.id === id) job.controller.abort();
      mediaChecks.delete(id);
      return true;
    },
    get,
    refreshMedia,
    mediaPath,
    submit({ bvid, part }) {
      const existing = findSource.get(bvid, part);
      if (existing) return { created: false, room: get(existing.id) };
      const id = randomUUID();
      db.exec('BEGIN');
      try {
        insert.run(id, bvid, part);
        admission.createInvitation(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      schedule();
      return { created: true, room: get(id) };
    },
    retry(id, attempt) {
      const room = get(id);
      if (!room) return null;
      if (room.error?.retryable && attempt === room.attempt) {
        if (room.status === 'media-expired') {
          // Allocate a fresh public key on reimport; the expired URL stays dead.
          db.exec('BEGIN');
          try {
            discardPublication.run(id);
            requeue.run(id, attempt);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          mediaChecks.delete(id);
        } else {
          requeue.run(id, attempt);
        }
        schedule();
      }
      return get(id);
    },
    async close() {
      closing = true;
      job?.controller.abort();
      clearInterval(cleanup);
      clearImmediate(scheduled);
      await active;
      await Promise.allSettled([...mediaChecks.values()].map(check => check.pending));
      db.close();
      lock.close();
    },
  };
}
