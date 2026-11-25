import { randomUUID } from 'node:crypto';

const startLeadMs = 900;
const initialFirstStartLeadMs = 5600;
const maximumFirstStartLeadMs = 12000;
const playerLeaseMs = 4_000;
const progressLeaseMs = 650;
const firstStartProgressLeaseMs = 2200;
// A client may still be waiting on its pre-release reply. Allow two request timeouts plus a poll.
const releaseDeliveryMs = 4400;
const minimumPreviewDuration = 1;
const alignmentTolerance = 0.12;
const maxRecoveryRewind = 2;
const roles = ['host', 'visitor'];

export function createPlayback(duration = Infinity) {
  const epoch = randomUUID();
  const players = { host: null, visitor: null };
  let position = 0;
  let startsAt = null;
  let wantsPlay = false;
  let firstStart = null;
  let firstStartLeadMs = initialFirstStartLeadMs;
  let ended = false;
  let version = 0;
  let hostCommandVersion = 0;
  let lastHostSeek;

  function currentPosition(now) {
    const elapsed = startsAt === null ? 0 : Math.max(0, now - startsAt) / 1000;
    return Math.min(duration, position + elapsed);
  }

  function align(target, resume) {
    position = target;
    if (target < duration) ended = false;
    wantsPlay = resume;
    startsAt = null;
    for (const player of Object.values(players)) {
      if (player) {
        player.ready = false;
        player.startAcknowledgment = null;
        player.startConfirmation = null;
      }
    }
    version++;
  }

  function scheduleStart(now) {
    if (firstStart === 'preview' && duration - position <= minimumPreviewDuration) firstStart = 'armed';
    startsAt = now + (firstStart === 'armed' ? firstStartLeadMs : startLeadMs);
  }

  const bothReady = () => players.host?.ready && players.visitor?.ready;
  const firstStartPending = () => ['preview', 'armed', 'starting'].includes(firstStart);
  const startAcknowledged = () => startsAt !== null &&
    roles.every(seat => players[seat]?.startAcknowledgment === startsAt);
  const startConfirmed = () => startsAt !== null &&
    roles.every(seat => players[seat]?.startConfirmation === startsAt);

  function newSeat(playerId, recoveryId, now) {
    return { id: playerId, recoveryId: recoveryId ?? playerId, recoveryGeneration: 0,
      ready: false, blocked: false, waiting: null, lastSeen: now };
  }

  function pause(now) {
    // Until both players confirm first playback, keep the target they were preparing.
    if (firstStartPending()) startsAt = null;
    firstStart = null;
    lastHostSeek = undefined;
    if (wantsPlay) align(currentPosition(now), false);
    hostCommandVersion = version;
  }

  function play(now) {
    lastHostSeek = undefined;
    if (wantsPlay) return;
    if (position === duration) align(0, true);
    else {
      wantsPlay = true;
      if (bothReady()) scheduleStart(now);
      version++;
    }
    hostCommandVersion = version;
  }

  function interrupt(player, reason, now, observedPosition) {
    const projected = currentPosition(now);
    const reported = observedPosition ?? (player.progress?.version === version ? player.progress.position : undefined);
    // Allow a short recovery rewind without treating a participant's report as a seek.
    const lastContact = reason === 'connection' ? player.lastSeen ?? now : now;
    const floor = Math.max(position, currentPosition(lastContact) - maxRecoveryRewind);
    const target = firstStartPending() ? position : startsAt === null || !Number.isFinite(reported) ? projected
      : Math.max(floor, Math.min(projected, reported));
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
    setDuration(seconds) { duration = seconds; },
    startOnApproval() {
      firstStart = 'preview';
      align(0, true);
      hostCommandVersion = version;
    },
    get firstStartPending() { return firstStartPending(); },
    cancelFirstStart(playerId, now) {
      expirePlayers(now);
      if (!firstStart) return true;
      if (players.host?.lastSeen != null && players.host.id !== playerId) return false;
      pause(now);
      return true;
    },
    update({ role, action, playerId, ...command }, now) {
      expirePlayers(now);
      if (firstStart === 'armed' && startsAt !== null && now >= startsAt - releaseDeliveryMs &&
          !startConfirmed()) {
        firstStartLeadMs = Math.min(maximumFirstStartLeadMs, firstStartLeadMs * 2);
        scheduleStart(now);
      }
      if (firstStart === 'armed' && startsAt !== null && now >= startsAt && startConfirmed()) {
        firstStart = 'starting';
      }
      const shortFirstStart = firstStart !== null && duration - position <= minimumPreviewDuration;
      if (startsAt !== null && currentPosition(now) >= duration && !firstStartPending() && !shortFirstStart) {
        align(duration, false);
        ended = true;
        firstStart = null;
      }

      const player = players[role];
      const ownsSeat = player?.id === playerId;
      let conflict = false;
      if (action === 'recover') {
        const sameSeat = player && player.recoveryId === command.recoveryId;
        if (ownsSeat) {
          conflict = command.recoveryId !== undefined &&
            (!sameSeat || command.recoveryGeneration !== player.recoveryGeneration);
        } else {
          // New documents carry the same seat ID and a strictly increasing generation across lost replies.
          const canRecover = player && (sameSeat ? command.recoveryGeneration > player.recoveryGeneration
            : player.id === command.previousPlayerId || command.fallbackPlayerIds?.includes(player.id));
          if (!canRecover) conflict = true;
          else {
            interrupt(player, 'connection', now);
            if (role === 'host' && lastHostSeek?.playerId === player.id) lastHostSeek.playerId = playerId;
            player.id = playerId;
            player.recoveryId = command.recoveryId ?? playerId;
            player.recoveryGeneration = command.recoveryGeneration ?? 0;
            player.blocked = false;
          }
        }
      } else if (action !== 'observe') {
        // Readiness and interruptions may advance the timeline while a host pause is in flight.
        const concurrentPause = action === 'pause' &&
          Number.isInteger(command.version) && command.version >= hostCommandVersion && command.version <= version;
        // A newer local pause may follow a seek whose acknowledgment never reached this host.
        const pauseAfterSeek = action === 'pause' && role === 'host' && ownsSeat &&
          lastHostSeek?.playerId === playerId && command.afterSeekId === lastHostSeek.id &&
          command.version === lastHostSeek.previousVersion;
        if (command.epoch !== epoch || (command.version !== version && !concurrentPause && !pauseAfterSeek)) conflict = true;
        else if (action === 'ready') {
          if ((!ownsSeat && (command.claim !== true || player?.lastSeen != null)) ||
              startsAt !== null ||
              Math.abs(command.position - position) > alignmentTolerance) {
            conflict = true;
          } else if (!player?.ready) {
            players[role] = {
              id: playerId,
              recoveryId: ownsSeat ? player.recoveryId : command.recoveryId ?? playerId,
              recoveryGeneration: ownsSeat ? player.recoveryGeneration : 0,
              ready: true, blocked: false, waiting: null, lastSeen: now,
            };
            if (wantsPlay && bothReady()) scheduleStart(now);
          }
        } else if (action === 'play' && command.waitForReadiness === true &&
            (ownsSeat || (command.claim === true && player?.lastSeen == null))) {
          if (!ownsSeat) players[role] = newSeat(playerId, command.recoveryId, now);
          play(now);
        } else if (action === 'blocked' && !ownsSeat && command.claim === true &&
            player?.lastSeen == null && startsAt === null) {
          players[role] = { ...newSeat(playerId, command.recoveryId, now), blocked: true };
        } else if (!ownsSeat) conflict = true;
        else if (action === 'unavailable') {
          interrupt(player, command.reason, now, command.position);
        } else if (action === 'blocked') {
          interrupt(player, null, now);
          player.blocked = true;
        } else if (action === 'pause') {
          pause(now);
        } else if (action === 'seek') {
          const target = Math.min(duration, Math.max(0, command.position));
          ended = false;
          if (firstStart === 'confirmed') firstStart = null;
          align(target, wantsPlay && target < duration);
          hostCommandVersion = version;
          lastHostSeek = command.seekId ? { id: command.seekId, playerId, previousVersion: command.version } : undefined;
        } else if (action === 'play') {
          if (!bothReady()) conflict = true;
          else play(now);
        }
      }
      const currentPlayer = players[role];
      if (!conflict && currentPlayer?.id === playerId) {
        currentPlayer.lastSeen = now;
        if (action === 'observe' && startsAt !== null && command.epoch === epoch &&
            command.version === version && Number.isFinite(command.position)) {
          const previous = currentPlayer.progress;
          const sameTimeline = previous?.version === version;
          const observedAt = Number.isFinite(command.observedAt)
            ? Math.max(now - 500, Math.min(now + 100, command.observedAt)) : now;
          const sampledAt = Number.isFinite(command.sampledAt) ? command.sampledAt : now;
          const moving = command.playing === true && observedAt >= startsAt && command.position > position + 0.03;
          const advanced = moving && sameTimeline && command.position > previous.position;
          const advancedAt = advanced ? now : moving && sameTimeline ? previous.advancedAt : undefined;
          const stoppedSince = observedAt >= startsAt && !advanced && command.ended !== true
            ? (sameTimeline ? previous.stoppedSince : undefined) ?? sampledAt : undefined;
          currentPlayer.progress = { version, position: command.position, at: observedAt, advancedAt, sampledAt, stoppedSince,
            finished: command.ended === true && command.position >= duration - alignmentTolerance };
          if (firstStart === 'armed' && command.startAcknowledgment === startsAt &&
              Math.abs(command.position - position) <= alignmentTolerance) {
            currentPlayer.startAcknowledgment = startsAt;
            if (startAcknowledged() && command.startConfirmation === startsAt) {
              currentPlayer.startConfirmation = startsAt;
            }
          }
        }
      }
      // A missing report is different from consecutive samples proving the media clock stopped.
      const stopped = roles.filter(seat => {
        const progress = players[seat]?.progress;
        return progress?.version === version && progress.sampledAt - progress.stoppedSince >= progressLeaseMs;
      });
      const lease = firstStartPending() ? firstStartProgressLeaseMs : progressLeaseMs;
      const advancing = Object.fromEntries(roles.map(seat => {
        const progress = players[seat]?.progress;
        return [seat, startsAt !== null && progress?.version === version &&
          !stopped.includes(seat) && now - progress.advancedAt <= lease];
      }));
      const playbackGap = advancing.host && advancing.visitor
        ? Math.abs((players.host.progress.position - players.host.progress.at / 1000) -
          (players.visitor.progress.position - players.visitor.progress.at / 1000)) : null;
      const aligned = playbackGap !== null && playbackGap < 0.5;
      if (firstStart === 'starting' && aligned) firstStart = 'confirmed';
      if (shortFirstStart && (firstStart === 'starting' || firstStart === 'confirmed') && currentPosition(now) >= duration &&
          roles.every(seat => players[seat]?.progress?.version === version && players[seat].progress.finished)) {
        align(duration, false);
        ended = true;
        firstStart = null;
      }
      // Use the silent preview as evidence that both players can advance, then start
      // the real playback from the original target after both players align again.
      const previewComplete = firstStart === 'preview' && aligned;
      const previewStalled = firstStart === 'preview' && startsAt !== null &&
        (stopped.length > 0 || currentPosition(now) >= duration);
      const startStalled = firstStart === 'starting' && stopped.length > 0;
      if (previewComplete || previewStalled || startStalled) {
        const stalled = previewComplete ? [] : stopped.length ? stopped : roles.filter(seat => !advancing[seat]);
        if (previewComplete) firstStart = 'armed';
        if (startStalled) firstStart = 'preview';
        align(position, true);
        for (const seat of roles) {
          advancing[seat] = false;
          if (stalled.includes(seat)) players[seat].waiting = 'buffering';
        }
      }
      const preview = firstStart === 'preview';
      return {
        conflict,
        state: {
          epoch, version, position, startsAt, wantsPlay, ended, serverTime: now,
          firstStartPending: firstStartPending(), preview, awaitingStart: firstStart === 'armed',
          startAcknowledged: firstStart === 'armed' && startAcknowledged(),
          startConfirmed: firstStart !== 'armed' || startConfirmed(), advancing,
          synchronized: !firstStartPending() && aligned,
          playbackGap: previewComplete || previewStalled || startStalled ? null : playbackGap,
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
