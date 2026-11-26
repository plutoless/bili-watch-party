import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const invitationLifetime = 30 * 60_000;
const tokenPattern = /^[a-f0-9]{64}$/;
const newToken = () => randomBytes(32).toString('hex');
const digest = token => createHash('sha256').update(token).digest('hex');

export function openAdmission(db, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invitations (
      roomId TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY,
      roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      tokenHash TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      UNIQUE (roomId, tokenHash)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS visitor_seat ON visitors(roomId) WHERE approved = 1;
  `);
  const invitation = db.prepare('SELECT token, expiresAt FROM invitations WHERE roomId = ? AND expiresAt > ?');
  const seat = db.prepare('SELECT id FROM visitors WHERE roomId = ? AND approved = 1');
  const pending = db.prepare('SELECT id FROM visitors WHERE roomId = ? AND approved = 0 ORDER BY rowid');
  const removePending = db.prepare('DELETE FROM visitors WHERE roomId = ? AND approved = 0');
  const removeInvitation = db.prepare('DELETE FROM invitations WHERE roomId = ?');
  const insertInvitation = db.prepare('INSERT INTO invitations VALUES (?, ?, ?)');
  const insertRequest = db.prepare('INSERT INTO visitors (id, roomId, tokenHash) VALUES (?, ?, ?)');
  const visitor = db.prepare('SELECT id, approved FROM visitors WHERE roomId = ? AND tokenHash = ?');
  const approve = db.prepare('UPDATE visitors SET approved = 1 WHERE roomId = ? AND id = ?');
  const removeExpiredPending = db.prepare(`
    DELETE FROM visitors WHERE approved = 0 AND roomId IN (SELECT roomId FROM invitations WHERE expiresAt <= ?)
  `);
  const removeExpiredInvitations = db.prepare('DELETE FROM invitations WHERE expiresAt <= ?');

  function member(roomId, token) {
    return tokenPattern.test(token ?? '') ? visitor.get(roomId, digest(token)) : undefined;
  }

  function state(roomId, token) {
    const request = member(roomId, token);
    if (request?.approved) return { state: 'approved' };
    if (!request || !invitation.get(roomId, now())) return { state: 'expired' };
    if (seat.get(roomId)) return { state: 'full' };
    return { state: 'pending', requestId: request.id };
  }

  function createInvitation(roomId) {
    insertInvitation.run(roomId, newToken(), now() + invitationLifetime);
  }

  return {
    createInvitation,
    hostView(roomId) {
      const current = invitation.get(roomId, now());
      const occupied = Boolean(seat.get(roomId));
      return {
        invitation: current ?? null,
        occupied,
        requests: current && !occupied ? pending.all(roomId) : [],
      };
    },
    changeInvitation(roomId, action) {
      db.exec('BEGIN');
      try {
        removeInvitation.run(roomId);
        removePending.run(roomId);
        if (action === 'generate') createInvitation(roomId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    state,
    request(roomId, token, visitorToken) {
      const existing = state(roomId, visitorToken);
      if (existing.state !== 'expired') return existing;
      const current = invitation.get(roomId, now());
      if (!current || typeof token !== 'string' || !tokenPattern.test(token) ||
          !timingSafeEqual(Buffer.from(current.token), Buffer.from(token))) {
        return { state: 'expired' };
      }
      if (seat.get(roomId)) return { state: 'full' };
      const requestId = randomUUID();
      const newVisitorToken = newToken();
      insertRequest.run(requestId, roomId, digest(newVisitorToken));
      return { state: 'pending', requestId, visitorToken: newVisitorToken };
    },
    approve(roomId, requestId) {
      const approved = seat.get(roomId);
      if (approved) return approved.id === requestId ? 'already-approved' : null;
      if (!invitation.get(roomId, now())) return null;
      return approve.run(roomId, requestId).changes === 1 ? 'approved' : null;
    },
    isApproved(roomId, token) {
      return member(roomId, token)?.approved === 1;
    },
    hasApprovedVisitor(roomId) {
      return Boolean(seat.get(roomId));
    },
    sweep() {
      const cutoff = now();
      removeExpiredPending.run(cutoff);
      removeExpiredInvitations.run(cutoff);
    },
  };
}
