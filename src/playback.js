import { randomUUID } from 'node:crypto';

const startLeadMs = 900;
const playerLeaseMs = 4_000;
const alignmentTolerance = 0.12;
const roles = ['host', 'visitor'];

export function createPlayback(duration) {
  const epoch = randomUUID();
  const players = { host: null, visitor: null };
  let position = 0;
  let startsAt = null;
  let wantsPlay = false;
  let version = 0;
  let hostCommandVersion = 0;

  function currentPosition(now) {
    const elapsed = startsAt === null ? 0 : Math.max(0, now - startsAt) / 1000;
    return Math.min(duration, position + elapsed);
  }

  function align(target, resume) {
    position = target;
    wantsPlay = resume;
    startsAt = null;
    for (const player of Object.values(players)) {
      if (player) player.ready = false;
    }
    version++;
  }

  function scheduleStart(now) {
    startsAt = now + startLeadMs;
  }

  const bothReady = () => players.host?.ready && players.visitor?.ready;

  function interrupt(player, reason, now, observedPosition) {
    const projected = currentPosition(now);
    const reported = observedPosition ?? (player.progress?.version === version ? player.progress.position : undefined);
    // Resume no later than the last confirmed frame on this timeline.
    const target = startsAt === null || !Number.isFinite(reported) ? projected
      : Math.max(position, Math.min(projected, reported));
    align(target, wantsPlay && target < duration);
    player.waiting = reason;
  }

  function expirePlayers(now) {
    const expiring = Object.values(players)
      .filter(player => player?.lastSeen != null && now - player.lastSeen >= playerLeaseMs)
      .sort((first, second) => first.lastSeen - second.lastSeen);
    for (const player of expiring) {
      interrupt(player, 'connection', player.lastSeen);
      player.lastSeen = null;
    }
  }

  return {
    update({ role, action, playerId, ...command }, now) {
      expirePlayers(now);
      if (startsAt !== null && currentPosition(now) >= duration) align(duration, false);

      const player = players[role];
      const ownsSeat = player?.id === playerId;
      let conflict = false;
      if (action === 'recover') {
        if (!ownsSeat) {
          if (player?.id !== command.previousPlayerId) conflict = true;
          else {
            interrupt(player, 'connection', now);
            player.id = playerId;
            player.blocked = false;
          }
        }
      } else if (action !== 'observe') {
        // Readiness and interruptions may advance the timeline while a host pause is in flight.
        const concurrentPause = action === 'pause' &&
          Number.isInteger(command.version) && command.version >= hostCommandVersion && command.version <= version;
        if (command.epoch !== epoch || (command.version !== version && !concurrentPause)) conflict = true;
        else if (action === 'ready') {
          if ((!ownsSeat && (command.claim !== true || player?.lastSeen != null)) ||
              startsAt !== null ||
              Math.abs(command.position - position) > alignmentTolerance) {
            conflict = true;
          } else if (!player?.ready) {
            players[role] = { id: playerId, ready: true, blocked: false, waiting: null, lastSeen: now };
            if (wantsPlay && bothReady()) scheduleStart(now);
          }
        } else if (!ownsSeat) conflict = true;
        else if (action === 'unavailable') {
          interrupt(player, command.reason, now, command.position);
        } else if (action === 'blocked') {
          interrupt(player, null, now);
          player.blocked = true;
        } else if (action === 'pause') {
          if (wantsPlay) align(currentPosition(now), false);
          hostCommandVersion = version;
        } else if (action === 'seek') {
          const target = Math.min(duration, Math.max(0, command.position));
          align(target, wantsPlay && target < duration);
          hostCommandVersion = version;
        } else if (action === 'play') {
          if (!bothReady()) conflict = true;
          else if (!wantsPlay) {
            wantsPlay = true;
            if (position === duration) align(0, true);
            else {
              scheduleStart(now);
              version++;
            }
            hostCommandVersion = version;
          }
        }
      }
      const currentPlayer = players[role];
      if (!conflict && currentPlayer?.id === playerId) {
        currentPlayer.lastSeen = now;
        if (action === 'observe' && startsAt !== null && command.epoch === epoch &&
            command.version === version && Number.isFinite(command.position)) {
          currentPlayer.progress = { version, position: command.position };
        }
      }
      return {
        conflict,
        state: {
          epoch, version, position, startsAt, wantsPlay, serverTime: now,
          ready: Object.fromEntries(roles.map(seat => [seat, Boolean(players[seat]?.ready)])),
          waiting: Object.fromEntries(roles.map(seat => [seat, players[seat]?.waiting ?? null])),
          blocked: roles.filter(seat => players[seat]?.blocked),
          ownsSeat: currentPlayer?.id === playerId,
          otherPlayer: currentPlayer?.lastSeen != null && currentPlayer.id !== playerId,
        },
      };
    },
  };
}
