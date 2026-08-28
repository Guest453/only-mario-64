// ============================================================
// src/modes.js — input arbitration. Runs ONLY on the host, but every
// function here is pure enough to unit-test in Node (see ../test).
//
// The premise of this Activity: one SM64 engine, one Mario, many players.
// "Multiplayer" therefore means *deciding whose buttons reach the emulator this
// frame*, which is exactly what these modes are. Everything else (roster,
// votes, chat, presence, invites) is Discord's job.
// ============================================================

import { BTN, GROUPS, STICK_BITS, clamp, majority, union, modeById } from './protocol.js';

export class Arbitrator {
    constructor({ mode = 'solo', opts = {}, selfCid = null } = {}) {
        this.mode = mode;
        this.opts = { ...modeById(mode).opts, ...opts };
        this.selfCid = selfCid;
        this.inputs = new Map();       // cid → last mask seen from that player
        this.players = [];             // [{cid,name,ready}] — ready == engine loaded
        this.window = -Infinity;       // start of the current decision window
        this.held = 0;                 // mask applied during the current window
        this.carry = 0;                // held keys carried across windows (stick momentum)
        this.note = '';
        this.padHolder = null;         // hot potato
        this.padUntil = 0;
        this.padLockUntil = 0;         // after a storm, the new holder is safe briefly
        this.storms = 0;               // how often the crowd took the pad by force
        this.heckle = new Map();       // cid → ms of A-button pressing in the last second
        this.groupOf = new Map();      // coop: cid → group id
        this.offset = 0;               // coop: rotation offset, synced via room state
        this.reassign();
    }

    setPlayers(players) {
        this.players = players || [];
        // A player leaving can strand a control group; re-map when the roster moves.
        const live = new Set(this.players.map((p) => p.cid));
        for (const [cid] of [...this.groupOf]) if (!live.has(cid)) this.groupOf.delete(cid);
        for (const cid of [...this.inputs.keys()]) if (!live.has(cid)) this.inputs.delete(cid);
        this.reassign(true);
    }

    setInput(cid, bits) { this.inputs.set(cid, bits | 0); }

    /** Group assignment for CO-OP: ready players take groups in join order. */
    /** Shift everyone's control group by one (or to `n`, from room state). */
    rotate(n) {
        this.offset = typeof n === 'number' ? n : this.offset + 1;
        this.reassign();
        return this.offset;
    }

    reassign(keep = false) {
        if (keep && this.groupOf.size) {
            // Only fill groups that lost their owner, so keys don't jump around.
            const taken = new Set(this.groupOf.values());
            const free = GROUPS.filter((g) => !taken.has(g.id));
            const unassigned = this.players.filter((p) => ![...this.groupOf.values()].length || !this.groupOf.has(p.cid));
            let i = 0;
            for (const p of unassigned) {
                const g = free[(i + this.offset) % free.length];
                if (!g) break;
                this.groupOf.set(p.cid, g.id);
                i++;
            }
            return;
        }
        this.groupOf.clear();
        const ready = this.players.filter((p) => p.ready !== false);
        const pool = ready.length ? ready : this.players;
        pool.forEach((p, i) => this.groupOf.set(p.cid, GROUPS[(i + this.offset) % GROUPS.length].id));
    }

    groupsFor(cid) {
        const gid = this.groupOf.get(cid);
        const g = GROUPS.find((x) => x.id === gid);
        return g ? g.bits : 0xffffffff;
    }

    /**
     * Decide the mask to inject for this frame.
     * @param {number} now      ms clock
     * @param {number} selfBits the host's own local controller mask
     */
    step(now, selfBits = 0) {
        if (this.selfCid) this.inputs.set(this.selfCid, selfBits);
        const m = modeById(this.mode);
        const voters = this.players.filter((p) => p.ready !== false);
        const list = voters.map((p) => this.inputs.get(p.cid) | 0);
        if (selfBits && !voters.some((p) => p.cid === this.selfCid)) list.push(selfBits);

        switch (m.id) {
            case 'solo':
                this.note = 'host only';
                return selfBits | 0;

            case 'mash': {
                const b = union(list);
                this.note = `${new Set(list.filter((x) => x)).size} pushing`;
                return b;
            }

            case 'coop': {
                let out = 0;
                const owners = new Map();
                for (const [cid, gid] of this.groupOf) {
                    const g = GROUPS.find((x) => x.id === gid);
                    if (!g) continue;
                    const b = (this.inputs.get(cid) | 0) & g.bits;
                    if (b) { out |= b; owners.set(g.id, cid); }
                }
                const n = owners.size;
                this.note = n ? `${n}/${GROUPS.length} groups active` : 'nobody is pressing anything';
                return out;
            }

            case 'democracy':
            case 'anarchy': {
                const win = m.id === 'democracy' ? (this.opts.window || 400) : (this.opts.window || 350);
                if (now - this.window >= win) {
                    this.window = now;
                    if (m.id === 'democracy') {
                        this.held = majority(list, Math.max(voters.length, 1));
                        const yes = list.filter((x) => x).length;
                        this.note = `${yes}/${voters.length || 1} agree`;
                    } else {
                        const pick = list[Math.floor(Math.random() * list.length)] | 0;
                        this.held = pick;
                        this.note = pick ? 'random pad grab' : 'quiet';
                    }
                    // START/B are edge-triggered inside the engine: we inject one
                    // keydown when the bit rises and one keyup when it falls, so a
                    // held window never turns into menu-spam.
                }
                return this.held;
            }

            case 'potato': {
                const hold = (this.opts.hold || 25) * 1000;
                this._trackHeckle(now, voters, selfBits);
                const stormed = now < this.padLockUntil ? null : this._stormer(voters);
                if (!this.padHolder || stormed || (this.padUntil && now > this.padUntil)) {
                    this.padHolder = stormed || this._nextHolder(voters) || this.selfCid;
                    this.padUntil = now + hold;
                    this.note = stormed ? 'pad stormed!' : 'pad handed over';
                    if (stormed) {
                        this.storms++;
                        // Give the new holder a breather, or a determined crowd
                        // re-steals it on the very next window and nobody plays.
                        this.heckle.clear();
                        this.padLockUntil = now + Math.min(6000, hold / 2);
                    }
                }
                const bits = this.padHolder === this.selfCid
                    ? selfBits | 0
                    : (this.inputs.get(this.padHolder) | 0);
                const who = this.players.find((p) => p.cid === this.padHolder)?.name || 'host';
                const secs = Math.max(0, Math.ceil((this.padUntil - now) / 1000));
                this.note = `🥔 ${who} · ${secs}s`;
                return bits;
            }

            default:
                return selfBits | 0;
        }
    }

    /**
     * Pressure is time-based, never frame-based: 0 → 1000 over ~1.2 s of mashing
     * A, decaying over ~1.5 s of quitting. Otherwise a 144 Hz host would be a
     * different game from a throttled background tab.
     */
    _trackHeckle(now, voters, selfBits) {
        const dt = clamp(now - (this._heckleAt || now), 0, 250);
        this._heckleAt = now;
        for (const p of voters) {
            if (p.cid === this.padHolder) continue;
            const bits = (p.cid === this.selfCid ? selfBits : this.inputs.get(p.cid) | 0);
            const prev = this.heckle.get(p.cid) || 0;
            const next = bits & BTN.A ? prev + dt * (1000 / 1200) : prev - dt * (1000 / 1500);
            this.heckle.set(p.cid, clamp(next, 0, 1000));
        }
    }

    /** Enough hecklers, mashing together, deserve the pad. */
    _stormer(voters) {
        const others = voters.filter((p) => p.cid !== this.padHolder);
        if (others.length < 2) return null;
        // Fraction of the crowd, floored at two mashing players (so one determined
        // griefer can't flip the session) and capped at the crowd size (so a
        // nonsensical option can never make the pad un-stealable).
        const need = Math.min(others.length,
            Math.max(2, Math.ceil(others.length * (this.opts.storm || 0.5))));
        const storming = others.filter((p) => (this.heckle.get(p.cid) || 0) > 620);
        if (storming.length < need) return null;
        storming.sort((a, b) => (this.heckle.get(b.cid) || 0) - (this.heckle.get(a.cid) || 0));
        return storming[0].cid;
    }

    _nextHolder(voters) {
        if (!voters.length) return this.selfCid;
        const idx = (voters.findIndex((p) => p.cid === this.padHolder) + 1) % voters.length;
        return (voters[idx] || voters[0]).cid;
    }

    /** UI summary: what does the local player control right now? */
    localRole(cid) {
        const m = modeById(this.mode);
        if (m.id === 'coop') {
            const gid = this.groupOf.get(cid);
            return GROUPS.find((g) => g.id === gid) || null;
        }
        if (m.id === 'potato') return this.padHolder === cid ? GROUPS[0] && { id: 'pad', label: 'Pad', icon: '🥔', bits: 0xffff, hint: 'everything' } : { id: 'heckle', label: 'Heckle', icon: '👺', bits: BTN.A, hint: 'mash A to storm the pad' };
        if (m.id === 'solo') return cid === this.selfCid ? { id: 'pad', label: 'Pad', icon: '👑', bits: 0xffff, hint: 'everything' } : { id: 'watch', label: 'Watch', icon: '👀', bits: 0, hint: 'chat + votes' };
        return { id: 'all', label: m.label, icon: m.icon, bits: 0xffff, hint: m.desc };
    }
}

/**
 * Which bits a given player is *allowed* to contribute right now. Used twice:
 * locally (so a jump-only player's arrows do nothing) and by the host (truth).
 */
export function allowedMask(modeId, role) {
    if (!role) return 0xffff;
    if (modeId === 'coop') {
        const g = GROUPS.find((x) => x.id === role.id);
        return g ? g.bits : 0;
    }
    if (modeId === 'potato') return role.id === 'pad' ? 0xffff : BTN.A;
    if (modeId === 'solo') return role.id === 'pad' ? 0xffff : 0;
    return 0xffff;
}

export { GROUPS, STICK_BITS, BTN };
