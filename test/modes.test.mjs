// Unit tests for the arbitration layer — the part of "multiplayer" that is a
// decision, not a network. Node-only: modes.js / protocol.js touch no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Arbitrator, allowedMask } from '../src/modes.js';
import { BTN, GROUPS, majority, union, sanitizeName, modeById, encodeFrame, decodeFrame } from '../src/protocol.js';

const P = (cid, ready = true) => ({ cid, name: cid, ready });

test('majority: strict half cancels, majority wins', () => {
    // Two opposing directions with equal support ⇒ nobody moves.
    assert.equal(majority([BTN.UP, BTN.DOWN], 2), 0);
    assert.equal(majority([BTN.UP, BTN.UP, BTN.DOWN], 3), BTN.UP);
    // A needs > half too, so a lone jump does nothing in a 4-player room.
    assert.equal(majority([BTN.A, 0, 0, 0], 4), 0);
    assert.equal(majority([BTN.A, BTN.A, BTN.A, 0], 4), BTN.A);
});

test('union keeps every push, which is what MASH is for', () => {
    assert.equal(union([BTN.UP, BTN.LEFT | BTN.A, BTN.B]), BTN.UP | BTN.LEFT | BTN.A | BTN.B);
});

test('sanitizeName strips control + zero-width junk and caps length', () => {
    assert.equal(sanitizeName(' ma\u200bri\u0007o '), 'mario');
    assert.equal(sanitizeName('x'.repeat(99)).length, 24);
    assert.equal(sanitizeName('   ', 'Player'), 'Player');
    assert.equal(sanitizeName('<img src=x onerror=alert(1)>').length <= 24, true);
});

test('the video header round-trips and rejects foreign bytes', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const buf = encodeFrame(7, 12345, jpeg);
    const back = decodeFrame(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    assert.deepEqual([back.index, back.ts], [7, 12345]);
    assert.deepEqual([...back.jpeg], [...jpeg]);
    assert.equal(decodeFrame(new Uint8Array([1, 2, 3]).buffer), null, 'short garbage is dropped');
    const bad = encodeFrame(1, 1, jpeg);
    new DataView(bad.buffer).setUint32(0, 0xdeadbeef);
    assert.equal(decodeFrame(bad.buffer), null, 'wrong magic is dropped');
});

test('MASH: every ready player contributes, one mask goes to the engine', () => {
    const arb = new Arbitrator({ mode: 'mash', selfCid: 'a' });
    arb.setPlayers([P('a'), P('b'), P('c')]);
    arb.setInput('b', BTN.UP);
    arb.setInput('c', BTN.A);
    assert.equal(arb.step(1000, BTN.LEFT), BTN.UP | BTN.A | BTN.LEFT);
    // a player who leaves stops contributing
    arb.setPlayers([P('a'), P('c')]);
    assert.equal(arb.step(1100, 0), BTN.A);
});

test('SOLO: only the host moves Mario', () => {
    const arb = new Arbitrator({ mode: 'solo', selfCid: 'a' });
    arb.setPlayers([P('a'), P('b')]);
    arb.setInput('b', BTN.UP | BTN.A);
    assert.equal(arb.step(0, BTN.LEFT), BTN.LEFT);
});

test('CO-OP: each player only controls their slice of the pad', () => {
    const arb = new Arbitrator({ mode: 'coop', opts: { rotate: 0 }, selfCid: 'a' });
    arb.setPlayers([P('a'), P('b'), P('c'), P('d')]);
    // join order assigns a→stick, b→jump, c→tech, d→menu
    assert.deepEqual([...arb.groupOf.values()], ['stick', 'jump', 'tech', 'menu']);

    // 'a' is the host: its own keys arrive as selfBits, not over the wire.
    arb.setInput('b', BTN.UP | BTN.A);          // jump player may not steer
    arb.setInput('c', BTN.Z | BTN.START);       // tech group = B+Z, so Z only
    arb.setInput('d', BTN.START | BTN.UP);      // menu group = START only
    assert.equal(arb.step(0, BTN.UP | BTN.A), BTN.UP | BTN.A | BTN.Z | BTN.START);

    // allowedMask must agree with what the host will honour, so the client can
    // show (and pre-filter) exactly its own slice.
    assert.equal(allowedMask('coop', arb.localRole('b')), BTN.A);
    assert.equal(allowedMask('coop', arb.localRole('a')), BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT);

    // rotating shifts every group by one, so 'a' loses the stick and gains A
    arb.rotate();
    assert.equal(arb.groupOf.get('a'), 'jump');
    arb.setInput('b', 0); arb.setInput('c', 0); arb.setInput('d', 0);
    assert.equal(arb.step(0, BTN.A | BTN.UP), BTN.A, 'steering is no longer a’s job');
});

test('DEMOCRACY: the window decides, then holds until it expires', () => {
    const arb = new Arbitrator({ mode: 'democracy', opts: { window: 400 }, selfCid: 'a' });
    arb.setPlayers([P('a'), P('b'), P('c')]);
    arb.setInput('b', BTN.UP);
    arb.setInput('c', BTN.UP);
    assert.equal(arb.step(0, 0), BTN.UP, '2 of 3 agree → Mario walks');
    arb.setInput('b', BTN.DOWN);
    arb.setInput('c', BTN.DOWN);
    assert.equal(arb.step(200, BTN.DOWN), BTN.UP, 'inside the window the decision is frozen');
    assert.equal(arb.step(500, BTN.DOWN), BTN.DOWN, 'next window re-tallies');
});

test('ANARCHY: each window is exactly one player’s whole pad', () => {
    const arb = new Arbitrator({ mode: 'anarchy', opts: { window: 100 }, selfCid: 'a' });
    const votes = [BTN.UP, BTN.A | BTN.UP, BTN.B];
    arb.setPlayers(['a', 'b', 'c'].map((cid, i) => { arb.setInput(cid, votes[i]); return P(cid); }));
    const seen = new Set();
    for (let t = 0; t < 4000; t += 100) seen.add(arb.step(t, votes[0]));
    assert.ok(seen.size >= 1);
    for (const mask of seen) assert.ok(votes.includes(mask), 'output is always somebody’s real input');
});

test('HOT POTATO: one holder, timed rotation, and a heckle storm can steal it', () => {
    const arb = new Arbitrator({ mode: 'potato', opts: { hold: 25, storm: 0.5 }, selfCid: 'a' });
    arb.setPlayers([P('a'), P('b'), P('c')]);
    arb.setInput('b', BTN.UP);
    assert.equal(arb.step(0, BTN.LEFT), BTN.LEFT, 'only the holder moves…');
    assert.equal(arb.padHolder, 'a');
    assert.equal(arb.step(26000, BTN.LEFT), BTN.UP, '…and the pad rotates on a timer');
    assert.equal(arb.padHolder, 'b');

    // Both hecklers mash A together ⇒ the pad is stormed within a second.
    // 'a' is the host and 'c' the other heckler; both mash A for ~0.9 s.
    for (let t = 27000; t < 27900; t += 100) {
        arb.setInput('c', BTN.A);
        arb.step(t, BTN.A);
    }
    assert.equal(arb.padHolder, 'a', 'the crowd stormed the pad off the holder');
    assert.equal(arb.storms, 1, 'exactly one steal, no ping-pong');
    // and the lock means a lone heckler cannot win it back instantly
    for (let t = 28000; t < 32000; t += 100) {
        arb.setInput('c', BTN.A);
        arb.step(t, 0);
    }
    assert.equal(arb.padHolder, 'a', 'storm lock holds for a few seconds');
});

test('mode metadata stays consistent with the arbitrator', () => {
    for (const m of ['coop', 'democracy', 'anarchy', 'potato', 'mash', 'solo']) {
        assert.ok(modeById(m), `${m} exists`);
        assert.equal(modeById('nope').id, 'coop', 'unknown modes fall back, never crash');
        const arb = new Arbitrator({ mode: m, selfCid: 'a' });
        arb.setPlayers([P('a'), P('b')]);
        const mask = arb.step(0, BTN.A);
        assert.equal(Number.isInteger(mask) && mask >= 0 && mask <= 0xffff, true, `${m} returns a controller mask`);
    }
});
