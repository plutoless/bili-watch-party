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

  function currentPosition(now) {
    const elapsed = startsAt === null ? 0 : Math.max(0, now - startsAt) / 1000;
    return Math.min(duration, position + elapsed);
  }

  function changeTimeline() {
    version++;
  }

  function align(target, resume) {
    position = target;
    wantsPlay = resume;
    startsAt = null;
    for (const player of Object.values(players)) {
      if (player) player.ready = false;
    }
    changeTimeline();
  }

  function scheduleStart(now) {
    startsAt = now + startLeadMs;
  }

  const bothReady = () => players.host?.ready && players.visitor?.ready;

  return {
    update({ role, action, playerId, ...command }, now) {
      let expired = false;
      for (const seat of roles) {
        if (players[seat] && now - players[seat].lastSeen >= playerLeaseMs) {
          players[seat] = null;
          expired = true;
        }
      }
      if (expired) align(currentPosition(now), false);
      if (startsAt !== null && currentPosition(now) >= duration) align(duration, false);

      const player = players[role];
      const ownsSeat = player?.id === playerId;
      if (ownsSeat) player.lastSeen = now;
      let conflict = false;
      if (action !== 'observe') {
        if (command.epoch !== epoch || command.version !== version) conflict = true;
        else if (action === 'ready') {
          if ((!ownsSeat && (command.claim !== true || player)) || startsAt !== null ||
              Math.abs(command.position - position) > alignmentTolerance) {
            conflict = true;
          } else if (!player?.ready) {
            players[role] = { id: playerId, ready: true, blocked: false, lastSeen: now };
            if (wantsPlay && bothReady()) scheduleStart(now);
          }
        } else if (!ownsSeat) conflict = true;
        else if (action === 'blocked') {
          align(currentPosition(now), wantsPlay);
          player.blocked = true;
        } else if (action === 'pause') {
          if (wantsPlay) align(currentPosition(now), false);
        } else if (action === 'seek') {
          const target = Math.min(duration, Math.max(0, command.position));
          align(target, wantsPlay && target < duration);
        } else if (action === 'play') {
          if (!bothReady()) conflict = true;
          else if (!wantsPlay) {
            wantsPlay = true;
            if (position === duration) align(0, true);
            else {
              scheduleStart(now);
              changeTimeline();
            }
          }
        }
      }
      return {
        conflict,
        state: {
          epoch, version, position, startsAt, wantsPlay, serverTime: now,
          ready: Object.fromEntries(roles.map(seat => [seat, Boolean(players[seat]?.ready)])),
          blocked: roles.filter(seat => players[seat]?.blocked),
          ownsSeat: players[role]?.id === playerId,
          otherPlayer: Boolean(players[role] && players[role].id !== playerId),
        },
      };
    },
  };
}
